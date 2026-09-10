// ============================================================
// CHOKA BARAH – Online relay
// ------------------------------------------------------------
// Bridges authenticated WebSocket peers to authoritative matches:
//  - every socket authenticates via ?token=... at upgrade (auth.js)
//  - the host creates a room through HTTP (openRoom) then attaches
//    over the socket; an invitee attaches with a room code
//  - seats are identity-based: host_user_id always owns seat 0, the
//    first non-host to attach takes seat 1 (setMatchGuest, status ->
//    PLAYING); a reconnecting player keeps their original seat
//  - ROLL / MOVE messages are validated server-side through
//    game-server.js and the resulting board is broadcast to all
//    room members; the move ledger and finished results persist in
//    the sqlite store.
// ============================================================
'use strict';

const { newGame, doRoll, doMove, serializeBoard } = require('./game-server.js');

// Concurrent WebSocket connections allowed per authenticated account.
const MAX_SOCKETS_PER_USER = 3;

class Relay {
  constructor(httpServer, { db, auth, buildRooms = true, resumeGraceMs = 90 * 1000 } = {}) {
    this.db = db;
    this.auth = auth;
    // How long an emptied room is kept around for reconnecting players
    // before its state is discarded.
    this.resumeGraceMs = resumeGraceMs;
    this.rooms = new Map(); // code -> room
    this.conns = new Map(); // authenticated conn -> { userId, username }
    this.allConns = new Set(); // every accepted socket incl. pre-auth (teardown)
    if (buildRooms) {
      httpServer.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
    }
  }

  // ---- Socket lifecycle ----

