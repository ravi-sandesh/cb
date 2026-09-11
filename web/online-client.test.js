// ============================================================
// CHOKA BARAH – Online client transport tests (online-client.js)
// The module reads fetch/WebSocket/localStorage off globalThis in
// Node, so we install node-side fakes BEFORE requiring it through
// the real Jest registry (istanbul instruments it for coverage).
// Every test drives the public OnlineClient API + delegates, never
// the real network — the same contract app.js consumes.
// ============================================================
'use strict';

let fetchImpl;
let wsInstances;
let storage;

class FakeWS {
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.readyState = 0; // CONNECTING until we fire onopen
    wsInstances.push(this);
  }
  send(payload) { this.sent.push(payload); }
  close(code, reason) {
    this._closeCode = code;
    this._closeReason = reason;
    this.readyState = 3; // CLOSED
  }
  open() { this.readyState = 1; if (this.onopen) this.onopen(); }
  server(cli) { if (this.onmessage) this.onmessage({ data: JSON.stringify(cli) }); }
  drop(code) { if (this.onclose) this.onclose({ code: code || 1006 }); }
  fail() { if (this.onerror) this.onerror(new Error('connection lost')); }
}

function respond(status, body) {
  return { status, text: async () => JSON.stringify(body) };
}

function installFakes() {
  storage = {};
  globalThis.localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : null),
    setItem: (k, v) => { storage[k] = String(v); },
    removeItem: (k) => { delete storage[k]; }
  };

  fetchImpl = jest.fn(async (url, opts) => {
    const u = String(url);
    if (u === '/api/register') return respond(201, { token: 'T-REG', user: { id: 1, username: 'amy' } });
    if (u === '/api/me') return respond(globalThis.__meStatus || 200, { ok: true, user: globalThis.__meUser || null });
    if (u === '/api/login') {
      const body = JSON.parse(opts.body || '{}');
      if (body.username === 'unknown') return respond(401, { error: 'bad-credentials' });
      return respond(200, { token: 'T-LOG', user: { id: 2, username: body.username } });
    }
    if (u === '/api/match/create') return respond(201, { code: 'ABCDEF', gridSize: 5, wsPath: '/ws' });
    if (u === '/api/match/join') return respond(200, { code: 'ABCDEF', gridSize: 5, wsPath: '/ws' });
    if (u === '/api/logout') return respond(200, { ok: true });
    if (u === '/api/health') return respond(200, { ok: true });
    return respond(404, { error: 'not-found' });
  });
  globalThis.fetch = fetchImpl;

  wsInstances = [];
  globalThis.WebSocket = FakeWS;
}

beforeEach(() => {
  installFakes();
  jest.resetModules();            // re-run the IIFE against fresh globals
  jest.isolateModules(() => {
    require('./online-client.js');
  });
  globalThis.OnlineClient = globalThis.OnlineClient || (() => { throw new Error('OnlineClient missing'); })();
});

afterEach(() => {
  delete globalThis.localStorage;
  delete globalThis.WebSocket;
});

function oc() { return globalThis.OnlineClient; }

