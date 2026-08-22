// ============================================================
// CHOKA BARAH â€“ Online server entry point
// ------------------------------------------------------------
// HTTP handlers (register / login / logout / match create&join)
// plus a WebSocket upgrade that hands every connection to the
// relay. Reuses the existing static file server for the web app.
// No external dependencies: node:sqlite, node:crypto, node:http,
// node:fs all built into Node 22.5+ (developed on Node 24).
//
//   node online-server.js            starts on PORT (default 3111)
//   ONLINE_DB=./data.db              persists across restarts
// ============================================================
'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const { openDb, makeStore } = require('./online-db.js');
const auth = require('./auth.js');
const { Relay } = require('./relay.js');
const { handleRequest: serveStatic } = require('../server.js');

const PORT = Number(process.env.PORT || 3111);
const DB_PATH = process.env.ONLINE_DB || path.join(__dirname, '..', 'online-dev.db');
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function makeRoomCode(store) {
  // CSPRNG: room codes are capability tokens — anyone who guesses one can
  // take an open seat, so they must not be enumerable via Math.random().
  for (let i = 0; i < 20; i++) {
    const bytes = crypto.randomBytes(6);
    let code = '';
    for (let j = 0; j < 6; j++) code += CODE_CHARS[bytes[j] % CODE_CHARS.length];
    if (!store.getMatchByCode(code)) return code;
  }
  throw new Error('code-space-exhausted');
}

function json(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(e); }
    });
  });
}

function send(res, status, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function createOnlineServer({ store = makeStore(openDb(':memory:')), staticPath = path.join(__dirname, '..') } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'local'}`);
    const base = url.pathname;

    if (req.method === 'POST' && base === '/api/register') {
      try {
        const { username, password } = await json(req);
        const out = await auth.registerUser(store, username, password);
        if (!out.ok) return send(res, 400, { error: out.error });
        return send(res, 201, { token: out.token, user: out.user });
      } catch { return send(res, 400, { error: 'bad-json' }); }
    }

    if (req.method === 'POST' && base === '/api/login') {
      try {
        const { username, password } = await json(req);
        const out = await auth.loginUser(store, username, password);
        if (!out.ok) return send(res, 401, { error: out.error });
        return send(res, 200, { token: out.token, user: out.user });
      } catch { return send(res, 400, { error: 'bad-json' }); }
    }

    if (req.method === 'POST' && base === '/api/logout') {
      const token = bearer(req);
      if (!token) return send(res, 401, { error: 'unauthorized' });
      const session = auth.authenticateToken(store, token);
      if (!session || !session.ok) return send(res, 401, { error: 'unauthorized' });
      auth.logoutUser(store, token);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && base === '/api/match/create') {
      const token = bearer(req);
      const session = token && auth.authenticateToken(store, token);
      if (!session || !session.ok) return send(res, 401, { error: 'unauthorized' });
      try {
        const body = await json(req);
        const gridSize = body.gridSize === 7 ? 7 : 5;
        const desc = store.createMatch({ code: makeRoomCode(store), gridSize, playerCount: 2, hostUserId: session.user.id });
        const room = relay.openRoom({ matchId: desc.id, code: desc.code, gridSize, hostUserId: session.user.id });
        return send(res, 201, { code: desc.code, gridSize, playerCount: 2, matchId: desc.id, wsPath: `/ws?token=${token}` });
      } catch (e) {
        return send(res, 500, { error: String(e && e.message || 'create-failed') });
      }
    }

    if (req.method === 'POST' && base === '/api/match/join') {
      const token = bearer(req);
      const session = token && auth.authenticateToken(store, token);
      if (!session || !session.ok) return send(res, 401, { error: 'unauthorized' });
      try {
        const body = await json(req);
        const code = String(body.code || '').trim().toUpperCase();
        const desc = store.getMatchByCode(code);
        if (!desc) return send(res, 404, { error: 'no-such-room' });
        if (desc.status !== 'WAITING') return send(res, 409, { error: 'room-not-open' });
        if (desc.host_user_id === session.user.id) return send(res, 409, { error: 'cannot-join-own-room' });
        const room = relay.openRoom({ matchId: desc.id, code: desc.code, gridSize: desc.grid_size, hostUserId: desc.host_user_id });
        return send(res, 200, { code: desc.code, gridSize: desc.grid_size, wsPath: `/ws?token=${token}`, matchId: desc.id });
      } catch { return send(res, 500, { error: 'join-failed' }); }
    }

    if (base === '/api/health') return send(res, 200, { ok: true });

    // Anything else: static files from the existing web app.
    return serveStatic(req, res, { root: staticPath });
  });

  const relay = new Relay(server, { db: store, auth });
  // The Relay binds its own 'upgrade' listener; store the handle for clients.
  server.relay = relay;
  return server;
}

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

// Entry point guard — only meaningful when this file is executed directly,
// never when required (tests always take the false branch).
/* istanbul ignore next */
if (require.main === module) {
  const db = openDb(DB_PATH);
  const store = makeStore(db);
  const server = createOnlineServer({ store, staticPath: path.join(__dirname, '..') });
  server.listen(PORT, () => {
    console.log(`[online] http+ws on http://localhost:${PORT}/ (db=${DB_PATH})`);
  });
}

module.exports = { createOnlineServer, makeRoomCode, bearer };