  handleUpgrade(req, socket, head) {
    if (!(req.headers.upgrade || '').toLowerCase().includes('websocket')) { socket.destroy(); return; }
    // Preferred identity source: the HttpOnly session cookie (never visible
    // to JS, never in a URL). Browsers attach it automatically to same-origin
    // upgrades. Without a valid cookie the handshake still completes and the
    // {type:'auth', token} first-message fallback applies (tests / non-cookie
    // clients).
    const cookies = {};
    for (const pair of String(req.headers.cookie || '').split(';')) {
      const i = pair.indexOf('=');
      if (i > -1) cookies[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
    }
    const token = cookies.cb_session || null;
    const session = token && this.auth.authenticateToken(this.db, token);
    this.acceptSocket(req, socket, head, session && session.ok ? session : null);
  }

  acceptSocket(req, socket, head, session) {
    const key = req.headers['sec-websocket-key'];
    const { acceptKey, encodeFrame, encodeText, encodeClose, OP, Framer } = require('./ws.js');
    if (!key) { socket.destroy(); return; }

    let conn;
    if (session) {
      // Cookie-authenticated at upgrade: trusted immediately.
      conn = {
        socket, framer: new Framer(), alive: true,
        authed: true,
        userId: session.user.id, username: session.user.username, room: null
      };
    } else {
      conn = {
        socket, framer: new Framer(), alive: true,
        authed: false,
        userId: null, username: null, room: null
      };
    }
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

    // Authenticated conns occupy the per-user socket budget; unauthenticated
    // ones are tracked only for teardown until their token checks out.
    if (conn.authed) {
      let socketsForUser = 0;
      for (const info of this.conns.values()) {
        if (info.userId === conn.userId && ++socketsForUser >= MAX_SOCKETS_PER_USER) {
          this.close(conn, 1013); // try again later
          return;
        }
      }
      this.conns.set(conn, { userId: conn.userId, username: conn.username });
      this.send(conn, { type: 'authed', user: { id: conn.userId, username: conn.username } });
    }
    this.allConns.add(conn);
  }

  // First-message authentication fallback (non-cookie clients). Returns true
  // when the conn is now trusted.
  authenticateConn(conn, msg) {
    const token = msg && typeof msg.token === 'string' ? msg.token : null;
    const session = token && this.auth.authenticateToken(this.db, token);
    if (!session || !session.ok) return false;

    // Resource guard: bound concurrent sockets per account so one user cannot
    // farm connections and grow this.conns forever.
    let socketsForUser = 0;
    for (const info of this.conns.values()) {
      if (info.userId === session.user.id && ++socketsForUser >= MAX_SOCKETS_PER_USER) {
        this.close(conn, 1013); // try again later
        return false;
      }
    }
    conn.authed = true;
    conn.userId = session.user.id;
    conn.username = session.user.username;
    this.conns.set(conn, { userId: conn.userId, username: conn.username });
    this.send(conn, { type: 'authed', user: { id: conn.userId, username: conn.username } });
    return true;
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
    catch {
      if (!conn.authed) { this.close(conn, 1008); return; }
      this.sendErr(conn, 'bad-json');
      return;
    }

    // Pre-auth: the ONLY accepted message is the auth handshake. Anything
    // else — including malformed JSON — is a protocol violation.
    if (!conn.authed) {
      if (msg && typeof msg === 'object' && msg.type === 'auth' && this.authenticateConn(conn, msg)) return;
      this.close(conn, 1008); // policy violation: unauthenticated
      return;
    }
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
        // Merge the move's event flags into the broadcast so clients can
        // fire capture/Gatti/home sound + celebration cues (serializeBoard
        // itself stays a pure state snapshot for persistence).
        this.broadcast(room, { type: 'board', board: Object.assign(serializeBoard(room.state), {
          capturedCount: mv.capturedCount,
          gattiFormed: mv.gattiFormed,
          reachesHome: mv.reachesHome
        }) });
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

  openRoom({ matchId, code, gridSize, hostUserId, invitedUserId }) {
    const existing = this.rooms.get(code);
    if (existing) {
      // A late invite must reach an ALREADY-OPEN room: /create opened it
      // before any invitee existed, so its invitedUserId was null. Without
      // this merge, the authorization recorded at join time would be
      // silently dropped and anyone with the code could claim the seat.
      if (invitedUserId !== undefined && existing.invitedUserId == null) {
        existing.invitedUserId = invitedUserId;
      }
      return existing;
    }
    const room = {
      matchId, code, gridSize,
      hostUserId: hostUserId === undefined ? null : hostUserId,
      // The user the HTTP join endpoint authorized for the guest seat. When
      // set, seat 1 is closed to everyone else — a leaked code alone does
      // not grant a seat. null = open room (legacy/tests).
      invitedUserId: invitedUserId === undefined ? null : invitedUserId,
      state: newGame({ gridSize, playerNum: 2 }),
      sockets: new Map(), // playerIndex (0=host seat, 1=guest seat) -> conn
      seq: 0
    };
    this.rooms.set(code, room);
    return room;
  }

  // Attach an authenticated conn to a room. Seats are IDENTITY-based: the
  // match's host_user_id always owns seat 0, everyone else competes for
  // seat 1 — so a reconnecting host can never be demoted to guest just
  // because their socket re-attached after someone else's.
  attach(conn, room) {
    if (conn.room) { this.sendErr(conn, 'already-in-room'); return; }
    // Same user already seated from another (still-live) socket.
    for (const [, seated] of room.sockets) {
      if (seated.userId === conn.userId) { this.sendErr(conn, 'already-in-room'); return; }
    }
    if (room.sockets.size >= room.state.playerNum) { this.sendErr(conn, 'room-full'); return; }

    // Legacy fallback when a room was opened without a known host: whoever
    // arrives first takes seat 0 (old arrival-order behavior).
    const seat = room.hostUserId == null && !room.sockets.has(0)
      ? 0
      : (conn.userId === room.hostUserId ? 0 : 1);
    if (room.sockets.has(seat)) { this.sendErr(conn, 'room-full'); return; }
    // The invited guest seat is closed to everyone but the invitee.
    if (seat === 1 && room.invitedUserId != null && conn.userId !== room.invitedUserId) {
      this.sendErr(conn, 'not-invited');
      return;
    }

    // All checks passed — NOW cancel the pending close timer. Cancelling
    // before validation would let a rejected probe permanently extend the
    // room's lifetime (leak).
    this.cancelRoomClose(room);

    conn.room = room;
    conn.seat = seat;
    room.sockets.set(seat, conn);

    this.send(conn, { type: 'joined', code: room.code, playerIndex: seat, gridSize: room.gridSize });
    if (seat === 1) {
      // Guest claimed the invitee seat; persist it in the DB (WAITING -> PLAYING).
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
    for (const [seat, seated] of room.sockets) {
      if (seated.userId === userId) return seat;
    }
    return -1;
  }

  storeBoard(room) {
    try {
      this.db.setMatchBoard(room.matchId, JSON.stringify(serializeBoard(room.state)));
    } catch {}
  }

  finishMatch(room) {
    const idx = room.state.winner;
    // Resolve the winner through the authoritative seat mapping first (host /
    // invitee), then the persisted match row (survives restarts), then live
    // sockets last: the winner's socket may have dropped in the same tick.
    // A NULL winner must never be persisted — it corrupts results history.
    // Out-of-range seats resolve to nobody by construction.
    const legalSeat = idx === 0 || idx === 1;
    let winnerUserId = idx === 0 ? room.hostUserId : (idx === 1 ? room.invitedUserId : null);
    if (winnerUserId == null && legalSeat) {
      try {
        const row = this.db.getMatchById(room.matchId);
        winnerUserId = ((idx === 0 ? row && row.host_user_id : row && row.guest_user_id) || null);
      } catch {}
      if (winnerUserId == null) {
        const seatConn = room.sockets.get(idx);
        winnerUserId = (seatConn && seatConn.userId) || null;
      }
    }
    if (winnerUserId == null) {
      // Unresolvable (impossible in legitimate play): still terminate the
      // clients, but leave the DB row alone rather than writing FINISHED
      // with a NULL winner.
      this.broadcast(room, { type: 'game-over', winner: idx, winnersUser: null });
      return;
    }
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
    this.allConns.delete(conn);
    const room = conn.room;
    if (!room) return;
    room.sockets.delete(conn.seat);
    conn.room = null;
    conn.seat = null;
    if (room.sockets.size === 0) {
      // Grace period: keep the room (and its authoritative board) alive so a
      // dropped player can reconnect and resume instead of losing the match.
      this.scheduleRoomClose(room);
    } else {
      this.broadcast(room, { type: 'member-count', count: room.sockets.size, playerNum: room.state.playerNum });
      this.broadcast(room, { type: 'peer-left', userId: conn.userId });
    }
  }

  scheduleRoomClose(room) {
    if (room._closeTimer) return;
    room._closeTimer = setTimeout(() => {
      const current = this.rooms.get(room.code);
      if (current === room && room.sockets.size === 0) {
        this.rooms.delete(room.code);
      }
      room._closeTimer = null;
    }, this.resumeGraceMs);
    if (typeof room._closeTimer.unref === 'function') room._closeTimer.unref();
  }

  cancelRoomClose(room) {
    if (room._closeTimer) { clearTimeout(room._closeTimer); room._closeTimer = null; }
  }

  close(conn, code) {
    const { encodeClose } = require('./ws.js');
    if (conn.closed || conn.socket.destroyed) return;
    conn.closed = true;
    try { conn.socket.write(encodeClose(code || 1000, '')); } catch {}
    this.detach(conn);
    setTimeout(() => { try { conn.socket.end(); } catch {} }, 30);
  }

  // Hard teardown: kill every connection and clear all timers. Used by tests
  // so no heartbeat interval survives past the mocked http server.
  shutdown() {
    for (const room of this.rooms.values()) {
      if (room._closeTimer) { clearTimeout(room._closeTimer); room._closeTimer = null; }
    }
    for (const conn of [...this.allConns]) {
      if (conn._heartbeat) { clearInterval(conn._heartbeat); conn._heartbeat = null; }
      try { conn.socket.destroy(); } catch {}
    }
    this.conns.clear();
    this.allConns.clear();
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