describe('online-client auth + sessions', () => {
  test('register signs in via cookie and persists only the display name', async () => {
    const calls = [];
    oc().onStatus((m) => calls.push([m, false]));
    await oc().register('amy', 'pw');
    expect(fetchImpl).toHaveBeenCalledWith('/api/register', expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin'
    }));
    expect(oc().authed).toBe(true);
    expect(oc().username).toBe('amy');
    // No token may ever touch localStorage — the cookie is HttpOnly.
    expect(storage['cb_online_token']).toBeUndefined();
    expect(storage['cb_online_user']).toBe('amy');
    expect(calls.some(([m]) => /Registered and signed in/.test(m))).toBe(true);
  });

  test('login rejects bad credentials and leaves no token', async () => {
    const errors = [];
    oc().onStatus((m, err) => { if (err) errors.push(m); });
    const out = await oc().login('unknown', 'nope');
    expect(out).toBeNull();
    expect(oc().authed).toBe(false);
    await oc().login('bob', 'pw');
    expect(oc().authed).toBe(true);
    expect(oc().username).toBe('bob');
  });

  test('logout clears the session flag and disconnects', async () => {
    await oc().register('amy', 'pw');
    await oc().createRoom(5);
    expect(wsInstances.length).toBe(1);
    await oc().logout();
    expect(oc().authed).toBe(false);
    expect(storage['cb_online_user']).toBeUndefined();
    expect(oc().connected).toBe(false);
  });

  test('whoami restores the signed-in state from the session cookie', async () => {
    globalThis.__meUser = { id: 7, username: 'carol' };
    const name = await oc().whoami();
    expect(name).toBe('carol');
    expect(oc().authed).toBe(true);

    globalThis.__meStatus = 401;
    globalThis.__meUser = null;
    expect(await oc().whoami()).toBeNull();
    expect(oc().authed).toBe(false);
  });

  test('boot no longer reads a token from localStorage', () => {
    storage['cb_online_token'] = 'SHOULD-BE-IGNORED';
    jest.resetModules();
    jest.isolateModules(() => { require('./online-client.js'); });
    expect(oc().authed).toBe(false); // trust comes from the cookie via whoami()
  });

  test('boot restores only the display name (auth comes from the cookie)', async () => {
    storage['cb_online_token'] = 'T-RESTORE'; // must be ignored entirely
    storage['cb_online_user'] = 'carol';
    jest.resetModules();
    require('./online-client.js');
    expect(oc().username).toBe('carol');
    expect(oc().authed).toBe(false);
  });
});

