// ============================================================
// CHOKA BARAH – app.js ONLINE MODE integration tests
// Boots app.js against fake browser globals PLUS a stub
// window.OnlineClient (the module the bundle loads BEFORE app.js).
// The stub captures the delegate registrations so tests can push
// server events (joined / board / member-count / peer-left) exactly
// as online-client.js would, and verify the UI stays authoritative.
// ============================================================
'use strict';

const holder = { docEls: {}, _eltSeq: 0 };

function makeCanvas(width) {
  width = width || 600;
  const calls = [];
  const c = {
    width, height: width,
    _listeners: {},
    _calls: calls,
    focus() {}
  };
  c.getContext = () => {
    return new Proxy({}, {
      get(t, prop) {
        if (prop in t) return t[prop];
        return (...args) => { calls.push([prop, ...args]); };
      },
      set(t, prop, v) { t[prop] = v; return true; }
    });
  };
  c.getBoundingClientRect = () => ({ left: 0, top: 0, width: c.width, height: c.height });
  c.addEventListener = (type, fn) => { c._listeners[type] = fn; };
  c.fireClick = (x, y) => { const fn = c._listeners.click; if (fn) fn({ clientX: x, clientY: y }); };
  return c;
}

function makeElement(id) {
  const el = {
    id,
    _innerText: '',
    _innerHTML: '',
    className: '',
    style: {},
    disabled: false,
    value: '',
    children: [],
    classList: { _set: {}, add(c){ this._set[c]=true; }, remove(c){ delete this._set[c]; }, toggle(c, on){ this._set[c] = on === undefined ? !this._set[c] : !!on; }, contains(c){ return !!this._set[c]; } },
    addEventListener() {},
    appendChild(c) { el.children.push(c); },
    setAttribute() {},
    removeAttribute() {}
  };
  Object.defineProperty(el, 'innerText', {
    get() { return el._innerText; },
    set(v) { el._innerText = String(v); }
  });
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._innerHTML; },
    set(v) { el._innerHTML = String(v); el.children.length = 0; }
  });
  return el;
}

// Deterministic stub of window.OnlineClient (online-client.js).
function makeFakeOnline() {
  const hooks = {};
  return {
    __hooks: hooks,
    token: null,
    username: null,
    code: null,
    gridSize: null,
    playerIndex: null,
    connected: false,
    _calls: { roll: 0, move: [], create: 0, joinRoom: 0, leave: 0, login: 0, logout: 0, register: 0 },
    onStatus(fn) { hooks.onStatus = fn; },
    onJoined(fn) { hooks.onJoined = fn; },
    onBoard(fn) { hooks.onBoard = fn; },
    onError(fn) { hooks.onError = fn; },
    onPeerCount(fn) { hooks.onPeerCount = fn; },
    onPeerLeft(fn) { hooks.onPeerLeft = fn; },
    onGameOver(fn) { hooks.onGameOver = fn; },
    onClosed(fn) { hooks.onClosed = fn; },
    _reset() {
      this.token = null;
      this.username = null;
      this.code = null;
      this.gridSize = null;
      this.playerIndex = null;
      this.connected = false;
      this._calls = { roll: 0, move: [], create: 0, joinRoom: 0, leave: 0, login: 0, logout: 0, register: 0 };
    },
    async login(u) { this.token = 'T'; this.username = u; this._calls.login++; return this; },
    async register(u) { this.token = 'T'; this.username = u; this._calls.register++; return this; },
    async logout() { this.token = null; this._calls.logout++; },
    async createRoom(gs) { this.code = 'ABCDEF'; this.gridSize = gs; this._calls.create++; return 'ABCDEF'; },
    async joinRoom(c) { this.code = 'ABCDEF'; this.gridSize = 5; this._calls.joinRoom++; return 'ABCDEF'; },
    async roll() { this._calls.roll++; },
    move(m) { this._calls.move.push(m); },
    leave() { this._calls.leave++; }
  };
}

let windowImpl;
let booted = null;

function boot() {
  if (booted) return booted;
  const w = { OnlineClient: makeFakeOnline() };
  const document = {
    body: makeElement('body'),
    activeElement: null,
    _listeners: {},
    addEventListener(type, fn) { document._listeners[type] = fn; },
    getElementById: (id) => holder.docEls[id] || (holder.docEls[id] = makeElement(id)),
    createElement: (tag) => makeElement(`${tag}_${holder._eltSeq++}`)
  };
  w.window = w;
  w.document = document;
  w.Telemetry = {
    info() {}, debug() {}, warn() {}, error() {}, trace() {},
    startSpan() { return 'span'; },
    endSpan() {},
    getSessionId() { return 'test-session'; }
  };
  windowImpl = w;
  globalThis.window = w;
  globalThis.document = document;
  globalThis.T = w.Telemetry;

  w.ChokaBarahEngine = require('./game-engine.js');
  const sound = require('./sound.js');
  w.Sound = sound.createSoundController({ play: () => true });

  require('./app.js');

  booted = { w, document, canvas: holder.docEls['board-canvas'], oc: w.OnlineClient };
  return booted;
}

