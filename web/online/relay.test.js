'use strict';
// Unit tests for the WebSocket relay driven through a fake socket, so every
// protocol branch (handshake rejection, frame dispatch, heartbeat, teardown)
// is exercised without binding a real TCP port.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { openDb, makeStore } = require('./online-db.js');
const { registerUser } = require('./auth.js');
const { Relay } = require('./relay.js');
const { acceptKey } = require('./ws.js');
const EG = require('../game-engine.js');

// ---- fake socket / http server ----
class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.writes = [];
    this.destroyed = false;
    this.ended = false;
  }
  write(chunk) {
    this.writes.push(Buffer.from(chunk));
    return true;
  }
  destroy() { this.destroyed = true; }
  end() { this.ended = true; }
}

class ThrowingPongSocket extends FakeSocket {
  // Throws when asked to write a PONG frame so onFrame's catch (close 1011)
  // can be exercised without touching the handshake path.
  write(chunk) {
    const b = Buffer.from(chunk);
    if (b.length >= 1 && (b[0] & 0x0f) === 0xa) throw new Error('pong write failed');
    return super.write(b);
  }
}

// ---- frame builders (client -> server, masked) ----
function clientFrame(opcode, payload, masked = true) {
  const p = Buffer.from(payload);
  const first = 0x80 | opcode;
  if (masked) {
    const mask = crypto.randomBytes(4);
    const body = Buffer.alloc(p.length);
    for (let i = 0; i < p.length; i++) body[i] = p[i] ^ mask[i & 3];
    const header = Buffer.alloc(2 + 4);
    header[0] = first;
    header[1] = 0x80 | p.length;
    mask.copy(header, 2);
    return Buffer.concat([header, body]);
  }
  const header = Buffer.from([first, p.length]);
  return Buffer.concat([header, p]);
}
function clientText(obj) {
  return clientFrame(0x1, Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)));
}
function clientClose(code) {
  const p = Buffer.alloc(2);
  p.writeUInt16BE(code, 0);
  return clientFrame(0x8, p);
}
function clientPing() { return clientFrame(0x9, Buffer.alloc(0)); }
function clientPong() { return clientFrame(0xa, Buffer.alloc(0)); }
function clientBinary() { return clientFrame(0x2, Buffer.from('x')); }

