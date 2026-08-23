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
const { openDb, makeStore, sweepAbandoned, SWEEP_INTERVAL_MS } = require('./online-db.js');
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
  res.writeHead(status, Object.assign(
    { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' }
  ));
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
        if (!rateAllow(`create:${identityKey(req, session)}`, CREATE_RATE.max, CREATE_RATE.windowMs)) {
          return send(res, 429, { error: 'try-again-later' });
        }
        const gridSize = body.gridSize === 7 ? 7 : 5;
        const desc = store.createMatch({ code: makeRoomCode(store), gridSize, playerCount: 2, hostUserId: session.user.id });
        const room = relay.openRoom({ matchId: desc.id, code: desc.code, gridSize, hostUserId: session.user.id });
        return send(res, 201, { code: desc.code, gridSize, playerCount: 2, matchId: desc.id, wsPath: '/ws' });
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
        if (!rateAllow(`join:${identityKey(req, session)}`, JOIN_RATE.max, JOIN_RATE.windowMs)) {
          return send(res, 429, { error: 'try-again-later' });
        }
        const code = String(body.code || '').trim().toUpperCase();
        const desc = store.getMatchByCode(code);
        if (!desc) return send(res, 404, { error: 'no-such-room' });
        if (desc.status !== 'WAITING') return send(res, 409, { error: 'room-not-open' });
        if (desc.host_user_id === session.user.id) return send(res, 409, { error: 'cannot-join-own-room' });
        // One invitee per room: once a guest intent is recorded nobody else
        // can claim the seat (the relay enforces the same rule on attach).
        if (desc.guest_user_id != null && desc.guest_user_id !== session.user.id) {
          return send(res, 409, { error: 'room-taken' });
        }
        store.setMatchInvited(desc.id, session.user.id);
        const room = relay.openRoom({ matchId: desc.id, code: desc.code, gridSize: desc.grid_size, hostUserId: desc.host_user_id, invitedUserId: session.user.id });
        return send(res, 200, { code: desc.code, gridSize: desc.grid_size, wsPath: '/ws', matchId: desc.id });
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

// ---- Match-endpoint rate limiting (per user+IP fixed window) --------------
// Joins and creates are cheap for legit users but enumerable/abusable at
// scale; a small per-identity cap blunts code-guessing and spam without any
// dependency. Keys are lazily expired on read.
const JOIN_RATE = { max: 10, windowMs: 60 * 1000 };   // 10 joins/min
const CREATE_RATE = { max: 5, windowMs: 60 * 1000 };  // 5 creates/min
const rateBuckets = new Map(); // key -> { count, firstAt }

// Returns true when the action is ALLOWED under the window budget.
function rateAllow(key, max, windowMs, now = Date.now()) {
  let bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.firstAt >= windowMs) {
    rateBuckets.set(key, { count: 1, firstAt: now });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= max;
}

function resetRateLimits() { rateBuckets.clear(); }

function identityKey(req, session) {
  const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
  const who = session && session.user ? session.user.id : 'anon';
  return `${who}@${ip}`;
}

// Entry point guard — only meaningful when this file is executed directly,
// never when required (tests always take the false branch).
// One sweeper pass with operator-friendly logging. Exported so the interval
// body is unit-testable without waiting ten minutes.
function sweepTick(store) {
  let reaped;
  try {
    reaped = sweepAbandoned(store.db);
  } catch (e) {
    console.error('[online] sweep failed:', e && e.message);
    return null;
  }
  if (reaped.abandonedWaiting || reaped.abandonedPlaying || reaped.deletedSessions) {
    console.log(`[online] sweep: ${JSON.stringify(reaped)}`);
  }
  return reaped;
}

// Entry-point lifecycle: bind to the loopback interface by default (this is
// a dev/E2E server; HOST overrides for real deployments), run the abandoned
// room/session sweeper at boot and on an interval, and tear everything down
// (interval -> server -> sqlite handle) on shutdown.
function startOnlineServer({ port = PORT, host = process.env.HOST || '127.0.0.1', dbPath = DB_PATH } = {}) {
  const db = openDb(dbPath);
  const store = makeStore(db);
  const server = createOnlineServer({ store, staticPath: path.join(__dirname, '..') });
  sweepTick(store);
  const sweeper = setInterval(() => sweepTick(store), SWEEP_INTERVAL_MS);
  if (sweeper.unref) sweeper.unref();
  server.listen(port, host, () => {
    console.log(`[online] http+ws on http://${host}:${port}/ (db=${dbPath})`);
  });
  return {
    server,
    stop() {
      clearInterval(sweeper);
      return new Promise((resolve) => {
        // In-flight sockets would stall close(); force-exit shortly after so
        // a stray WebSocket client can never block process teardown.
        const guard = setTimeout(() => resolve(), 1500);
        if (guard.unref) guard.unref();
        server.close(() => {
          try { db.close(); } catch {}
          resolve();
        });
      });
    }
  };
}

/* istanbul ignore next */
if (require.main === module) {
  const instance = startOnlineServer();
  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[online] ${signal} received; closing server and database...`);
    instance.stop().then(() => process.exit(0));
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = { createOnlineServer, makeRoomCode, bearer, startOnlineServer, sweepTick, rateAllow, resetRateLimits };
