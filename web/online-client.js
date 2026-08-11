// ============================================================
// CHOKA BARAH – Online client (auth + lobby + WebSocket transport)
// ------------------------------------------------------------
// Browser-side companion to web/online/online-server.js. Handles:
//   - register / login / logout via fetch (credentials: scrypt server-side)
//   - room create / join (room code) via the HTTP API
//   - a WebSocket connection authenticated by the session token at upgrade
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

const TOKEN_KEY = 'cb_online_token';
const USERNAME_KEY = 'cb_online_user';
const code = (name) => (typeof document !== 'undefined' && document.getElementById(name));

// Empty where the host static server is not the online server (dev/tests).
function wsRoot() {
  const loc = root.location || {};
  const proto = (root.location && root.location.protocol === 'https:') ? 'wss' : 'ws';
  return `${proto}://${loc.host || 'localhost:' + (loc.port || 3111)}`;
}

// ---- Local session persistence ----
function saveToken(token, username) {
  try {
    if (typeof localStorage !== 'undefined') {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      else localStorage.removeItem(TOKEN_KEY);
      if (username) localStorage.setItem(USERNAME_KEY, username);
      else localStorage.removeItem(USERNAME_KEY);
    }
  } catch (e) { /* storage unavailable (SSR/private mode) */ }
}
function loadToken() {
  try {
    if (typeof localStorage !== 'undefined') return localStorage.getItem(TOKEN_KEY);
  } catch (e) { /* ignore */ }
  return null;
}

const state = {
  token: null,
  username: null,
  ws: null,
  connected: false,
  code: null,          // room code once created/joined
  gridSize: null,
  playerIndex: null,   // seat (0 host / 1 guest), set by 'joined'
  lastError: null
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

async function http(method, pathname, body, token) {
  const res = await api(pathname, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
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
  if (r.status === 201 && r.body.token) {
    state.token = r.body.token;
    state.username = r.body.user.username;
    saveToken(state.token, state.username);
    fireStatus(`Registered and signed in as ${state.username}.`);
    return state;
  }
  const err = r.body.error || 'register-failed';
  fireStatus(`Registration failed: ${err}.`, true);
  return null;
}

async function login(username, password) {
  const r = await http('POST', '/api/login', { username, password });
  if (r.status === 200 && r.body.token) {
    state.token = r.body.token;
    state.username = r.body.user.username;
    saveToken(state.token, state.username);
    fireStatus(`Signed in as ${state.username}.`);
    return state;
  }
  fireStatus('Login failed: check username and password.', true);
  return null;
}

async function logout() {
  if (state.token) {
    try { await http('POST', '/api/logout', undefined, state.token); } catch (e) { /* best effort */ }
  }
  state.token = null;
  state.username = null;
  saveToken(null, null);
  disconnect('logged-out');
  fireStatus('Signed out.');
}

// ============================================================
// ROOM LOBBY (HTTP)
// ============================================================
async function createRoom(gridSize) {
  if (!state.token) { fireStatus('Sign in first.', true); return null; }
  const r = await http('POST', '/api/match/create', { gridSize: (gridSize === 7 ? 7 : 5) }, state.token);
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
  if (!state.token) { fireStatus('Sign in first.', true); return null; }
  const c = String(roomCode || '').trim().toUpperCase();
  if (!c) { fireStatus('Enter a room code to join.', true); return null; }
  const r = await http('POST', '/api/match/join', { code: c }, state.token);
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
// WEBSOCKET
// ============================================================
function connect(wsPath, roomCode) {
  disconnect('reconnect');
  // disconnect() clears state.code internally; restore the room we're joining.
  if (roomCode) state.code = roomCode;
  try {
    const ws = new WS(wsRoot() + wsPath);
    state.ws = ws;
    ws.onopen = () => {
      state.connected = true;
      // Once attached to the room over the socket, the relay seats us
      // (player 0 host / player 1 guest) and broadcasts the board.
      if (roomCode) {
        try { ws.send(JSON.stringify({ type: 'join', code: roomCode })); } catch (e) { /* ignore */ }
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
      if (closedFn) closedFn(ev.code || 0);
      fireStatus(ev.code === 4301 ? 'Disconnected.' : 'Disconnected from server.', true);
    };
  } catch (e) {
    fireStatus('WebSocket unavailable in this browser/dev context.', true);
  }
}

function dispatch(msg) {
  switch (msg.type) {
    case 'authed': break; // identity known at the socket layer
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
  get token() { return state.token; },
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
  onClosed(fn) { closedFn = fn; }
};

// Restore a persisted session so a refresh keeps you signed in.
state.token = loadToken();
try {
  state.username = (typeof localStorage !== 'undefined') ? localStorage.getItem(USERNAME_KEY) : null;
} catch (e) { /* ignore */ }

})();