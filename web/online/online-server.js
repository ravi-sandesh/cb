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

function send(res, status, obj, extraHeaders) {
  const payload = JSON.stringify(obj);
  res.writeHead(status, Object.assign(
    { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' },
    extraHeaders || {}
  ));
  res.end(payload);
}

function createOnlineServer({ store = makeStore(openDb(':memory:')), staticPath = path.join(__dirname, '..') } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'local'}`);
    const base = url.pathname;

    if (req.method === 'POST' && base === '/api/register') {
      // No session identity exists yet, so the bucket is IP-only; the scrypt
      // cost makes unthrottled registration a CPU DoS vector.
      if (!rateAllow(`register:${(req.socket && req.socket.remoteAddress) || 'unknown'}`, REGISTER_RATE.max, REGISTER_RATE.windowMs)) {
        return send(res, 429, { error: 'try-again-later' });
      }
      try {
        const { username, password } = await json(req);
        const out = await auth.registerUser(store, username, password);
        if (!out.ok) return send(res, 400, { error: out.error });
        // The token travels ONLY in the HttpOnly cookie — never in the JSON
        // body, where logs/proxies/XSS-at-login could capture it.
        return send(res, 201, { user: out.user }, { 'Set-Cookie': sessionCookie(req, out.token) });
      } catch { return send(res, 400, { error: 'bad-json' }); }
    }

    if (req.method === 'POST' && base === '/api/login') {
      // scrypt makes each attempt expensive: throttle per IP like register.
      if (!rateAllow(`login:${(req.socket && req.socket.remoteAddress) || 'unknown'}`, LOGIN_RATE.max, LOGIN_RATE.windowMs)) {
        return send(res, 429, { error: 'try-again-later' });
      }
      try {
        const { username, password } = await json(req);
        const out = await auth.loginUser(store, username, password);
        if (!out.ok) return send(res, 401, { error: out.error });
        return send(res, 200, { user: out.user }, { 'Set-Cookie': sessionCookie(req, out.token) });
      } catch { return send(res, 400, { error: 'bad-json' }); }
    }

    if (req.method === 'POST' && base === '/api/logout') {
      const token = bearer(req) || parseCookies(req)[SESSION_COOKIE] || null;
      if (!token) return send(res, 401, { error: 'unauthorized' });
      const session = auth.authenticateToken(store, token);
      if (!session || !session.ok) return send(res, 401, { error: 'unauthorized' });
      auth.logoutUser(store, token);
      return send(res, 200, { ok: true }, { 'Set-Cookie': clearedSessionCookie() });
    }

    // Session introspection for the browser client (cookie restores login
    // after a page reload without any token in localStorage).
    if (base === '/api/me') {
      const session = sessionFromRequest(req, store);
      if (!session) return send(res, 401, { error: 'unauthorized' });
      return send(res, 200, { ok: true, user: { id: session.user.id, username: session.user.username } });
    }

    if (req.method === 'POST' && base === '/api/match/create') {
      const session = sessionFromRequest(req, store);
      if (!session || !session.ok) return send(res, 401, { error: 'unauthorized' });
      try {
        const body = await json(req);
        if (!rateAllow(`create:${identityKey(req, session)}`, CREATE_RATE.max, CREATE_RATE.windowMs)) {
          return send(res, 429, { error: 'try-again-later' });
        }
        const gridSize = body.gridSize === 7 ? 7 : 5;
        const playerCount = (body.playerCount === 3 || body.playerCount === 4) ? body.playerCount : 2;
        const desc = store.createMatch({ code: makeRoomCode(store), gridSize, playerCount, hostUserId: session.user.id });
        const room = relay.openRoom({ matchId: desc.id, code: desc.code, gridSize, playerCount, hostUserId: session.user.id });
        return send(res, 201, { code: desc.code, gridSize, playerCount, matchId: desc.id, wsPath: '/ws' });
      } catch (e) {
        return send(res, 500, { error: String(e && e.message || 'create-failed') });
      }
    }

    if (req.method === 'POST' && base === '/api/match/join') {
      const session = sessionFromRequest(req, store);
      if (!session || !session.ok) return send(res, 401, { error: 'unauthorized' });
      try {
        const body = await json(req);
        if (!rateAllow(`join:${identityKey(req, session)}`, JOIN_RATE.max, JOIN_RATE.windowMs)) {
          return send(res, 429, { error: 'try-again-later' });
        }
        const code = String(body.code || '').trim().toUpperCase();
        const desc = store.getMatchByCode(code);
        if (!desc) return send(res, 404, { error: 'no-such-room' });
        // Atomic multi-seat claim: concurrent joiners serialize here — each
        // seat goes to exactly one claimant. The returned reason keeps the
        // friendly 409 vocabulary (open / own-room / taken).
        const claim = store.claimInviteSeat(desc.id, session.user.id);
        if (!claim.ok) return send(res, 409, { error: claim.reason });
        const room = relay.openRoom({ matchId: desc.id, code: desc.code, gridSize: desc.grid_size, playerCount: desc.player_count, hostUserId: desc.host_user_id, invitedUserIds: store.getInvitees(desc.id) });
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

const SESSION_COOKIE = 'cb_session';

// Zero-dep cookie parsing (values here are opaque hex tokens; no decoding).
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const pair of raw.split(';')) {
    const i = pair.indexOf('=');
    if (i > -1) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return out;
}

// Session resolution order: explicit bearer (tests/API clients) first, then
// the HttpOnly cookie the browser attaches automatically.
function sessionFromRequest(req, store) {
  const token = bearer(req) || parseCookies(req)[SESSION_COOKIE] || null;
  if (!token) return null;
  const s = auth.authenticateToken(store, token);
  return s && s.ok ? { ...s, token } : null;
}

function sessionCookie(req, token) {
  // HttpOnly keeps the token invisible to JS (XSS can't exfiltrate it);
  // SameSite=Strict doubles as CSRF defense for these JSON endpoints.
  // Secure is set only behind TLS (direct or x-forwarded-proto from the
  // edge proxy): plain-HTTP dev/test clients would otherwise drop the cookie.
  const encrypted = (req.socket && req.socket.encrypted === true) ||
    String((req.headers && req.headers['x-forwarded-proto']) || '').toLowerCase() === 'https';
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${encrypted ? '; Secure' : ''}`;
}
function clearedSessionCookie() {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

// ---- Match-endpoint rate limiting (per user+IP fixed window) --------------
// Joins and creates are cheap for legit users but enumerable/abusable at
// scale; a small per-identity cap blunts code-guessing and spam without any
// dependency. Keys are lazily expired on read.
const JOIN_RATE = { max: 10, windowMs: 60 * 1000 };   // 10 joins/min
const CREATE_RATE = { max: 5, windowMs: 60 * 1000 };  // 5 creates/min
const REGISTER_RATE = { max: 5, windowMs: 60 * 1000 }; // 5 registers/min per IP
const LOGIN_RATE = { max: 10, windowMs: 60 * 1000 }; // 10 logins/min per IP (scrypt is expensive)
const rateBuckets = new Map(); // key -> { count, firstAt }

// Returns true when the action is ALLOWED under the window budget.
// Expired buckets are purged periodically (every 64 new-key inserts) so
// unique identities cannot grow the map without bound on a long-running
// process.
let rateInsertionsSincePrune = 0;

function rateAllow(key, max, windowMs, now = Date.now()) {
  let bucket = rateBuckets.get(key);
  const isNewKey = !bucket || now - bucket.firstAt >= windowMs;
  if (isNewKey) {
    if (++rateInsertionsSincePrune >= 64) {
      rateInsertionsSincePrune = 0;
      for (const [k, b] of rateBuckets) {
        if (now - b.firstAt >= windowMs) rateBuckets.delete(k);
      }
    }
    rateBuckets.set(key, { count: 1, firstAt: now });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= max;
}

// Test seam: exposes the live bucket count.
function rateBucketCount() { return rateBuckets.size; }

function resetRateLimits() {
  rateInsertionsSincePrune = 0;
  rateBuckets.clear();
}

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
  if (reaped.abandonedWaiting || reaped.abandonedPlaying || reaped.deletedSessions || reaped.prunedMatches) {
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

module.exports = { createOnlineServer, makeRoomCode, bearer, startOnlineServer, sweepTick, rateAllow, rateBucketCount, resetRateLimits };