// ---- decode server frames (never masked) ----
function decodeServer(buf) {
  const out = [];
  let off = 0;
  while (buf.length >= off + 2) {
    const b0 = buf[off];
    const b1 = buf[off + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let cur = off + 2;
    if (len === 126) {
      if (buf.length < cur + 2) break;
      len = buf.readUInt16BE(cur);
      cur += 2;
    } else if (len === 127) {
      if (buf.length < cur + 8) break;
      len = Number(buf.readBigUInt64BE(cur));
      cur += 8;
    }
    const mask = masked ? buf.subarray(cur, cur + 4) : null;
    cur += masked ? 4 : 0;
    if (buf.length < cur + len) break;
    const payload = Buffer.alloc(len);
    for (let i = 0; i < len; i++) payload[i] = masked ? buf[cur + i] ^ mask[i & 3] : buf[cur + i];
    out.push({ opcode, payload });
    off = cur + len;
  }
  return out;
}

// Frame bytes = everything written AFTER the HTTP handshake write (the first
// write containing the status line), so handshake text never pollutes frames.
function frameBytes(socket) {
  const idx = socket.writes.findIndex((w) => w.toString('utf8').startsWith('HTTP/1.1 101'));
  const start = idx === -1 ? 0 : idx + 1;
  return Buffer.concat(socket.writes.slice(start));
}

// Server messages = JSON text frames after the handshake.
function received(socket) {
  const msgs = [];
  for (const fr of decodeServer(frameBytes(socket))) {
    if (fr.opcode === 0x1) msgs.push(JSON.parse(fr.payload.toString('utf8')));
  }
  return msgs;
}

function lastCloseCode(socket) {
  let code = null;
  for (const fr of decodeServer(frameBytes(socket))) {
    if (fr.opcode === 0x8 && fr.payload.length >= 2) code = fr.payload.readUInt16BE(0);
  }
  return code;
}

function handshakeOk(socket) {
  return socket.writes.some((w) => w.toString('utf8').includes('101 Switching Protocols'));
}

// Build an upgrade request. Tokens are NOT part of the URL anymore; identity
// arrives as the first message after the handshake completes.
function upgradeReq({ upgrade = true, key = true, protocol = false } = {}) {
  const headers = {};
  if (upgrade) headers.upgrade = 'websocket';
  if (key) headers['sec-websocket-key'] = 'dGhlIHNhbXBsZSBub25jZQ==';
  if (protocol) headers['sec-websocket-protocol'] = 'chokabarah';
  return { headers, url: '/ws' };
}

// ---- suite ----
let store;
let relay;

function freshRelay(opts = {}) {
  relay = new Relay({ on: () => {} }, Object.assign(
    { db: store, auth: { authenticateToken: () => null }, buildRooms: false }, opts));
  relay.auth = require('./auth.js');
  return relay;
}

beforeEach(() => {
  store = makeStore(openDb(':memory:'));
});

afterEach(() => {
  if (relay) relay.shutdown();
  relay = null;
  delete process.env.RELAY_DEBUG;
});

async function makeUser(name) {
  const res = await registerUser(store, name, 'secret123');
  if (!res.ok) throw new Error(`register failed: ${res.error}`);
  return res;
}

function openRoom(code, hostUserId, invitedUserId = null) {
  store.createMatch({ code, gridSize: 5, playerCount: 2, hostUserId });
  relay.openRoom({ matchId: store.getMatchByCode(code).id, code, gridSize: 5, hostUserId, invitedUserId });
  return relay.rooms.get(code);
}

// Connect + authenticate in one step (mirrors the browser client). Pass
// token = null to keep the conn unauthenticated for pre-auth protocol tests.
function connect(token, SocketImpl = FakeSocket, opts) {
  const sock = new SocketImpl();
  relay.handleUpgrade(upgradeReq(opts), sock, null);
  if (token != null) {
    sock.emit('data', clientText({ type: 'auth', token }));
  }
  return sock;
}

describe('Relay handshake', () => {
  test('rejects a non-websocket upgrade', async () => {
    const u = await makeUser('alice');
    relay = freshRelay();
    const sock = new FakeSocket();
    relay.handleUpgrade({ headers: {}, url: `/ws?token=${u.token}` }, sock, null);
    expect(sock.destroyed).toBe(true);
    expect(sock.writes).toHaveLength(0);
  });

  test('handshakes without tokens are accepted, then closed 1008 on bad auth', async () => {
    relay = freshRelay();

    // No URL credentials anymore: the upgrade itself succeeds.
    const bad = new FakeSocket();
    relay.handleUpgrade(upgradeReq(), bad, null);
    expect(bad.destroyed).toBe(false);
    expect(handshakeOk(bad)).toBe(true);

    // A garbage token in the first message closes the conn (policy 1008).
    bad.emit('data', clientText({ type: 'auth', token: 'not-a-real-token' }));
    expect(lastCloseCode(bad)).toBe(1008);
    expect(relay.conns.size).toBe(0);
  });

  test('pre-auth frames other than auth close the conn with 1008', async () => {
    const u = await makeUser('alice');
    relay = freshRelay();
    const sock = connect(null); // unauthenticated
    expect(handshakeOk(sock)).toBe(true);

    // A join attempt before authenticating is a protocol violation.
    sock.emit('data', clientText({ type: 'join', code: 'ROOM01' }));
    expect(lastCloseCode(sock)).toBe(1008);

    // Malformed JSON pre-auth likewise.
    const sock2 = connect(null);
    sock2.emit('data', clientText('{not json'));
    expect(lastCloseCode(sock2)).toBe(1008);
  });

  test('valid first-message auth yields the authed identity', async () => {
    const u = await makeUser('alice');
    relay = freshRelay();
    const sock = connect(u.token);
    const msgs = received(sock);
    expect(msgs[0].type).toBe('authed');
    expect(msgs[0].user.username).toBe('alice');
    expect(relay.conns.size).toBe(1);
  });

  test('rejects a request without a Sec-WebSocket-Key', async () => {
    const u = await makeUser('alice');
    relay = freshRelay();
    const sock = new FakeSocket();
    relay.handleUpgrade(upgradeReq({ key: false }), sock, null);
    expect(sock.destroyed).toBe(true);
  });

  test('accepts a valid upgrade and writes the 101 handshake', async () => {
    const u = await makeUser('alice');
    relay = freshRelay();
    const sock = connect(u.token);
    expect(sock.destroyed).toBe(false);
    expect(handshakeOk(sock)).toBe(true);
    const msgs = received(sock);
    expect(msgs[0].type).toBe('authed');
    expect(msgs[0].user.username).toBe('alice');
  });

  test('echoes the subprotocol only when the client offers it', async () => {
    const u = await makeUser('alice');
    relay = freshRelay();
    const plain = connect(u.token);
    const plainText = Buffer.concat(plain.writes).toString('utf8');
    expect(plainText).not.toContain('Sec-WebSocket-Protocol');

    const withProto = connect(u.token, FakeSocket, { protocol: true });
    const protoText = Buffer.concat(withProto.writes).toString('utf8');
    expect(protoText).toContain('Sec-WebSocket-Protocol: chokabarah');
    expect(protoText).toContain(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='));
  });
  test('cookie-authenticated upgrades seat the conn immediately and enforce the per-user cap', async () => {
    const alice = await makeUser('alice');
    relay = freshRelay();
    openRoom('ROOM01', alice.user.id);

    const mkCookieConn = () => {
      const sock = new FakeSocket();
      relay.handleUpgrade({
        headers: {
          upgrade: 'websocket',
          'sec-websocket-key': 'k',
          cookie: `cb_session=${alice.token}`
        }
      }, sock, null);
      return sock;
    };

    const s1 = mkCookieConn();
    const s2 = mkCookieConn();
    const s3 = mkCookieConn();
    expect(relay.conns.size).toBe(3);
    // All three are authenticated at handshake (authed message sent).
    for (const s of [s1, s2, s3]) {
      expect(received(s)[0].type).toBe('authed');
    }

    // Fourth socket for the same account trips the upgrade-time cap.
    const s4 = mkCookieConn();
    expect(lastCloseCode(s4)).toBe(1013);
    expect(s1.destroyed).toBe(false);
    expect(relay.conns.size).toBe(3);

    // An INVALID cookie still handshakes but stays unauthenticated.
    const stranger = new FakeSocket();
    relay.handleUpgrade({
      headers: {
        upgrade: 'websocket',
        'sec-websocket-key': 'k2',
        cookie: 'cb_session=garbage'
      }
    }, stranger, null);
    expect(handshakeOk(stranger)).toBe(true);
    expect(stranger.destroyed).toBe(false);
    expect(received(stranger).length).toBe(0); // no authed message
    // And the pre-auth protocol guard applies: any frame other than auth.
    stranger.emit('data', clientText({ type: 'roll' }));
    expect(lastCloseCode(stranger)).toBe(1008);
  });

  test('malformed cookie headers are tolerated during upgrade', () => {
    const alice = { user: { id: 1, username: 'x' } };
    void alice;
    relay = freshRelay();
    const sock = new FakeSocket();
    relay.handleUpgrade({ headers: { upgrade: 'websocket', 'sec-websocket-key': 'k', cookie: 'garbage' } }, sock, null);
    expect(sock.destroyed).toBe(false); // parsed as no session -> falls to legacy seating
  });

  test('caps concurrent sockets per account', async () => {
    const u = await makeUser('alice');
    relay = freshRelay();
    const s1 = connect(u.token);
    const s2 = connect(u.token);
    const s3 = connect(u.token);
    expect(relay.conns.size).toBe(3);
    const s4 = connect(u.token); // beyond MAX_SOCKETS_PER_USER -> closed 1013
    expect(lastCloseCode(s4)).toBe(1013);
    expect(s1.destroyed).toBe(false);
    expect(relay.conns.size).toBe(3);
  });
});

describe('Relay frame dispatch', () => {
  test('closes with 1002 on a malformed (unmasked) frame', async () => {
    const u = await makeUser('alice');
    relay = freshRelay();
    const sock = connect(u.token);
    sock.emit('data', clientFrame(0x1, Buffer.from('hi'), false));
    expect(lastCloseCode(sock)).toBe(1002);
  });

  test('closes with 1011 when frame handling throws', async () => {
    const u = await makeUser('alice');
    relay = freshRelay();
    const sock = connect(u.token, ThrowingPongSocket);
    sock.emit('data', clientPing());
    expect(lastCloseCode(sock)).toBe(1011);
  });

  test('closes cleanly on a CLOSE frame', async () => {
    const u = await makeUser('alice');
    relay = freshRelay();
    const sock = connect(u.token);
    sock.emit('data', clientClose(1000));
    expect(lastCloseCode(sock)).toBe(1000);
  });

  test('answers PING with PONG and ignores non-text frames', async () => {
    const u = await makeUser('alice');
    relay = freshRelay();
    const sock = connect(u.token);
    sock.emit('data', clientPing());
    const opcodes = decodeServer(frameBytes(sock)).map((f) => f.opcode);
    expect(opcodes).toContain(0xa);
    const before = received(sock).length;
    sock.emit('data', clientBinary());
    expect(received(sock)).toHaveLength(before);
  });

  test('reports bad JSON and bad message shapes', async () => {
    const u = await makeUser('alice');
    relay = freshRelay();
    const sock = connect(u.token);
    sock.emit('data', clientText('{not json'));
    expect(received(sock).at(-1)).toEqual({ type: 'error', code: 'bad-json' });
    sock.emit('data', clientText('{}'));
    expect(received(sock).at(-1)).toEqual({ type: 'error', code: 'bad-message' });
    sock.emit('data', clientText(JSON.stringify({ type: 42 })));
    expect(received(sock).at(-1)).toEqual({ type: 'error', code: 'bad-message' });
  });

  test('replies unknown-message for unrecognized types', async () => {
    const u = await makeUser('alice');
    relay = freshRelay();
    const sock = connect(u.token);
    sock.emit('data', clientText({ type: 'dance' }));
    expect(received(sock).at(-1)).toEqual({ type: 'error', code: 'unknown-message' });
  });
});

describe('Relay room attach', () => {
  test('joining an unknown room errors', async () => {
    const u = await makeUser('alice');
    relay = freshRelay();
    const sock = connect(u.token);
    sock.emit('data', clientText({ type: 'join', code: 'NOPE99' }));
    expect(received(sock).at(-1)).toEqual({ type: 'error', code: 'no-such-room' });
    // A join message with no code at all takes the same path.
    sock.emit('data', clientText({ type: 'join' }));
    expect(received(sock).at(-1)).toEqual({ type: 'error', code: 'no-such-room' });
  });

  test('host joins first as player 0, guest second as player 1', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    relay = freshRelay();
    openRoom('ROOM01', alice.user.id);

    const host = connect(alice.token);
    host.emit('data', clientText({ type: 'join', code: 'room01' })); // lowercase code is normalized
    const hostMsgs = received(host);
    expect(hostMsgs.some((m) => m.type === 'joined' && m.playerIndex === 0)).toBe(true);
    expect(hostMsgs.some((m) => m.type === 'member-count' && m.count === 1)).toBe(true);
    expect(hostMsgs.some((m) => m.type === 'board')).toBe(true);

    const guest = connect(bob.token);
    guest.emit('data', clientText({ type: 'join', code: 'ROOM01' }));
    expect(received(guest).some((m) => m.type === 'joined' && m.playerIndex === 1)).toBe(true);
    expect(received(host).some((m) => m.type === 'member-count' && m.count === 2)).toBe(true);
    expect(store.getMatchByCode('ROOM01').status).toBe('PLAYING');
  });

  test('rejects double-join on the same conn', async () => {
    const alice = await makeUser('alice');
    relay = freshRelay();
    openRoom('ROOM01', alice.user.id);
    const host = connect(alice.token);
    host.emit('data', clientText({ type: 'join', code: 'ROOM01' }));
    host.emit('data', clientText({ type: 'join', code: 'ROOM01' }));
    expect(received(host).at(-1)).toEqual({ type: 'error', code: 'already-in-room' });
  });

  test('rejects a second socket from the same user', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    relay = freshRelay();
    openRoom('ROOM01', alice.user.id);
    const host = connect(alice.token);
    host.emit('data', clientText({ type: 'join', code: 'ROOM01' }));
    const guest = connect(bob.token);
    guest.emit('data', clientText({ type: 'join', code: 'ROOM01' }));
    // alice reconnects -> already seated via a different socket
    const again = connect(alice.token);
    again.emit('data', clientText({ type: 'join', code: 'ROOM01' }));
    expect(received(again).at(-1)).toEqual({ type: 'error', code: 'already-in-room' });
  });

  test('guest attaching before the host still takes seat 1', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    relay = freshRelay();
    openRoom('ROOM01', alice.user.id);

    // Guest connects FIRST — the host seat must stay reserved for the host.
    const guest = connect(bob.token);
    guest.emit('data', clientText({ type: 'join', code: 'ROOM01' }));
    expect(received(guest).some((m) => m.type === 'joined' && m.playerIndex === 1)).toBe(true);
    expect(store.getMatchByCode('ROOM01').guest_user_id).toBe(bob.user.id);

    const host = connect(alice.token);
    host.emit('data', clientText({ type: 'join', code: 'ROOM01' }));
    expect(received(host).some((m) => m.type === 'joined' && m.playerIndex === 0)).toBe(true);
    expect(store.getMatchByCode('ROOM01').status).toBe('PLAYING');

    // Turn authority follows identity, not arrival order.
    guest.emit('data', clientText({ type: 'roll' }));
    expect(received(guest).at(-1)).toEqual({ type: 'error', code: 'not-your-turn' });
  });

  test('a reconnecting host keeps seat 0 and never overwrites the guest record', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    relay = freshRelay();
    openRoom('ROOM01', alice.user.id);

    const host = connect(alice.token);
    host.emit('data', clientText({ type: 'join', code: 'ROOM01' }));
    const guest = connect(bob.token);
    guest.emit('data', clientText({ type: 'join', code: 'ROOM01' }));

    // Host's socket drops; the guest keeps the room alive.
    host.emit('close');
    expect(relay.rooms.get('ROOM01')).toBeTruthy();

    const hostAgain = connect(alice.token);
    hostAgain.emit('data', clientText({ type: 'join', code: 'ROOM01' }));
    expect(received(hostAgain).some((m) => m.type === 'joined' && m.playerIndex === 0)).toBe(true);

    const match = store.getMatchByCode('ROOM01');
    expect(match.guest_user_id).toBe(bob.user.id); // not overwritten by the host
    expect(match.host_user_id).toBe(alice.user.id);

    // And the restored host is player 0 for turn purposes.
    const room = relay.rooms.get('ROOM01');
    expect(relay.playerIndexOf(room, alice.user.id)).toBe(0);
    expect(relay.playerIndexOf(room, bob.user.id)).toBe(1);
  });

  test('a second non-host cannot steal the vacant host seat', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const carol = await makeUser('carol');
    relay = freshRelay();
    openRoom('ROOM01', alice.user.id);

    const guest = connect(bob.token);
    guest.emit('data', clientText({ type: 'join', code: 'ROOM01' }));
    expect(received(guest).some((m) => m.type === 'joined')).toBe(true);

    // Host never attached; carol must NOT be seated as "player 0".
    const intruder = connect(carol.token);
    intruder.emit('data', clientText({ type: 'join', code: 'ROOM01' }));
    expect(received(intruder).at(-1)).toEqual({ type: 'error', code: 'room-full' });
  });

  test('the invited guest seat rejects everyone but the invitee', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const carol = await makeUser('carol');
    relay = freshRelay();
    openRoom('ROOM01', alice.user.id, bob.user.id); // bob is the invited guest

    // A stranger who somehow knows the code cannot take the guest seat.
    const intruder = connect(carol.token);
    intruder.emit('data', clientText({ type: 'join', code: 'ROOM01' }));
    expect(received(intruder).at(-1)).toEqual({ type: 'error', code: 'not-invited' });
    expect(relay.rooms.get('ROOM01').sockets.size).toBe(0);

    // The invitee still gets the seat.
    const guest = connect(bob.token);
    guest.emit('data', clientText({ type: 'join', code: 'ROOM01' }));
    expect(received(guest).some((m) => m.type === 'joined' && m.playerIndex === 1)).toBe(true);
  });

  test('rejects a third player when the room is full', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const carol = await makeUser('carol');
    relay = freshRelay();
    openRoom('ROOM01', alice.user.id);
    const host = connect(alice.token);
    host.emit('data', clientText({ type: 'join', code: 'ROOM01' }));
    const guest = connect(bob.token);
    guest.emit('data', clientText({ type: 'join', code: 'ROOM01' }));
    const third = connect(carol.token);
    third.emit('data', clientText({ type: 'join', code: 'ROOM01' }));
    expect(received(third).at(-1)).toEqual({ type: 'error', code: 'room-full' });
  });

  test('openRoom returns the existing room for a duplicate code', async () => {
    const alice = await makeUser('alice');
    relay = freshRelay();
    store.createMatch({ code: 'ROOM01', gridSize: 5, playerCount: 2, hostUserId: alice.user.id });
    const a = relay.openRoom({ matchId: 1, code: 'ROOM01', gridSize: 5 });
    const b = relay.openRoom({ matchId: 1, code: 'ROOM01', gridSize: 5 });
    expect(a).toBe(b);
  });

  test('rooms opened without a known host fall back to arrival-order seating', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    relay = freshRelay();
    relay.openRoom({ matchId: 1, code: 'LEGACY1', gridSize: 5 }); // no hostUserId
    const first = connect(alice.token);
    first.emit('data', clientText({ type: 'join', code: 'LEGACY1' }));
    expect(received(first).some((m) => m.type === 'joined' && m.playerIndex === 0)).toBe(true);
    const second = connect(bob.token);
    second.emit('data', clientText({ type: 'join', code: 'LEGACY1' }));
    expect(received(second).some((m) => m.type === 'joined' && m.playerIndex === 1)).toBe(true);
  });

  test('playerIndexOf yields -1 for a user without a seat', async () => {
    const alice = await makeUser('alice');
    relay = freshRelay();
    const room = openRoom('ROOM01', alice.user.id);
    expect(relay.playerIndexOf(room, alice.user.id)).toBe(-1);
    expect(relay.playerIndexOf(room, 99999)).toBe(-1);
  });
});

