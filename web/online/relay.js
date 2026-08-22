// ============================================================
// CHOKA BARAH – Online relay
// ------------------------------------------------------------
// Bridges authenticated WebSocket peers to authoritative matches:
//  - every socket authenticates via ?token=... at upgrade (auth.js)
//  - the host creates a room through HTTP (openRoom) then attaches
//    over the socket; an invitee attaches with a room code
//  - the first attached member is player 0 (host), the second is
//    player 1 (guest -> setMatchGuest, status -> PLAYING)
//  - ROLL / MOVE messages are validated server-side through
//    game-server.js and the resulting board is broadcast to all
//    room members; the move ledger and finished results persist in
//    the sqlite store.
// ============================================================
'use strict';

const { newGame, doRoll, doMove, serializeBoard } = require('./game-server.js');

class Relay {
  constructor(httpServer, { db, auth, buildRooms = true }) {
    this.db = db;
    this.auth = auth;
    this.rooms = new Map(); // code -> room
    this.conns = new Map(); // conn -> { userId, username }
    if (buildRooms) {
      httpServer.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
    }
  }

  // ---- Socket lifecycle ----

  handleUpgrade(req, socket, head) {
    if (!(req.headers.upgrade || '').toLowerCase().includes('websocket')) { socket.destroy(); return; }
    const url = new URL(req.url, 'http://local');
    const token = url.searchParams.get('token');
    const session = token && this.auth.authenticateToken(this.db, token);
    if (!session || !session.ok) { socket.destroy(); return; }
    this.acceptSocket(req, socket, head, session);
  }

