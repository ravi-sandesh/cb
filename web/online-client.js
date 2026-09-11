// ============================================================
// CHOKA BARAH – Online client (auth + lobby + WebSocket transport)
// ------------------------------------------------------------
// Browser-side companion to web/online/online-server.js. Handles:
//   - register / login / logout via fetch (credentials: scrypt server-side)
//   - room create / join (room code) via the HTTP API
//   - a WebSocket connection authenticated by a first-message token exchange
//   - the ROLL / MOVE protocol with the server-authoritative relay
// Server state is applied through DELEGATES (window.* hooks set by app.js),
// so this module stays transport-only and is unit-testable with fake
// fetch + WebSocket. Nothing here mutates game state itself.
// ============================================================
(function () {
'use strict';

// Node-safe root (jest drives this module via globalThis, not `window`).
const root = (typeof window !== 'undefined') ? window : globalThis;

// Redirectable transport seams (tests swap these before loading).
const api = root.fetch || globalThis.fetch;
const WS = root.WebSocket || globalThis.WebSocket;

const USERNAME_KEY = 'cb_online_user';
const code = (name) => (typeof document !== 'undefined' && document.getElementById(name));

// Empty where the host static server is not the online server (dev/tests).
function wsRoot() {
  const loc = root.location || {};
  const proto = (root.location && root.location.protocol === 'https:') ? 'wss' : 'ws';
  return `${proto}://${loc.host || 'localhost:' + (loc.port || 3111)}`;
}

// ---- Local session persistence ----
// The session token itself lives ONLY in an HttpOnly cookie set by the
// server — JavaScript can neither read nor exfiltrate it. We persist just
// the display name for the UI.
function saveUsername(username) {
  try {
    if (typeof localStorage !== 'undefined') {
      if (username) localStorage.setItem(USERNAME_KEY, username);
      else localStorage.removeItem(USERNAME_KEY);
    }
  } catch (e) { /* storage unavailable (SSR/private mode) */ }
}
function loadUsername() {
  try {
    if (typeof localStorage !== 'undefined') return localStorage.getItem(USERNAME_KEY);
  } catch (e) { /* ignore */ }
  return null;
}

const state = {
  authed: false,
  username: null,
  ws: null,
  connected: false,
  code: null,          // room code once created/joined
  gridSize: null,
  playerIndex: null,   // seat (0 host / 1 guest), set by 'joined'
  lastError: null,
  reconnectTimer: null,
  reconnectAttempts: 0,
  giveUpReconnect: false
};

let statusFn = null;         // (text, isError) -> void
let joinedFn = null;         // ({playerIndex, gridSize, code}) -> void
let boardFn = null;          // (board) -> void
let errorFn = null;          // (code) -> void
let peerCountFn = null;      // ({count, playerNum}) -> void
let peerLeftFn = null;       // () -> void
let gameOverFn = null;       // ({winner, winnerUser}) -> void
let closedFn = null;         // (reason) -> void

function fireStatus(msg, isError) {
  if (statusFn) statusFn(msg, !!isError);
}

async function http(method, pathname, body) {
  const res = await api(pathname, {
    method,
    credentials: 'same-origin', // HttpOnly session cookie rides along
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : {}; } catch (e) { parsed = { raw: text }; }
  return { status: res.status, body: parsed };
}

// ============================================================
// AUTH
// ============================================================
async function register(username, password) {
  const r = await http('POST', '/api/register', { username, password });
  if (r.status === 201 && r.body.user) {
    state.authed = true;
    state.username = r.body.user.username;
    saveUsername(state.username);
    fireStatus(`Registered and signed in as ${state.username}.`);
    return state;
  }
  const err = r.body.error || 'register-failed';
  fireStatus(`Registration failed: ${err}.`, true);
  return null;
}

async function login(username, password) {
  const r = await http('POST', '/api/login', { username, password });
  if (r.status === 200 && r.body.user) {
    state.authed = true;
    state.username = r.body.user.username;
    saveUsername(state.username);
    fireStatus(`Signed in as ${state.username}.`);
    return state;
  }
  fireStatus('Login failed: check username and password.', true);
  return null;
}

async function logout() {
  try { await http('POST', '/api/logout'); } catch (e) { /* best effort */ }
  state.authed = false;
  state.username = null;
  saveUsername(null);
  disconnect('logged-out');
  fireStatus('Signed out.');
}

// ============================================================
// ROOM LOBBY (HTTP)
// ============================================================
async function createRoom(gridSize) {
  if (!state.authed) { fireStatus('Sign in first.', true); return null; }
  const r = await http('POST', '/api/match/create', { gridSize: (gridSize === 7 ? 7 : 5) });
  if (r.status === 201 && r.body.code) {
    const roomCode = r.body.code;
    state.code = roomCode;
    state.gridSize = r.body.gridSize;
    fireStatus(`Room created — share code ${roomCode}.`);
    connect(r.body.wsPath, roomCode);
    return roomCode;
  }
  fireStatus(`Room creation failed: ${r.body.error || 'unknown'}.`, true);
  return null;
}

async function joinRoom(roomCode) {
  if (!state.authed) { fireStatus('Sign in first.', true); return null; }
  const c = String(roomCode || '').trim().toUpperCase();
  if (!c) { fireStatus('Enter a room code to join.', true); return null; }
  const r = await http('POST', '/api/match/join', { code: c });
  if (r.status === 200 && r.body.wsPath) {
    const joined = r.body.code;
    state.code = joined;
    state.gridSize = r.body.gridSize;
    fireStatus(`Joining room ${joined}…`);
    connect(r.body.wsPath, joined);
    return joined;
  }
  fireStatus(`Join failed: ${r.body.error || 'no such room'}.`, true);
  return null;
}

// ============================================================
// WEBSOCKET (with automatic reconnect + resume)
// ============================================================
const RECONNECT_MAX_ATTEMPTS = 6;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 10000;

function connect(wsPath, roomCode) {
  // Reject bad server paths before dialling (a 201 without wsPath used to
  // open ws://host/undefined and loop generic connection errors).
  if (typeof wsPath !== 'string' || !wsPath.startsWith('/')) {
    fireStatus('Cannot reach the match server (bad address).', true);
    return;
  }
  // Preserve the reconnect bookkeeping across the internal disconnect().
  const pendingAttempts = state.reconnectAttempts || 0;
  const givingUp = state.giveUpReconnect || false;
  stopReconnecting();
  disconnect('reconnect');
  // disconnect() clears state.code internally; restore the room we're joining.
  if (roomCode) state.code = roomCode;
  state.wsPath = wsPath; // reconnects reuse the CURRENT path, not a stale closure
  state.reconnectAttempts = pendingAttempts;
  state.giveUpReconnect = givingUp;
  try {
    const ws = new WS(wsRoot() + wsPath);
    state.ws = ws;
    ws.onopen = () => {
      state.connected = true;
      state.reconnectAttempts = 0;
      // A successful connection clears any previous give-up suppression —
      // otherwise one bad patch permanently killed reconnection even for
      // future rooms the user joined afterwards.
      state.giveUpReconnect = false;
      // The HttpOnly session cookie attaches to this same-origin upgrade
      // automatically — the relay treats us as authenticated at handshake,
      // so the room join can go out immediately (once per socket: the
      // 'authed' handler below skips if this already sent).
      if (roomCode) {
        try { ws.send(JSON.stringify({ type: 'join', code: roomCode })); ws._joinSent = roomCode; } catch (e) { /* ignore */ }
      }
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      dispatch(msg);
    };
    ws.onerror = () => fireStatus('Connection error.', true);
    ws.onclose = (ev) => {
      state.connected = false;
      if (ev.code === 1008) {
        // Server refused our credentials — the session cookie is dead.
        saveUsername(null);
        state.authed = false;
        fireStatus('Session expired. Please log in again.', true);
      } else if (ev.code === 1000 || ev.code === 4301) {
        // Clean close: user-initiated leave or server-directed logout.
        if (closedFn) closedFn(ev.code || 0);
        fireStatus(ev.code === 4301 ? 'Disconnected.' : 'Disconnected from server.', true);
      } else if (state.authed && state.code && !state.giveUpReconnect) {
        // Abnormal drop mid-match: schedule an automatic reconnect that
        // re-authenticates and re-joins, resuming the seat via the relay's
        // grace window.
        const attempt = (state.reconnectAttempts || 0) + 1;
        state.reconnectAttempts = attempt;
        if (attempt > RECONNECT_MAX_ATTEMPTS) {
          state.giveUpReconnect = true;
          fireStatus('Could not reconnect. Please sign in and rejoin the room.', true);
          if (closedFn) closedFn(ev.code || 0);
          return;
        }
        const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, attempt - 1), RECONNECT_MAX_MS);
        fireStatus(`Connection lost — reconnecting (${attempt}/${RECONNECT_MAX_ATTEMPTS})…`, true);
        state.reconnectTimer = setTimeout(() => {
          state.reconnectTimer = null;
          connect(state.wsPath, state.code);
        }, delay);
        if (typeof state.reconnectTimer.unref === 'function') state.reconnectTimer.unref();
      } else {
        if (closedFn) closedFn(ev.code || 0);
        fireStatus(ev.code === 4301 ? 'Disconnected.' : 'Disconnected from server.', true);
      }
    };
  } catch (e) {
    fireStatus('WebSocket unavailable in this browser/dev context.', true);
  }
}

function stopReconnecting() {
  if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
  state.giveUpReconnect = false;
  state.reconnectAttempts = 0;
}

function dispatch(msg) {
  switch (msg.type) {
    case 'authed':
      // Authenticated; attach to the pending room, if any — unless this
      // socket already joined on open (sending twice used to surface a
      // spurious already-in-room error on every clean connect).
      if (state.code && state.ws && state.ws.readyState === 1 && state.ws._joinSent !== state.code) {
        try { state.ws.send(JSON.stringify({ type: 'join', code: state.code })); state.ws._joinSent = state.code; } catch (e) { /* ignore */ }
      }
      break;
    case 'joined':
      state.playerIndex = msg.playerIndex;
      state.gridSize = msg.gridSize;
      if (joinedFn) joinedFn({ playerIndex: msg.playerIndex, gridSize: msg.gridSize, code: state.code });
      break;
    case 'board':
      if (boardFn) boardFn(msg.board);
      break;
    case 'member-count':
      if (peerCountFn) peerCountFn({ count: msg.count, playerNum: msg.playerNum });
      break;
    case 'peer-left':
      if (peerLeftFn) peerLeftFn();
      break;
    case 'game-over':
      if (gameOverFn) gameOverFn({ winner: msg.winner, winnerUser: msg.winnersUser });
      break;
    case 'error':
      state.lastError = msg.code;
      if (errorFn) errorFn(msg.code);
      break;
    default:
      // protocol extensions are ignored
      break;
  }
}

// To join a created room the client must attach over the socket ('join').
function join(roomCode) {
  if (state.connected && state.ws.readyState === 1) {
    state.ws.send(JSON.stringify({ type: 'join', code: roomCode || state.code }));
  }
}

function roll() {
  if (state.connected && state.ws && state.ws.readyState === 1) {
    state.ws.send(JSON.stringify({ type: 'roll' }));
  }
}

function move(move) {
  if (state.connected && state.ws && state.ws.readyState === 1) {
    state.ws.send(JSON.stringify({ type: 'move', move: {
      pawnIds: (move.grpPawns || move.pawnIds || []).map(p => (typeof p === 'object' ? p.id : p)),
      targetCoords: move.targetCoords
    } }));
  }
}

function leave() {
  if (state.connected && state.ws && state.ws.readyState === 1) {
    state.ws.send(JSON.stringify({ type: 'leave' }));
  }
  disconnect('leave');
}

function disconnect(reason) {
  stopReconnecting(); // an intentional disconnect never auto-reconnects
  if (state.ws) {
    try { state.ws.onclose = null; state.ws.close(4000, reason || 'bye'); } catch (e) { /* ignore */ }
    state.ws = null;
  }
  state.connected = false;
  state.code = null;
  state.playerIndex = null;
}

// ============================================================
// PUBLIC API (also consumed by app.js via window.OnlineClient)
// ============================================================
root.OnlineClient = {
  register, login, logout,
  createRoom, joinRoom,
  connect, join, roll, move, leave, disconnect,
  get authed() { return state.authed; },
  get username() { return state.username; },
  get code() { return state.code; },
  get gridSize() { return state.gridSize; },
  get playerIndex() { return state.playerIndex; },
  get connected() { return state.connected; },
  get lastError() { return state.lastError; },
  // app.js hooks
  onStatus(fn) { statusFn = fn; },
  onJoined(fn) { joinedFn = fn; },
  onBoard(fn) { boardFn = fn; },
  onError(fn) { errorFn = fn; },
  onPeerCount(fn) { peerCountFn = fn; },
  onPeerLeft(fn) { peerLeftFn = fn; },
  onGameOver(fn) { gameOverFn = fn; },
  onClosed(fn) { closedFn = fn; },

  // Ask the server who we are (cookie-authenticated). Resolves to the
  // username or null; updates internal auth state either way.
  async whoami() {
    const r = await http('GET', '/api/me').catch(() => null);
    if (r && r.status === 200 && r.body.user) {
      state.authed = true;
      state.username = r.body.user.username;
      saveUsername(state.username);
      return state.username;
    }
    state.authed = false;
    return null;
  }
};

// Restore the persisted display name; real auth lives in the HttpOnly
// cookie and is re-verified through whoami() by the app on boot.
state.username = loadUsername();

})();