describe('Relay roll/move enforcement', () => {
  test('roll and move outside a room error', async () => {
    const alice = await makeUser('alice');
    relay = freshRelay();
    const sock = connect(alice.token);
    sock.emit('data', clientText({ type: 'roll' }));
    expect(received(sock).at(-1)).toEqual({ type: 'error', code: 'not-in-room' });
    sock.emit('data', clientText({ type: 'move', move: { pawnIds: [0], targetCoords: [1, 1] } }));
    expect(received(sock).at(-1)).toEqual({ type: 'error', code: 'not-in-room' });
  });

  test('guest rolling out of turn is rejected', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    relay = freshRelay();
    openRoom('ROOM01', alice.user.id);
    const host = connect(alice.token);
    host.emit('data', clientText({ type: 'join', code: 'ROOM01' }));
    const guest = connect(bob.token);
    guest.emit('data', clientText({ type: 'join', code: 'ROOM01' }));
    guest.emit('data', clientText({ type: 'roll' }));
    expect(received(guest).at(-1)).toEqual({ type: 'error', code: 'not-your-turn' });
    guest.emit('data', clientText({ type: 'move', move: { pawnIds: [0], targetCoords: [1, 1] } }));
    expect(received(guest).at(-1)).toEqual({ type: 'error', code: 'not-your-turn' });
  });

  test('a move before rolling errors', async () => {
    const alice = await makeUser('alice');
    relay = freshRelay();
    openRoom('ROOM01', alice.user.id);
    const host = connect(alice.token);
    host.emit('data', clientText({ type: 'join', code: 'ROOM01' }));
    host.emit('data', clientText({ type: 'move', move: { pawnIds: [0], targetCoords: [1, 1] } }));
    expect(received(host).at(-1)).toEqual({ type: 'error', code: 'no-roll' });
  });

  test('a successful roll broadcasts the board and persists it', async () => {
    const alice = await makeUser('alice');
    relay = freshRelay();
    const room = openRoom('ROOM01', alice.user.id);
    room.state.rng = () => 0; // force a fixed roll
    const host = connect(alice.token);
    host.emit('data', clientText({ type: 'join', code: 'ROOM01' }));
    const before = received(host).length;
    host.emit('data', clientText({ type: 'roll' }));
    const msgs = received(host).slice(before);
    const board = msgs.find((m) => m.type === 'board');
    expect(board).toBeTruthy();
    expect(board.board.pawns.length).toBe(8);
    const match = store.getMatchByCode('ROOM01');
    expect(JSON.parse(match.board).pawns).toBeTruthy();
  });

  test('game-over roll is rejected', async () => {
    const alice = await makeUser('alice');
    relay = freshRelay();
    const room = openRoom('ROOM01', alice.user.id);
    room.state.winner = 0;
    const host = connect(alice.token);
    host.emit('data', clientText({ type: 'join', code: 'ROOM01' }));
    host.emit('data', clientText({ type: 'roll' }));
    expect(received(host).at(-1)).toEqual({ type: 'error', code: 'game-over' });
  });

  test('a winning move finishes the match and broadcasts game-over', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    relay = freshRelay();
    const room = openRoom('ROOM01', alice.user.id);

    // Seed a near-win board: player 0 has three FINISHED pawns plus one pawn
    // one step from home; a score-1 roll reaches it and wins the game.
    room.state.pawns = [
      { id: 0, playerIndex: 0, state: 'FINISHED', pathIndex: 24 },
      { id: 1, playerIndex: 0, state: 'FINISHED', pathIndex: 24 },
      { id: 2, playerIndex: 0, state: 'FINISHED', pathIndex: 24 },
      { id: 3, playerIndex: 0, state: 'ON_TRACK', pathIndex: 23 },
      { id: 4, playerIndex: 1, state: 'HOME_BASE', pathIndex: -1 },
      { id: 5, playerIndex: 1, state: 'HOME_BASE', pathIndex: -1 },
      { id: 6, playerIndex: 1, state: 'HOME_BASE', pathIndex: -1 },
      { id: 7, playerIndex: 1, state: 'HOME_BASE', pathIndex: -1 }
    ];
    room.state.hasCapturedOpponent = { 0: true, 1: false };
    room.state.currentRoll = { score: 1, isExtraRoll: false, scoreText: 'one', shells: [true, false, false, false] };
    room.state.validMoves = EG.calculateValidMoves(5, room.state.pawns, 0, room.state.hasCapturedOpponent, 1);

    const host = connect(alice.token);
    host.emit('data', clientText({ type: 'join', code: 'ROOM01' }));
    const guest = connect(bob.token);
    guest.emit('data', clientText({ type: 'join', code: 'ROOM01' }));

    host.emit('data', clientText({ type: 'move', move: { pawnIds: [3], targetCoords: [2, 2] } }));

    const hostMsgs = received(host);
    const over = hostMsgs.find((m) => m.type === 'game-over');
    expect(over).toBeTruthy();
    expect(over.winner).toBe(0);
    expect(over.winnersUser).toBe(alice.user.id);
    expect(received(guest).some((m) => m.type === 'game-over')).toBe(true);
    expect(store.getMatchByCode('ROOM01').status).toBe('FINISHED');
    expect(store.getMatchByCode('ROOM01').winner_user_id).toBe(alice.user.id);
    expect(store.countMoves(store.getMatchByCode('ROOM01').id)).toBe(1);
  });

  test('an illegal move is rejected', async () => {
    const alice = await makeUser('alice');
    relay = freshRelay();
    const room = openRoom('ROOM01', alice.user.id);
    room.state.rng = () => 0.9;
    const host = connect(alice.token);
    host.emit('data', clientText({ type: 'join', code: 'ROOM01' }));
    host.emit('data', clientText({ type: 'roll' }));
    host.emit('data', clientText({ type: 'move', move: { pawnIds: [0], targetCoords: [99, 99] } }));
    expect(received(host).at(-1)).toEqual({ type: 'error', code: 'illegal-move' });
  });

  test('a legal non-winning move applies without ending the game', async () => {
    const alice = await makeUser('alice');
    relay = freshRelay();
    const room = openRoom('ROOM01', alice.user.id);

    // Player 0 has one pawn mid-track; a score-1 roll advances it to path
    // index 6 — well short of home, so no winner is set.
    room.state.pawns[0].state = 'ON_TRACK';
    room.state.pawns[0].pathIndex = 5;
    room.state.hasCapturedOpponent = { 0: true, 1: false };
    room.state.currentRoll = { shells: [true, false, false, false], score: 1, isExtraRoll: false, scoreText: 'Score: 1' };
    room.state.validMoves = EG.calculateValidMoves(5, room.state.pawns, 0, room.state.hasCapturedOpponent, 1);
    expect(room.state.validMoves.length).toBeGreaterThan(0);

    const host = connect(alice.token);
    host.emit('data', clientText({ type: 'join', code: 'ROOM01' }));
    const mv = room.state.validMoves[0];
    host.emit('data', clientText({
      type: 'move',
      move: { pawnIds: mv.grpPawns.map((p) => p.id), targetCoords: mv.targetCoords }
    }));

    const msgs = received(host);
    expect(msgs.some((m) => m.type === 'game-over')).toBe(false);
    const board = msgs.filter((m) => m.type === 'board').at(-1);
    expect(board.board.winner).toBeNull();
    // No capture / no extra roll -> turn passed to player 1.
    expect(board.board.currentPlayerIndex).toBe(1);
  });

  test('persistence failures do not break the game flow', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    relay = freshRelay();
    const room = openRoom('ROOM01', alice.user.id);
    room.state.rng = () => 0;
    const origAppend = store.appendMove;
    const origBoard = store.setMatchBoard;
    const origGuest = store.setMatchGuest;
    const origFinish = store.finishMatch;
    store.appendMove = () => { throw new Error('db down'); };
    store.setMatchBoard = () => { throw new Error('db down'); };
    store.setMatchGuest = () => { throw new Error('db down'); };
    store.finishMatch = () => { throw new Error('db down'); };

    const host = connect(alice.token);
    host.emit('data', clientText({ type: 'join', code: 'ROOM01' }));
    const guest = connect(bob.token);
    guest.emit('data', clientText({ type: 'join', code: 'ROOM01' }));
    expect(received(guest).some((m) => m.type === 'joined')).toBe(true);
    host.emit('data', clientText({ type: 'roll' }));
    expect(received(host).some((m) => m.type === 'board')).toBe(true);

    store.appendMove = origAppend;
    store.setMatchBoard = origBoard;
    store.setMatchGuest = origGuest;
    store.finishMatch = origFinish;
  });
});

