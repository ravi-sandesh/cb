'use strict';
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { openDb, makeStore } = require('./online-db.js');
const { createOnlineServer } = require('./online-server.js');

// ---- tiny http client ----
function apiRequest(port, method, pathname, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: {
      'Content-Type': 'application/json',
      'Content-Length': data ? Buffer.byteLength(data) : 0,
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    } }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(buf); } catch { parsed = buf; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ---- minimal raw WS client over a TCP socket ----
function openSocket(port, path) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      const key = crypto.randomBytes(16).toString('base64');
      sock.write(
        `GET ${path} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${key}\r\n` +
        'Sec-WebSocket-Version: 13\r\n\r\n'
      );
    });
    let buf = Buffer.alloc(0);
    let handshake = false;
    const messages = [];
    const waiters = [];
    sock.on('data', (d) => {
      if (!handshake) {
        buf = Buffer.concat([buf, d]);
        const i = buf.indexOf('\r\n\r\n');
        if (i === -1) return;
        const head = buf.subarray(0, i).toString();
        buf = buf.subarray(i + 4);
        handshake = true;
        if (!/101/.test(head.split('\r\n')[0])) { sock.destroy(); return reject(new Error('handshake failed')); }
        resolve(wsHandle(sock, messages, waiters));
        drain();
        return;
      }
      buf = Buffer.concat([buf, d]);
      drain();
    });
    sock.on('error', (e) => { if (!handshake) reject(e); });
    sock.on('end', () => waiters.forEach((w) => w.fn(null)));
    function drain() {
      for (;;) {
        const fr = decodeServerFrame(buf);
        if (!fr) break;
        buf = buf.subarray(fr.bytes);
        if (fr.opcode !== 0x1) continue;
        const msg = JSON.parse(fr.payload.toString());
        messages.push(msg);
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i].match(msg)) { const w = waiters.splice(i, 1)[0]; w.fn(msg); }
        }
      }
    }
  });
}

function wsHandle(sock, messages, waiters) {
  return {
    messages,
    send(obj) { sock.write(encodeClientFrame(JSON.stringify(obj))); },
    next(pred, timeoutMs = 4000) {
      return new Promise((resolve, reject) => {
        const hit = messages.find(pred);
        if (hit) return resolve(hit);
        const t = setTimeout(() => reject(new Error('ws timeout')), timeoutMs);
        waiters.push({ match: pred, fn: (m) => { clearTimeout(t); resolve(m); } });
      });
    },
    close() { sock.end(); }
  };
}

function decodeServerFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0], b1 = buf[1];
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let off = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); off = 10; }
  const maskLen = masked ? 4 : 0;
  if (buf.length < off + maskLen) return null;
  const mask = buf.subarray(off, off + maskLen);
  off += maskLen;
  if (buf.length < off + len) return null;
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i++) out[i] = masked ? buf[off + i] ^ mask[i & 3] : buf[off + i];
  return { opcode, payload: out, bytes: off + len };
}

function encodeClientFrame(text) {
  const p = Buffer.from(text);
  const mask = crypto.randomBytes(4);
  const h = Buffer.alloc(2 + 4);
  h[0] = 0x81;
  h[1] = 0x80 | p.length;
  mask.copy(h, 2);
  const body = Buffer.alloc(p.length);
  for (let i = 0; i < p.length; i++) body[i] = p[i] ^ mask[i & 3];
  return Buffer.concat([h, body]);
}

// ---- suite ----
let server;
let port;
let store;
let alice;
let bob;