  acceptSocket(req, socket, head, session) {
    const key = req.headers['sec-websocket-key'];
    const { acceptKey, encodeFrame, encodeText, encodeClose, OP, Framer } = require('./ws.js');
    if (!key) { socket.destroy(); return; }

    const conn = {
      socket, framer: new Framer(), alive: true,
      userId: session.user.id, username: session.user.username, room: null
    };
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n` +
      // RFC 6455: echo the subprotocol only if the client offered it.
      (req.headers['sec-websocket-protocol']
        ? 'Sec-WebSocket-Protocol: chokabarah\r\n'
        : '') +
      '\r\n'
    );

    socket.on('data', (chunk) => {
      let frames;
      try { frames = conn.framer.push(chunk); }
      catch { this.close(conn, 1002); return; }
      for (const fr of frames) {
        try { this.onFrame(conn, fr); }
        catch (err) { this.close(conn, 1011); return; }
      }
    });
    socket.on('error', () => this.onError(conn));
    socket.on('close', () => this.onClose(conn));

    const heartbeat = setInterval(() => {
      if (!conn.alive) { this.close(conn, 1001); return; }
      conn.alive = false;
      try { socket.write(encodeFrame(OP.PING, Buffer.alloc(0), true)); } catch {}
    }, 30000);
    socket.on('pong', () => { conn.alive = true; });
    conn._heartbeat = heartbeat;

    this.conns.set(conn, { userId: conn.userId, username: conn.username });
    this.send(conn, { type: 'authed', user: { id: conn.userId, username: conn.username } });
  }

  onFrame(conn, fr) {
    const { OP, encodeFrame, encodeText } = require('./ws.js');
    if (fr.opcode === OP.CLOSE) { this.close(conn, 1000); return; }
    if (fr.opcode === OP.PING) { conn.socket.write(encodeFrame(OP.PONG, Buffer.alloc(0), true)); return; }
    // Browsers auto-reply to our heartbeat PING with a PONG frame; keep the
    // conn alive so the next tick does not tear down a healthy socket.
    if (fr.opcode === OP.PONG) { conn.alive = true; return; }
    if (fr.opcode !== OP.TEXT) return;
    let msg;
    try { msg = JSON.parse(fr.payload.toString('utf8')); }
    catch { this.sendErr(conn, 'bad-json'); return; }
    if (!msg || typeof msg.type !== 'string') { this.sendErr(conn, 'bad-message'); return; }
    this.handle(conn, msg);
  }

  handle(conn, msg) {
    if (process.env.RELAY_DEBUG) require('node:fs').appendFileSync(process.env.RELAY_DEBUG, `${new Date().toISOString()} ${conn.username} ${JSON.stringify(msg)}\n`);
    switch (msg.type) {
      case 'join': {
        const code = String(msg.code || '').trim().toUpperCase();
        const room = this.rooms.get(code);
        if (!room) { this.sendErr(conn, 'no-such-room'); return; }
        this.attach(conn, room);
        return;
      }
      case 'roll': {
        const room = conn.room;
        if (!room) { this.sendErr(conn, 'not-in-room'); return; }
        const res = this.ensureTurn(conn, room);
        if (res) return;
        const roll = doRoll(room.state);
        if (!roll.ok) { this.sendErr(conn, roll.reason || 'roll-failed'); return; }
        this.storeBoard(room);
        this.broadcast(room, { type: 'board', board: serializeBoard(room.state) });
        return;
      }
      case 'move': {
        const room = conn.room;
        if (!room) { this.sendErr(conn, 'not-in-room'); return; }
        const res = this.ensureTurn(conn, room);
        if (res) return;
        const mv = doMove(room.state, msg.move);
        if (!mv.ok) { this.sendErr(conn, mv.reason || 'move-failed'); return; }
        // persist the accepted move in the ledger
        const seq = (room.seq = (room.seq || 0) + 1);
        const moverIdx = this.playerIndexOf(room, conn.userId);
        try {
          this.db.appendMove(room.matchId, seq, moverIdx, JSON.stringify(msg.move || {}));
        } catch {}
        this.storeBoard(room);
        this.broadcast(room, { type: 'board', board: serializeBoard(room.state) });
        if (room.state.winner !== null) this.finishMatch(room);
        return;
      }
      case 'leave':
        this.close(conn, 1000);
        return;
      default:
        this.sendErr(conn, 'unknown-message');
    }
  }

  // ---- Room management (called from HTTP layer) ----

  openRoom({ matchId, code, gridSize }) {
    if (this.rooms.has(code)) return this.rooms.get(code);
    const room = {
      matchId, code, gridSize,
      state: newGame({ gridSize, playerNum: 2 }),
      sockets: new Map(), // userId -> conn
      seq: 0
    };
    this.rooms.set(code, room);
    return room;
  }

  // Attach an authenticated conn to a room as host or guest:
  // host = first attach, guest = second.
  attach(conn, room) {
    if (conn.room) { this.sendErr(conn, 'already-in-room'); return; }
    if (room.sockets.has(conn.userId)) { this.sendErr(conn, 'already-in-room'); return; }
    if (room.sockets.size >= room.state.playerNum) { this.sendErr(conn, 'room-full'); return; }

    const isHost = room.sockets.size === 0;
    conn.room = room;
    room.sockets.set(conn.userId, conn);

    if (isHost) {
      // Host spreads the room code; guest arrives later over the same room.
      this.send(conn, { type: 'joined', code: room.code, playerIndex: 0, gridSize: room.gridSize });
    } else {
      // First guest is player 1; persist the seat in the DB (WAITING -> PLAYING).
      this.send(conn, { type: 'joined', code: room.code, playerIndex: 1, gridSize: room.gridSize });
      try {
        this.db.setMatchGuest(room.matchId, conn.userId);
      } catch {}
    }

    this.broadcast(room, { type: 'member-count', count: room.sockets.size, playerNum: room.state.playerNum });
    this.broadcast(room, { type: 'board', board: serializeBoard(room.state) });
  }

  ensureTurn(conn, room) {
    const idx = this.playerIndexOf(room, conn.userId);
    if (idx !== room.state.currentPlayerIndex) { this.sendErr(conn, 'not-your-turn'); return 'turn'; }
    return null;
  }

  playerIndexOf(room, userId) {
    return [...room.sockets.keys()].indexOf(userId);
  }

  storeBoard(room) {
    try {
      this.db.setMatchBoard(room.matchId, JSON.stringify(serializeBoard(room.state)));
    } catch {}
  }

  finishMatch(room) {
    const idx = room.state.winner;
    const userIds = [...room.sockets.keys()];
    const winnerUserId = userIds.length > idx ? userIds[idx] : null;
    try {
      this.db.finishMatch(room.matchId, winnerUserId);
    } catch {}
    this.broadcast(room, { type: 'game-over', winner: idx, winnersUser: winnerUserId });
  }

  // ---- Connection teardown ----

  onError(conn) { this.detach(conn); try { conn.socket.destroy(); } catch {} }

  onClose(conn) { this.detach(conn); }

  detach(conn) {
    if (conn._heartbeat) { clearInterval(conn._heartbeat); conn._heartbeat = null; }
    this.conns.delete(conn);
    const room = conn.room;
    if (!room) return;
    room.sockets.delete(conn.userId);
    conn.room = null;
    if (room.sockets.size === 0) {
      this.rooms.delete(room.code);
    } else {
      this.broadcast(room, { type: 'member-count', count: room.sockets.size, playerNum: room.state.playerNum });
      this.broadcast(room, { type: 'peer-left', userId: conn.userId });
    }
  }

  close(conn, code) {
    const { encodeClose } = require('./ws.js');
    if (conn.socket.destroyed) return;
    try { conn.socket.write(encodeClose(code || 1000, '')); } catch {}
    this.detach(conn);
    setTimeout(() => { try { conn.socket.end(); } catch {} }, 30);
  }

  // Hard teardown: kill every connection and clear all timers. Used by tests
  // so no heartbeat interval survives past the mocked http server.
  shutdown() {
    for (const conn of [...this.conns.keys()]) {
      if (conn._heartbeat) { clearInterval(conn._heartbeat); conn._heartbeat = null; }
      try { conn.socket.destroy(); } catch {}
    }
    this.conns.clear();
    this.rooms.clear();
  }

  send(conn, obj) {
    if (conn.socket.destroyed) return;
    const { encodeText } = require('./ws.js');
    try { conn.socket.write(encodeText(JSON.stringify(obj))); } catch {}
  }

  sendErr(conn, code) {
    this.debug(conn.username, { type: 'error-sent', code });
    this.send(conn, { type: 'error', code });
  }

  debug(who, what) {
    if (process.env.RELAY_DEBUG) {
      require('node:fs').appendFileSync(process.env.RELAY_DEBUG, `${new Date().toISOString()} ${who} ${JSON.stringify(what)}\n`);
    }
  }

  broadcast(room, obj) {
    for (const [, c] of [...room.sockets]) this.send(c, obj);
  }
}

module.exports = { Relay };