function fresh() {
  const canvas = booted ? booted.canvas : makeCanvas(600);
  const ids = [
    'board-canvas', 'btn-mode-pnp', 'btn-mode-bot', 'btn-mode-online',
    'online-card', 'online-auth', 'online-authed', 'online-guest',
    'online-status', 'online-waiting', 'online-room-code-display',
    'online-username', 'online-password', 'online-room-code',
    'game-screen', 'home-screen', 'btn-roll', 'roll-score-display',
    'cowry-shells', 'pawn-select-bar', 'pawn-buttons-container',
    'game-log', 'board-title'
  ];
  const map = {};
  ids.forEach(id => { map[id] = id === 'board-canvas' ? canvas : makeElement(id); });
  holder.docEls = map;
  const { w, document, oc } = boot();
  // Cached-boot reset: unwind any lingering online/game state (gameActive,
  // onlineSeat) from the previous test without reloading the module.
  if (booted) {
    w.showHomeScreen();
    w.onlineLogout();
  }
  oc._reset();
  return { w, document, canvas, oc };
}

function boardFrom(gridSize, currentPlayerIndex, extras) {
  return Object.assign({
    gridSize: gridSize || 5,
    playerNum: 2,
    pawns: [
      { id: 0, playerIndex: 0, state: 'HOME_BASE', pathIndex: -1 },
      { id: 1, playerIndex: 0, state: 'HOME_BASE', pathIndex: -1 },
      { id: 2, playerIndex: 0, state: 'HOME_BASE', pathIndex: -1 },
      { id: 3, playerIndex: 0, state: 'HOME_BASE', pathIndex: -1 },
      { id: 4, playerIndex: 1, state: 'HOME_BASE', pathIndex: -1 },
      { id: 5, playerIndex: 1, state: 'HOME_BASE', pathIndex: -1 },
      { id: 6, playerIndex: 1, state: 'HOME_BASE', pathIndex: -1 },
      { id: 7, playerIndex: 1, state: 'HOME_BASE', pathIndex: -1 }
    ],
    hasCapturedOpponent: { 0: false, 1: false },
    currentPlayerIndex: currentPlayerIndex || 0,
    currentRoll: null,
    validMoves: [],
    winner: null,
    ...extras
  }, { ...Object.assign({}, extras) });
}

afterEach(() => {
  // Element map resets per test; globals stay installed for the cached boot.
  holder.docEls = { 'board-canvas': booted ? booted.canvas : holder.docEls['board-canvas'] };
});

describe('app.js online lobby (auth + rooms)', () => {
  test('setGameMode online reveals the card and active chip', () => {
    const { w } = fresh();
    w.setGameMode('online');
    expect(holder.docEls['btn-mode-online'].classList._set.active).toBe(true);
    expect(holder.docEls['btn-mode-pnp'].classList._set.active).toBe(false);
    expect(holder.docEls['online-card'].classList._set.hidden).toBe(false);
  });

  test('onlineLogin/onlineRegister/onlineLogout drive the transport', async () => {
    const { w, oc } = fresh();
    holder.docEls['online-username'].value = 'amy';
    holder.docEls['online-password'].value = 'pw';
    await w.onlineLogin();
    expect(oc.token).toBe('T');
    holder.docEls['online-username'].value = 'amy';
    await w.onlineRegister();
    expect(oc._calls.register).toBe(1);
    await w.onlineLogout();
    expect(oc.token).toBeNull();
  });

  test('onlineCreateRoom creates + shows the waiting code block', async () => {
    const { w, oc } = fresh();
    w.setGameMode('online');
    await w.onlineCreateRoom();
    expect(oc._calls.create).toBe(1);
    expect(holder.docEls['online-waiting'].classList._set.hidden).toBe(false);
    expect(holder.docEls['online-room-code-display'].innerText).toBe('ABCDEF');
  });

  test('onlineJoinRoom routes the code input to the transport', async () => {
    const { w, oc } = fresh();
    w.setGameMode('online');
    holder.docEls['online-room-code'].value = 'ABCDEF';
    await w.onlineJoinRoom();
    expect(oc._calls.joinRoom).toBe(1);
  });

  test('startGame in online mode without a seat is a lobby prompt', () => {
    const { w } = fresh();
    w.setGameMode('online');
    w.startGame();
    expect(holder.docEls['game-screen'].classList._set.active).toBeUndefined();
    expect(holder.docEls['online-status'].innerText).toContain('Create or join a room');
  });
});