describe('online-client reconnect + resume', () => {
  // Uses its OWN module instance so the facade always matches the sockets.
  function bootFresh() {
    installFakes();
    delete globalThis.OnlineClient; // force a fresh facade from the reload
    jest.resetModules();
    jest.isolateModules(() => { require('./online-client.js'); });
    return globalThis.OnlineClient;
  }

  test('an abnormal drop schedules an automatic reconnect that resumes', async () => {
    jest.useFakeTimers();
    const c = bootFresh();
    c.onStatus(() => {});
    await c.register('amy', 'pw');
    await c.createRoom(5);
    expect(wsInstances.length).toBe(1);
    wsInstances[0].open();
    wsInstances[0].drop(1006); // abnormal network drop

    // Backoff (1s) elapses -> a NEW socket opens for the same path and the
    // join re-sent automatically (cookie-authenticated).
    jest.advanceTimersByTime(1000);
    expect(wsInstances.length).toBe(2);
    expect(wsInstances[1].url).toContain('/ws');
    wsInstances[1].open();
    expect(wsInstances[1].sent).toEqual([JSON.stringify({ type: 'join', code: 'ABCDEF' })]);
  });

  test('gives up after the attempt budget and reports it', async () => {
    jest.useFakeTimers();
    const c = bootFresh();
    c.onStatus(() => {});
    await c.register('amy', 'pw');
    await c.createRoom(5);
    wsInstances[0].open();
    const errs = [];
    c.onStatus((m, err) => { if (err) errs.push(m); });

    // Drop -> wait out backoff -> client redials -> drop again, until the
    // attempt budget is spent and the give-up status is surfaced.
    // Simulate a host that is permanently unreachable: every redial fails
    // before ever reaching OPEN, until the budget trips the give-up status.
    wsInstances[wsInstances.length - 1].drop(1006);
    for (let i = 0; i < 12 && !errs.some((m) => /Could not reconnect/.test(m)); i++) {
      jest.advanceTimersByTime(20000); // covers max backoff
      const cur = wsInstances[wsInstances.length - 1];
      cur.drop(1006); // redial fails immediately again
    }
    expect(errs.some((m) => /Could not reconnect/.test(m))).toBe(true);
    const count = wsInstances.length;
    jest.advanceTimersByTime(60000);
    expect(wsInstances.length).toBe(count); // no further dials
    // eslint-disable-next-line no-console
    
  });

  test('give-up does NOT permanently suppress reconnection for a NEW room', async () => {
    const c = bootFresh();
    c.onStatus(() => {});
    await c.register('amy', 'pw');

    jest.useFakeTimers();
    try {
      // Room 1: initial dial works, then the server becomes unreachable.
      await c.createRoom(5);
      wsInstances[0].open();
      wsInstances[0].drop(1006);

      // Every redial also fails immediately (never reaches OPEN).
      // Attempts climb 1..7 until the budget trips.
      for (let i = 0; i < 12; i++) {
        jest.advanceTimersByTime(20000); // fire the backoff timer -> redial
        const cur = wsInstances[wsInstances.length - 1];
        cur.drop(1006); // immediate failure (server unreachable)
      }
      const countAfterGiveUp = wsInstances.length;
      // Confirm suppressed.
      jest.advanceTimersByTime(60000);
      expect(wsInstances.length).toBe(countAfterGiveUp);

      // Server comes back; user joins a DIFFERENT room. Successful open
      // must clear the suppression so future drops reconnect normally.
      await c.joinRoom('NEWROOM');
      const fresh = wsInstances[wsInstances.length - 1];
      fresh.open();
      fresh.drop(1006);
      jest.advanceTimersByTime(20000);
      expect(wsInstances.length).toBeGreaterThan(countAfterGiveUp + 1);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a clean close (1000) never triggers reconnection', async () => {
    const c = bootFresh();
    c.onStatus(() => {});
    await c.register('amy', 'pw');
    await c.createRoom(5);
    wsInstances[0].open();
    jest.useFakeTimers();
    try {
      wsInstances[0].drop(1000);
      jest.advanceTimersByTime(60000);
      expect(wsInstances.length).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('online-client room lobby + WebSocket', () => {
  test('createRoom hits the API, opens a socket, and auto-joins on open', async () => {
    oc().onStatus(() => {});
    await oc().register('amy', 'pw');
    const code = await oc().createRoom(7);
    expect(code).toBe('ABCDEF');
    expect(fetchImpl).toHaveBeenCalledWith('/api/match/create', expect.objectContaining({
      credentials: 'same-origin'
    }));
    expect(fetchImpl.mock.calls.find((c) => c[0] === '/api/match/create')[1].headers.Authorization).toBeUndefined();
    expect(wsInstances.length).toBe(1);
    const ws = wsInstances[0];
    expect(ws.url).toContain('/ws');
    ws.open();
    expect(oc().connected).toBe(true);
    // Cookie-authenticated upgrade: the join goes out immediately.
    expect(ws.sent).toEqual([JSON.stringify({ type: 'join', code: 'ABCDEF' })]);
    expect(oc().code).toBe('ABCDEF');
  });

  test('joinRoom requires code and connects via the returned wsPath', async () => {
    oc().onStatus(() => {});
    await oc().register('amy', 'pw');
    const code = await oc().joinRoom('   abcdef  ');
    expect(code).toBe('ABCDEF');
    expect(wsInstances.length).toBe(1);
    wsInstances[0].open();
    expect(wsInstances[0].sent).toEqual([JSON.stringify({ type: 'join', code: 'ABCDEF' })]);
  });

  test('joinRoom without a code reports an error and connects nothing', async () => {
    const errs = [];
    oc().onStatus((m, err) => { if (err) errs.push(m); });
    await oc().register('amy', 'pw');
    const code = await oc().joinRoom('   ');
    expect(code).toBeNull();
    expect(errs.some((m) => /Enter a room code/.test(m))).toBe(true);
    expect(wsInstances.length).toBe(0);
  });

  test('createRoom forwards the configured player count (2-4, coerced)', async () => {
    oc().onStatus(() => {});
    await oc().register('amy', 'pw');
    await oc().createRoom(5, 4);
    const sent = JSON.parse(fetchImpl.mock.calls.find((c) => c[0] === '/api/match/create')[1].body);
    expect(sent.playerCount).toBe(4);
    expect(sent.gridSize).toBe(5);
  });

  test('connect rejects a missing wsPath instead of dialling /undefined', async () => {
    const errs = [];
    oc().onStatus((m, err) => { if (err) errs.push(m); });
    await oc().register('amy', 'pw');
    oc().connect(undefined, 'ABCDEF');
    expect(wsInstances.length).toBe(0);
    expect(errs.some((m) => /bad address/.test(m))).toBe(true);
    oc().connect('/ws', 'ABCDEF');
    expect(wsInstances.length).toBe(1);
    expect(wsInstances[0].url).toContain('/ws');
  });

  test('join goes out once per socket across open + authed', async () => {
    oc().onStatus(() => {});
    await oc().register('amy', 'pw');
    await oc().createRoom(5);
    const ws = wsInstances[0];
    ws.open(); // join #1 on open
    expect(ws.sent).toHaveLength(1);
    ws.server({ type: 'authed' }); // must NOT re-send join
    expect(ws.sent).toHaveLength(1);
  });

  test('dispatch routes board/joined/member-count/peer-left/game-over/error', async () => {
    const seen = { joined: null, board: null, count: null, left: false, over: null, error: null };
    oc().onStatus(() => {});
    oc().onJoined((p) => { seen.joined = p; });
    oc().onBoard((b) => { seen.board = b; });
    oc().onPeerCount((c) => { seen.count = c; });
    oc().onPeerLeft(() => { seen.left = true; });
    oc().onGameOver((o) => { seen.over = o; });
    oc().onError((code) => { seen.error = code; });

    await oc().register('amy', 'pw');
    await oc().createRoom(5);
    const ws = wsInstances[0];
    ws.open();
    ws.server({ type: 'joined', code: 'ABCDEF', playerIndex: 0, gridSize: 5 });
    expect(seen.joined).toEqual({ playerIndex: 0, gridSize: 5, code: 'ABCDEF' });
    ws.server({ type: 'board', board: { gridSize: 5, currentPlayerIndex: 0, pawns: [] } });
    expect(seen.board.gridSize).toBe(5);
    ws.server({ type: 'member-count', count: 2, playerNum: 2 });
    expect(seen.count).toEqual({ count: 2, playerNum: 2 });
    ws.server({ type: 'peer-left', userId: 99 });
    expect(seen.left).toBe(true);
    ws.server({ type: 'game-over', winner: 0, winnersUser: 1 });
    expect(seen.over).toEqual({ winner: 0, winnerUser: 1 });
    ws.server({ type: 'error', code: 'not-your-turn' });
    expect(seen.error).toBe('not-your-turn');
    expect(oc().lastError).toBe('not-your-turn');
  });

  test('roll/move/leave send the expected protocol messages', async () => {
    oc().onStatus(() => {});
    await oc().register('amy', 'pw');
    await oc().createRoom(5);
    const ws = wsInstances[0];
    ws.open();
    oc().roll();
    oc().move({ grpPawns: [{ id: 3 }, { id: 7 }], targetCoords: [2, 1] });
    oc().join('ZZZZZZ');
    oc().leave();
    expect(ws.sent).toContain(JSON.stringify({ type: 'roll' }));
    expect(ws.sent).toContain(JSON.stringify({ type: 'move', move: { pawnIds: [3, 7], targetCoords: [2, 1] } }));
    expect(ws.sent).toContain(JSON.stringify({ type: 'join', code: 'ZZZZZZ' }));
    expect(ws.sent).toContain(JSON.stringify({ type: 'leave' }));
    expect(ws._closeCode).toBe(4000);
  });

  test('onclose reports a disconnect to the closed delegate', async () => {
    const closed = [];
    oc().onStatus(() => {});
    oc().onClosed((c) => closed.push(c));
    await oc().register('amy', 'pw');
    await oc().createRoom(5);
    wsInstances[0].open();
    wsInstances[0].drop(4301);
    expect(closed).toEqual([4301]);
    expect(oc().connected).toBe(false);
  });

  test('unauthed createRoom refuses without a token', async () => {
    const errs = [];
    oc().onStatus((m, err) => { if (err) errs.push(m); });
    const code = await oc().createRoom(5);
    expect(code).toBeNull();
    expect(errs.some((m) => /Sign in first/.test(m))).toBe(true);
    expect(wsInstances.length).toBe(0);
  });
});

describe('online-client failure + edge paths', () => {
  test('register surfaces the server error instead of signing in', async () => {
    fetchImpl.mockImplementationOnce(async (url) => {
      if (String(url) === '/api/register') return respond(400, { error: 'username-taken' });
      return respond(201, { user: { username: 'x' } });
    });
    const errs = [];
    oc().onStatus((m, err) => { if (err) errs.push(m); });
    const out = await oc().register('amy', 'pw');
    expect(out).toBeNull();
    expect(oc().authed).toBe(false);
    expect(errs.some((m) => /Registration failed: username-taken/.test(m))).toBe(true);
  });

  test('createRoom surfaces a server rejection', async () => {
    await oc().register('amy', 'pw');
    fetchImpl.mockImplementationOnce(async (url) => {
      if (String(url) === '/api/match/create') return respond(500, { error: 'boom' });
      return respond(201, { code: 'ABCDEF', gridSize: 5, wsPath: '/ws' });
    });
    const errs = [];
    oc().onStatus((m, err) => { if (err) errs.push(m); });
    const code = await oc().createRoom(5);
    expect(code).toBeNull();
    expect(oc().code).toBeNull();
    expect(oc().connected).toBe(false);
    expect(errs.some((m) => /Room creation failed: boom/.test(m))).toBe(true);
    expect(wsInstances.length).toBe(0);
  });

  test('joinRoom surfaces a server rejection', async () => {
    await oc().register('amy', 'pw');
    fetchImpl.mockImplementationOnce(async (url) => {
      if (String(url) === '/api/match/join') return respond(404, { error: 'no-such-room' });
      return respond(200, { code: 'ABCDEF', gridSize: 5, wsPath: '/ws' });
    });
    const errs = [];
    oc().onStatus((m, err) => { if (err) errs.push(m); });
    const code = await oc().joinRoom('ZZZZZZ');
    expect(code).toBeNull();
    expect(oc().code).toBeNull();
    expect(errs.some((m) => /Join failed: no-such-room/.test(m))).toBe(true);
    expect(wsInstances.length).toBe(0);
  });

  test('unauthored joinRoom refuses before sending anything', async () => {
    const errs = [];
    oc().onStatus((m, err) => { if (err) errs.push(m); });
    const code = await oc().joinRoom('ABCDEF');
    expect(code).toBeNull();
    expect(errs.some((m) => /Sign in first/.test(m))).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalledWith('/api/match/join');
  });

  test('dispatch tolerates unknown and authed frames', async () => {
    const seen = [];
    oc().onStatus(() => {});
    oc().onClosed((c) => seen.push(c));
    await oc().register('amy', 'pw');
    await oc().createRoom(5);
    const ws = wsInstances[0];
    ws.open();
    ws.server({ type: 'authed', userId: 1 });
    ws.server({ type: 'something-else', payload: 1 });
    expect(seen.length).toBe(0); // neither fired a delegate
  });

  test('ws.onerror reports a connection error via status', async () => {
    const errs = [];
    oc().onStatus((m, err) => { if (err) errs.push(m); });
    await oc().register('amy', 'pw');
    await oc().createRoom(5);
    wsInstances[0].open();
    wsInstances[0].fail();
    expect(errs.some((m) => /Connection error/.test(m))).toBe(true);
  });

  test('onclose without a session code still fires the closed delegate', async () => {
    const closed = [];
    oc().onStatus(() => {});
    oc().onClosed((c) => closed.push(c));
    oc().connect('/ws?token=T', null); // raw connect, no room code restore
    wsInstances[0].drop(1000);
    expect(closed).toEqual([1000]);
  });

  test('getters expose gridSize/playerIndex after a joined frame', async () => {
    oc().onStatus(() => {});
    oc().onJoined(() => {});
    await oc().register('amy', 'pw');
    await oc().createRoom(5);
    const ws = wsInstances[0];
    ws.open();
    ws.server({ type: 'joined', playerIndex: 0, gridSize: 5, code: 'ABCDEF' });
    expect(oc().gridSize).toBe(5);
    expect(oc().playerIndex).toBe(0);
    expect(oc().code).toBe('ABCDEF');
  });

  test('roll/move/join/leave are safe no-ops while disconnected', async () => {
    const errs = [];
    oc().onStatus((m, err) => { if (err) errs.push(m); });
    await oc().register('amy', 'pw');
    expect(wsInstances.length).toBe(0); // auth alone did not open a socket
    oc().roll();
    oc().move({ grpPawns: [{ id: 0 }], targetCoords: [1, 1] });
    oc().join('ABCDEF');
    oc().leave();
    expect(wsInstances.length).toBe(0);
    expect(errs.length).toBe(0);
  });

  test('empty response bodies parse as {} instead of throwing', async () => {
    fetchImpl.mockImplementation(async (url) => {
      if (String(url) === '/api/login') return { status: 200, text: async () => JSON.stringify({ token: 'T', user: { username: 'amy' } }) };
      if (String(url) === '/api/logout') return { status: 200, text: async () => '' }; // empty body
      return { status: 201, text: async () => JSON.stringify({ token: 'T', user: { username: 'amy' } }) };
    });
    jest.resetModules();
    jest.isolateModules(() => { require('./online-client.js'); });
    const o = globalThis.OnlineClient;
    o.onStatus(() => {});
    await o.register('amy', 'pw');
    await o.logout();
    expect(o.authed).toBe(false);
  });

  test('logout without an existing session is harmless', async () => {
    const errs = [];
    oc().onStatus((m, err) => { if (err) errs.push(m); });
    await oc().logout();
    expect(oc().authed).toBe(false);
    expect(errs.length).toBe(0);
  });

  test('browser-window root falls back to globalThis seams when window lacks them', async () => {
    globalThis.window = {}; // no fetch / WebSocket / location
    jest.resetModules();
    jest.isolateModules(() => { require('./online-client.js'); });
    globalThis.OnlineClient = globalThis.window.OnlineClient; // instance lands on window root
    const o = globalThis.OnlineClient;
    o.onStatus(() => {});
    await o.register('amy', 'pw');
    const code = await o.createRoom(5);
    expect(code).toBe('ABCDEF');
    expect(wsInstances[0].url).toContain('ws://localhost');
    delete globalThis.window;
    delete globalThis.OnlineClient;
  });

  test('https origin builds a wss URL at the right host', async () => {
    globalThis.window = {
      fetch: fetchImpl,
      WebSocket: FakeWS,
      location: { protocol: 'https:', host: 'game.example.com' }
    };
    jest.resetModules();
    jest.isolateModules(() => { require('./online-client.js'); });
    globalThis.OnlineClient = globalThis.window.OnlineClient;
    const o = globalThis.OnlineClient;
    o.onStatus(() => {});
    await o.register('amy', 'pw');
    await o.createRoom(5);
    expect(wsInstances[0].url).toBe('wss://game.example.com/ws');
    delete globalThis.window;
    delete globalThis.OnlineClient;
  });

  test('absent localStorage makes session persistence a silent no-op', async () => {
    delete globalThis.localStorage;
    jest.resetModules();
    jest.isolateModules(() => { require('./online-client.js'); });
    const o = globalThis.OnlineClient;
    o.onStatus(() => {});
    const out = await o.register('amy', 'pw');
    expect(out).not.toBeNull();
    expect(o.authed).toBe(true); // cookie session survives missing localStorage
  });
});