beforeAll(async () => {
  store = makeStore(openDb(':memory:'));
  server = createOnlineServer({ store });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

afterAll(() => {
  if (server && server.relay) server.relay.shutdown();
  return new Promise((resolve) => server && server.close(resolve));
});

async function register(user) {
  const r = await apiRequest(port, 'POST', '/api/register', { body: { username: user, password: 'secret123' } });
  expect(r.status).toBe(201);
  return r.body;
}

beforeEach(async () => {
  store.resetDb();
  alice = await register('alice');
  bob = await register('bob');
});

describe('online-server HTTP API', () => {
  test('health endpoint reports ok', async () => {
    const r = await apiRequest(port, 'GET', '/api/health');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  test('register validates and dedupes usernames', async () => {
    const dup = await apiRequest(port, 'POST', '/api/register', { body: { username: 'alice', password: 'secret123' } });
    expect(dup.status).toBe(400);
    expect(dup.body.error).toBe('username-taken');
    const bad = await apiRequest(port, 'POST', '/api/register', { body: { username: '', password: 'secret123' } });
    expect(bad.status).toBe(400);
  });

  test('login requires the right password', async () => {
    const ok = await apiRequest(port, 'POST', '/api/login', { body: { username: 'alice', password: 'secret123' } });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBeTruthy();
    const nope = await apiRequest(port, 'POST', '/api/login', { body: { username: 'alice', password: 'bad' } });
    expect(nope.status).toBe(401);
  });

  test('protected endpoints reject missing/invalid tokens', async () => {
    const no = await apiRequest(port, 'POST', '/api/match/create', { body: { gridSize: 5 } });
    expect(no.status).toBe(401);
    const fake = await apiRequest(port, 'POST', '/api/match/create', { token: 'invalidtoken', body: { gridSize: 5 } });
    expect(fake.status).toBe(401);
  });

  test('logout invalidates the session token', async () => {
    const lg = await apiRequest(port, 'POST', '/api/login', { body: { username: 'alice', password: 'secret123' } });
    const out = await apiRequest(port, 'POST', '/api/logout', { token: lg.body.token });
    expect(out.status).toBe(200);
    const create = await apiRequest(port, 'POST', '/api/match/create', { token: lg.body.token, body: { gridSize: 5 } });
    expect(create.status).toBe(401);
  });
});

describe('online-server match lifecycle + ws relay', () => {
  test('host creates a room, guest joins, then turn authority is enforced', async () => {
    const created = await apiRequest(port, 'POST', '/api/match/create', { token: alice.token, body: { gridSize: 5 } });
    expect(created.status).toBe(201);
    expect(created.body.code).toMatch(/^[A-Z0-9]{6}$/);
    expect(created.body.wsPath).toContain('/ws?token=');

    const joined = await apiRequest(port, 'POST', '/api/match/join', { token: bob.token, body: { code: created.body.code } });
    expect(joined.status).toBe(200);
    expect(joined.body.gridSize).toBe(5);

    // HTTP join alone NEVER seats the guest — seating + PLAYING flip happens on
    // the websocket attach, so the DB is still WAITING here (authority lives
    // in the relay, not the HTTP layer).
    expect(store.getMatchByCode(created.body.code).status).toBe('WAITING');

    const host = await openSocket(port, created.body.wsPath);
    const guest = await openSocket(port, joined.body.wsPath);

    host.send({ type: 'join', code: created.body.code });
    const hostJoined = await host.next((m) => m.type === 'joined');
    expect(hostJoined.playerIndex).toBe(0);

    guest.send({ type: 'join', code: created.body.code });
    const guestJoined = await guest.next((m) => m.type === 'joined');
    expect(guestJoined.playerIndex).toBe(1);

    const board = await host.next((m) => m.type === 'board');
    expect(board.board.currentPlayerIndex).toBe(0);
    expect(board.board.pawns.length).toBe(8);

    // Guest tries to roll out of turn -> authoritative rejection.
    guest.send({ type: 'roll' });
    const err = await guest.next((m) => m.type === 'error');
    expect(err.code).toBe('not-your-turn');

    // After the guest's socket attached, the match flipped to PLAYING.
    expect(store.getMatchByCode(created.body.code).status).toBe('PLAYING');

    // Host rolls; a board broadcast follows. (Rolls with zero moves reset
    // currentRoll, so only assert the broadcast arrives.)
    host.send({ type: 'roll' });
    await host.next((m) => m.type === 'board');

    host.close();
    guest.close();
  });

  test('cannot join an unknown room or your own room', async () => {
    const ghost = await apiRequest(port, 'POST', '/api/match/join', { token: bob.token, body: { code: 'NOPE99' } });
    expect(ghost.status).toBe(404);

    const created = await apiRequest(port, 'POST', '/api/match/create', { token: alice.token, body: { gridSize: 5 } });
    const self = await apiRequest(port, 'POST', '/api/match/join', { token: alice.token, body: { code: created.body.code } });
    expect(self.status).toBe(409);
  });

  test('moves round-trip over the wire and persist to the ledger board', async () => {
    const created = await apiRequest(port, 'POST', '/api/match/create', { token: alice.token, body: { gridSize: 5 } });
    const joined = await apiRequest(port, 'POST', '/api/match/join', { token: bob.token, body: { code: created.body.code } });
    const host = await openSocket(port, created.body.wsPath);
    const guest = await openSocket(port, joined.body.wsPath);
    host.send({ type: 'join', code: created.body.code });
    guest.send({ type: 'join', code: created.body.code });
    await host.next((m) => m.type === 'joined');
    await guest.next((m) => m.type === 'joined');

    // Host rolls; because the roll is nondeterministic, only assert the board
    // broadcast arrives with a well-formed board.
    host.send({ type: 'roll' });
    const rolled = await host.next((m) => m.type === 'board');
    const board = rolled.board;
    expect(board.pawns.length).toBe(8);
    if (board.validMoves && board.validMoves.length > 0) {
      host.send({ type: 'move', move: board.validMoves[0] });
      const afterMove = await host.next((m) => m.type === 'board');
      expect(afterMove.board.currentRoll).toBeNull();
      const match = store.getMatchByCode(created.body.code);
      expect(store.countMoves(match.id)).toBeGreaterThanOrEqual(1);
      expect(JSON.parse(match.board).currentPlayerIndex).toBeDefined();
    }

    host.close();
    guest.close();
  });

  test('a finished match broadcasts game-over and persists the winner', async () => {
    const created = await apiRequest(port, 'POST', '/api/match/create', { token: alice.token, body: { gridSize: 5 } });
    const joined = await apiRequest(port, 'POST', '/api/match/join', { token: bob.token, body: { code: created.body.code } });
    const host = await openSocket(port, created.body.wsPath);
    const guest = await openSocket(port, joined.body.wsPath);
    host.send({ type: 'join', code: created.body.code });
    guest.send({ type: 'join', code: created.body.code });
    await host.next((m) => m.type === 'joined');
    await guest.next((m) => m.type === 'joined');

    // Drive the relay's authoritative finish path directly: set the engine
    // winner (as doMove would after the winning move), then run finishMatch.
    const room = server.relay.rooms.get(created.body.code);
    expect(room).toBeTruthy();
    room.state.winner = 0;
    const winnerUserId = houseUserId(room, 0, store);
    server.relay.finishMatch(room);

    const match = store.getMatchByCode(created.body.code);
    expect(match.status).toBe('FINISHED');
    expect(match.winner_user_id).toBe(winnerUserId);

    const over = await host.next((m) => m.type === 'game-over');
    expect(over.winner).toBe(0);
    void JSON.stringify(over); // ensure serializable
    void guest;
    host.close();
    guest.close();
  });
});

function houseUserId(room, idx, store) {
  // Re-derive the winner's user id the way finishMatch does: socket map order.
  const userIds = [...room.sockets.keys()];
  return userIds.length > idx ? userIds[idx] : null;
}

async function latestBoard(ws) {
  // return type 'board' from buffer or register a short-lived waiter
  return ws.next((m) => m.type === 'board', 200).catch(() => ({ board: {} }));
}
function task(ms) { return new Promise((r) => setTimeout(r, ms)); }