describe('app.js online match (server-authoritative flow)', () => {
  function seatAs(oc, index) {
    const h = oc.__hooks;
    h.onJoined({ playerIndex: index, gridSize: 5, code: 'ABCDEF' });
  }

  test('host seat + member-count 2 enters the game screen', () => {
    const { w, oc } = fresh();
    w.setGameMode('online');
    seatAs(oc, 0);
    oc.__hooks.onPeerCount({ count: 2, playerNum: 2 });
    expect(holder.docEls['game-screen'].classList._set.active).toBe(true);
    expect(holder.docEls['home-screen'].classList._set.active).toBeUndefined();
    expect(holder.docEls['board-title'].innerText).toContain('ONLINE');
  });

  test('applyServerBoard renders turn, roll gate, and pawn offers for the seated mover', () => {
    const { w, oc } = fresh();
    w.setGameMode('online');
    seatAs(oc, 0);
    oc.__hooks.onBoard(boardFrom(5, 0, {
      currentRoll: { shells: [true, false, false, false], score: 1, isExtraRoll: false, scoreText: '1' },
      validMoves: [{ pawnIds: [0], targetCoords: [2, 2], isCapture: false, reachesHome: false, isGattiGroup: false }]
    }));
    expect(holder.docEls['btn-roll'].disabled).toBe(true); // roll already pending
    expect(holder.docEls['roll-score-display'].innerText).toBe('1');
    expect(holder.docEls['cowry-shells'].children.length).toBe(4);
    expect(holder.docEls['pawn-select-bar'].classList._set.hidden).toBeUndefined();
    // Clicking the offered pawn asks the relay to move (no local mutation).
    const pawnBtn = holder.docEls['pawn-buttons-container'].children[0];
    pawnBtn.onclick();
    expect(oc._calls.move.length).toBe(1);
    expect(oc._calls.move[0].targetCoords).toEqual([2, 2]);
  });

  test('handling an online roll sends roll to the relay, never rolls locally', () => {
    const { w, oc } = fresh();
    w.setGameMode('online');
    seatAs(oc, 0);
    oc.__hooks.onBoard(boardFrom(5, 0, { currentRoll: null, validMoves: [] }));
    const { handleRoll } = w;
    handleRoll();
    expect(oc._calls.roll).toBe(1);
  });

  test('a fresh board with no roll and my turn enables the roll button', () => {
    const { w, oc } = fresh();
    w.setGameMode('online');
    seatAs(oc, 0);
    oc.__hooks.onBoard(boardFrom(5, 0, { currentRoll: null, validMoves: [] }));
    expect(holder.docEls['btn-roll'].disabled).toBe(false);
  });

  test('opponent turn keeps roll disabled and hides pawn offers', () => {
    const { oc } = fresh();
    const b = booted;
    b.w.setGameMode('online');
    seatAs(b.oc, 1);
    b.oc.__hooks.onBoard(boardFrom(5, 1, {
      currentRoll: { shells: [true, false, false, false], score: 1, isExtraRoll: false, scoreText: '1' }
    }));
    expect(holder.docEls['btn-roll'].disabled).toBe(true);
    expect(holder.docEls['pawn-select-bar'].classList._set.hidden).toBe(true);
  });

  test('a winning board renders the victory banner and nukes the roll', () => {
    const { w, oc } = fresh();
    w.setGameMode('online');
    seatAs(oc, 0);
    oc.__hooks.onBoard(boardFrom(5, 0, { winner: 1 }));
    expect(holder.docEls['btn-roll'].disabled).toBe(true);
    expect(holder.docEls['game-log'].innerText).toContain('VICTORY');
  });

  test('move event flags in the broadcast fire the matching celebrations', () => {
    const { w, oc } = fresh();
    w.setGameMode('online');
    seatAs(oc, 0);
    // Capture broadcast -> CUT celebration, auto-hidden by its timer.
    const realST = globalThis.setTimeout;
    const realCT = globalThis.clearTimeout;
    const reg = new Map();
    let seq = 0;
    globalThis.setTimeout = (fn, ms) => { const id = ++seq; reg.set(id, { fn, cancelled: false }); return id; };
    globalThis.clearTimeout = (id) => { const t = reg.get(id); if (t) t.cancelled = true; };
    try {
      oc.__hooks.onBoard(boardFrom(5, 0, { capturedCount: 1, currentRoll: null, validMoves: [] }));
      const overlay = holder.docEls['celebration-overlay'];
      expect(overlay.className).toContain('celebrate-capture');
      expect(holder.docEls['celebration-emoji'].innerText).toBe('✂️');
      // Home-arrival broadcast replaces it with the HOME celebration.
      oc.__hooks.onBoard(boardFrom(5, 0, { reachesHome: true, currentRoll: null, validMoves: [] }));
      expect(overlay.className).toContain('celebrate-home');
      expect(holder.docEls['celebration-emoji'].innerText).toBe('🏠');
    } finally {
      globalThis.setTimeout = realST;
      globalThis.clearTimeout = realCT;
    }
  });

  test('hostile board fields degrade instead of crashing the client', () => {
    const { w, oc } = fresh();
    w.setGameMode('online');
    seatAs(oc, 0);

    // Out-of-range current player: clamped to a legal seat, no crash.
    expect(() => oc.__hooks.onBoard(boardFrom(5, 42, {}))).not.toThrow();
    expect(holder.docEls['turn-text'].innerText).toContain('Red'); // seat 0

    // Absurd gridSize must be clamped to a legal board (render DoS guard).
    const huge = boardFrom(999, 0, {});
    huge.gridSize = 999;
    expect(() => oc.__hooks.onBoard(huge)).not.toThrow();

    // Pawn with out-of-range pathIndex must not crash the renderer.
    const badPath = boardFrom(5, 0, {});
    badPath.pawns = badPath.pawns.map((p, i) =>
      i === 0 ? Object.assign({}, p, { state: 'ON_TRACK', pathIndex: 999 }) : p);
    expect(() => oc.__hooks.onBoard(badPath)).not.toThrow();
  });

  test('an out-of-range winner index degrades to a placeholder instead of crashing', () => {
    const { w, oc } = fresh();
    w.setGameMode('online');
    seatAs(oc, 0);
    // A hostile/buggy relay can broadcast a winner index with no seat.
    expect(() => oc.__hooks.onBoard(boardFrom(5, 0, { winner: 9 }))).not.toThrow();
    expect(holder.docEls['game-log'].innerText).toContain('VICTORY');
    expect(holder.docEls['game-log'].innerText).toContain('Unknown');
    expect(holder.docEls['btn-roll'].disabled).toBe(true);
  });

  test('peer-left while in game returns to the home screen', () => {
    const { w, oc } = fresh();
    w.setGameMode('online');
    seatAs(oc, 0);
    oc.__hooks.onPeerCount({ count: 2, playerNum: 2 });
    expect(holder.docEls['game-screen'].classList._set.active).toBe(true);
    oc.__hooks.onPeerLeft();
    expect(holder.docEls['home-screen'].classList._set.active).toBe(true);
    expect(holder.docEls['online-status'].innerText).toContain('Opponent left');
  });

  test('board clicks from the non-mover are ignored', () => {
    const { w, oc, canvas } = fresh();
    w.setGameMode('online');
    seatAs(oc, 1); // seat 1, but host (0) is moving
    oc.__hooks.onBoard(boardFrom(5, 0, {
      currentRoll: { shells: [false], score: 1, isExtraRoll: true, scoreText: '1' },
      validMoves: [{ pawnIds: [4], targetCoords: [1, 1], isCapture: false, reachesHome: false, isGattiGroup: false }]
    }));
    canvas.fireClick(250, 250); // some cell click while not my turn
    expect(oc._calls.move.length).toBe(0);
  });

  test('transport unavailable: lobby helpers surface a friendly error', async () => {
    const { w, oc } = fresh();
    const ocBackup = w.OnlineClient;
    w.OnlineClient = null; // simulate online-client.js not loaded
    w.setGameMode('online');
    const errs = [];
    const orig = holder.docEls['online-status'].innerText;
    void orig;
    holder.docEls['online-status'].innerText = '';
    await w.onlineLogin();
    expect(holder.docEls['online-status'].innerText).toContain('Online is unavailable');
    await w.onlineRegister();
    await w.onlineCreateRoom();
    await w.onlineJoinRoom();
    expect(holder.docEls['online-status'].innerText).toContain('Online is unavailable');
    w.OnlineClient = ocBackup;
    await w.onlineLogin();
    expect(errs.length).toBe(0);
  });

  test('startOnlineGame is inert until a seat is assigned', () => {
    const { w, oc } = fresh();
    w.setGameMode('online');
    // peer-count arrives BEFORE the joined frame -> onlineSeat still -1
    oc.__hooks.onPeerCount({ count: 2, playerNum: 2 });
    expect(holder.docEls['game-screen'].classList._set.active).toBeUndefined();
  });

  test('applyServerBoard tolerates a sparse/empty board using current defaults', () => {
    const { w, oc } = fresh();
    w.setGameMode('online');
    seatAs(oc, 0);
    oc.__hooks.onBoard({}); // no gridSize / playerNum / pawns / roll / moves / winner
    expect(holder.docEls['btn-roll'].disabled).toBe(false);
    oc.__hooks.onBoard(null);
    expect(holder.docEls['btn-roll'].disabled).toBe(false);
  });

  test('member-count below 2 stays in the lobby waiting state', () => {
    const { w, oc } = fresh();
    w.setGameMode('online');
    seatAs(oc, 0);
    oc.__hooks.onPeerCount({ count: 1, playerNum: 2 });
    expect(holder.docEls['game-screen'].classList._set.active).toBeUndefined();
  });

  test('restartGame in an online lobby match is refused', () => {
    const { w, oc } = fresh();
    w.setGameMode('online');
    seatAs(oc, 0);
    oc.__hooks.onPeerCount({ count: 2, playerNum: 2 });
    expect(holder.docEls['game-screen'].classList._set.active).toBe(true);
    // Normal roll state -> snapshot covers the currentRoll/winner truthy arms
    oc.__hooks.onBoard(boardFrom(5, 0, {
      currentRoll: { shells: [true], score: 1, isExtraRoll: true, scoreText: '1' },
      validMoves: []
    }));
    w.restartGame(); // gameActive + winner-less board
    expect(holder.docEls['online-status'].innerText).toContain('cannot be restarted');
    // Winner present -> snapshot covers line 48, winner also clears the roll
    oc.__hooks.onBoard(boardFrom(5, 0, {
      winner: 1,
      currentRoll: { shells: [true], score: 1, isExtraRoll: true, scoreText: '1' },
      validMoves: []
    }));
    w.restartGame(); // winner present
    // lobby + restart while not active uses the empty-message arm
    w.showHomeScreen(); // gameActive -> false, still online mode
    w.restartGame();
    expect(holder.docEls['online-status'].innerText).toBe('');
  });

  test('onClosed distinguishes mid-match vs lobby disconnect', () => {
    const { w, oc } = fresh();
    w.setGameMode('online');
    seatAs(oc, 0);
    oc.__hooks.onPeerCount({ count: 2, playerNum: 2 });
    oc.__hooks.onClosed();
    expect(holder.docEls['online-status'].innerText).toContain('Disconnected from the match');
  });

  test('onClosed in the lobby shows a generic disconnected message', () => {
    const { w, oc } = fresh();
    w.setGameMode('online');
    seatAs(oc, 0); // no peer -> gameActive false
    oc.__hooks.onClosed();
    expect(holder.docEls['online-status'].innerText).toContain('Disconnected.');
  });

  test('applyServerBoard accepts rolls without scoreText and moves without pawnIds', () => {
    const { w, oc } = fresh();
    w.setGameMode('online');
    seatAs(oc, 0);
    oc.__hooks.onBoard({
      currentPlayerIndex: 1,
      currentRoll: { score: 3, isExtraRoll: false }, // no shells / no scoreText
      validMoves: [{ targetCoords: [2, 3], isCapture: false, reachesHome: false }],
    });
    expect(holder.docEls['roll-score-display'].innerText).toBe('3');
  });

  test('onPeerLeft in the lobby stays on the home screen', () => {
    const { w, oc } = fresh();
    w.setGameMode('online');
    seatAs(oc, 0); // seated but no peer -> gameActive false
    oc.__hooks.onPeerLeft();
    expect(holder.docEls['online-status'].innerText).toContain('Opponent left the lobby');
    expect(holder.docEls['game-screen'].classList._set.active).toBeUndefined();
  });

  test('startGame online with a seat jumps straight into the match', () => {
    const { w, oc } = fresh();
    w.setGameMode('online');
    seatAs(oc, 0);
    w.startGame(); // onlineSeat != -1 -> startOnlineGame()
    expect(holder.docEls['game-screen'].classList._set.active).toBe(true);
  });

  test('handleRoll online with a missing transport is a silent no-op', () => {
    const { w, oc } = fresh();
    w.setGameMode('online');
    const ocBackup = w.OnlineClient;
    w.OnlineClient = null;
    w.handleRoll();
    w.OnlineClient = ocBackup;
    expect(oc._calls.roll).toBe(0);
  });
});