describe('Relay teardown', () => {
  test('a leave message closes the conn cleanly', async () => {
    const alice = await makeUser('alice');
    relay = freshRelay();
    openRoom('ROOM01', alice.user.id);
    const host = connect(alice.token);
    host.emit('data', clientText({ type: 'join', code: 'ROOM01' }));
    host.emit('data', clientText({ type: 'leave' }));
    expect(lastCloseCode(host)).toBe(1000);
  });

  test('socket error detaches and destroys the conn', async () => {
    const alice = await makeUser('alice');
    relay = freshRelay({ resumeGraceMs: 20 });
    openRoom('ROOM01', alice.user.id);
    const host = connect(alice.token);
    host.emit('data', clientText({ type: 'join', code: 'ROOM01' }));
    host.emit('error', new Error('boom'));
    expect(host.destroyed).toBe(true);
    // Room survives the grace window, then is discarded.
    expect(relay.rooms.get('ROOM01')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 60));
    expect(relay.rooms.get('ROOM01')).toBeUndefined();
  });

  test('closing a conn that never joined just detaches it', async () => {
    const alice = await makeUser('alice');
    relay = freshRelay();
    const sock = connect(alice.token);
    sock.emit('close');
    expect(relay.conns.size).toBe(0);
  });

  test('error followed by close tears down exactly once without crashing', async () => {
    const alice = await makeUser('alice');
    relay = freshRelay();
    const sock = connect(alice.token);
    sock.emit('error', new Error('boom')); // detach #1: clears the heartbeat timer
    sock.emit('close');                    // detach #2: heartbeat already gone
    expect(relay.conns.size).toBe(0);
  });

  test('close without an explicit code defaults to 1000', async () => {
    const alice = await makeUser('alice');
    relay = freshRelay();
    const sock = connect(alice.token);
    const conn = [...relay.conns.keys()][0];
    relay.close(conn);
    expect(lastCloseCode(sock)).toBe(1000);
  });

  test('shutdown tolerates a conn whose heartbeat timer is already gone', async () => {
    const alice = await makeUser('alice');
    relay = freshRelay();
    const sock = connect(alice.token);
    const conn = [...relay.conns.keys()][0];
    // Simulate a detached-then-reused conn: kill the real timer, keep the
    // membership, and let shutdown handle the missing handle gracefully.
    clearInterval(conn._heartbeat);
    conn._heartbeat = null;
    relay.shutdown();
    expect(sock.destroyed).toBe(true);
  });

  test('closing the last member keeps the room for the grace window, then discards it', async () => {
    const alice = await makeUser('alice');
    relay = freshRelay({ resumeGraceMs: 20 });
    openRoom('ROOM01', alice.user.id);
    const host = connect(alice.token);
    host.emit('data', clientText({ type: 'join', code: 'ROOM01' }));
    host.emit('close');
    // Within the grace window the room (and its board) survives.
    expect(relay.rooms.get('ROOM01')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 60));
    expect(relay.rooms.get('ROOM01')).toBeUndefined();
  });

  test('rejoining during the grace window cancels the close timer', async () => {
    const alice = await makeUser('alice');
    relay = freshRelay({ resumeGraceMs: 40 });
    openRoom('ROOM01', alice.user.id);
    const host = connect(alice.token);
    host.emit('data', clientText({ type: 'join', code: 'ROOM01' }));
    host.emit('close'); // room enters grace
    // Rejoin before expiry.
    const again = connect(alice.token);
    again.emit('data', clientText({ type: 'join', code: 'ROOM01' }));
    expect(again.destroyed).toBe(false);
    await new Promise((r) => setTimeout(r, 80));
    expect(relay.rooms.has('ROOM01')).toBe(true);
  });

  test('leaving an occupied room broadcasts member-count and peer-left', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    relay = freshRelay();
    openRoom('ROOM01', alice.user.id);
    const host = connect(alice.token);
    host.emit('data', clientText({ type: 'join', code: 'ROOM01' }));
    const guest = connect(bob.token);
    guest.emit('data', clientText({ type: 'join', code: 'ROOM01' }));
    const guestBefore = received(guest).length;
    host.emit('close');
    const guestMsgs = received(guest).slice(guestBefore);
    expect(guestMsgs.some((m) => m.type === 'member-count' && m.count === 1)).toBe(true);
    expect(guestMsgs.some((m) => m.type === 'peer-left' && m.userId === alice.user.id)).toBe(true);
  });

  test('close skips a socket that is already destroyed', async () => {
    const alice = await makeUser('alice');
    relay = freshRelay();
    const sock = connect(alice.token);
    sock.writes = [];
    sock.destroyed = true;
    relay.close(relay.conns.keys().next().value, 1000);
    expect(frameBytes(sock)).toHaveLength(0);
  });

  test('send skips a destroyed socket', async () => {
    const alice = await makeUser('alice');
    relay = freshRelay();
    const sock = connect(alice.token);
    sock.writes = [];
    const conn = relay.conns.keys().next().value;
    conn.socket.destroyed = true;
    relay.send(conn, { type: 'x' });
    expect(frameBytes(sock)).toHaveLength(0);
  });

  test('finishMatch with a winner index beyond the socket map falls back to null', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    relay = freshRelay();
    const room = openRoom('ROOM01', alice.user.id);
    const host = connect(alice.token);
    host.emit('data', clientText({ type: 'join', code: 'ROOM01' }));
    const guest = connect(bob.token);
    guest.emit('data', clientText({ type: 'join', code: 'ROOM01' }));
    room.state.winner = 5;
    relay.finishMatch(room);
    const over = received(guest).find((m) => m.type === 'game-over');
    expect(over).toBeTruthy();
    expect(over.winner).toBe(5);
    expect(over.winnersUser).toBeNull();
  });

  test('heartbeat pings a live conn and closes a dead one', async () => {
    jest.useFakeTimers();
    try {
      const alice = await makeUser('alice');
      relay = freshRelay();
      const sock = connect(alice.token);
      jest.advanceTimersByTime(30000);
      const first = frameBytes(sock);
      expect(decodeServer(first).some((f) => f.opcode === 0x9)).toBe(true);
      jest.advanceTimersByTime(30000);
      expect(lastCloseCode(sock)).toBe(1001);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a PONG reply keeps the conn alive across heartbeat ticks', async () => {
    jest.useFakeTimers();
    try {
      const alice = await makeUser('alice');
      relay = freshRelay();
      const sock = connect(alice.token);

      // Tick 1: server pings, conn marked stale; browser auto-replies PONG.
      jest.advanceTimersByTime(30000);
      sock.emit('data', clientPong());

      // Tick 2 would have closed the conn before the PONG fix — it must not.
      for (let i = 0; i < 5; i++) {
        jest.advanceTimersByTime(30000);
        sock.emit('data', clientPong());
      }
      const msgs = received(sock);
      expect(msgs[0].type).toBe('authed');

      // Once the replies stop, the next tick tears the conn down.
      jest.advanceTimersByTime(60000);
      expect(lastCloseCode(sock)).toBe(1001);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('Relay debug logging', () => {
  test('RELAY_DEBUG writes handled messages and errors to a file', async () => {
    const alice = await makeUser('alice');
    const logFile = path.join(os.tmpdir(), `relay-debug-${Date.now()}.log`);
    process.env.RELAY_DEBUG = logFile;
    relay = freshRelay();
    const sock = connect(alice.token);
    sock.emit('data', clientText({ type: 'roll' }));
    sock.emit('data', clientText({ type: 'unknown-thing' }));
    const log = fs.readFileSync(logFile, 'utf8');
    expect(log).toContain('alice');
    expect(log).toContain('roll');
    expect(log).toContain('unknown-thing');
    fs.unlinkSync(logFile);
  });
});
