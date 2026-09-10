// ============================================================
// CHOKA BARAH – Minimal static file server (dev/E2E only).
// Serves the web/ directory over HTTP so Playwright tests can
// load the app without file:// limitations. No dependencies.
// The request handler is exported so unit tests can exercise
// routing without binding a real port.
// ============================================================
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3111;
// Dev/E2E server: bind to the loopback interface by default so it is never
// exposed to the network. HOST env var overrides for intentional deployments.
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// Never served: local databases, dotfiles (.env et al.), and build/test
// artifacts have no business being downloadable from a dev server that binds
// loopback but is still reachable by anything running on this machine —
// and the online server reuses this handler in production.
const FORBIDDEN_EXTENSIONS = new Set(['.db', '.db-journal', '.db-wal', '.db-shm', '.sqlite', '.sqlite3']);
// Top-level directories that must never be servable (source-annotated test
// output, dependency trees, version control metadata).
const FORBIDDEN_TOP_DIRS = new Set(['coverage', 'node_modules', '.git']);

function isForbidden(urlPath) {
  const segments = urlPath.split('/').filter(Boolean);
  // Any dotfile/dot-directory segment (.env, .git/config, ...) is off-limits.
  if (segments.some((s) => s.startsWith('.'))) return true;
  // Blocked top-level trees regardless of nesting depth below them.
  if (segments.length && FORBIDDEN_TOP_DIRS.has(segments[0])) return true;
  const base = segments.pop() || '';
  return FORBIDDEN_EXTENSIONS.has((base.match(/\.[^.]+$/) || [''])[0].toLowerCase());
}

// Baseline hardening headers for every response this server emits. The CSP
// is strict: no inline scripts (all wiring is delegated in app.js), styles
// keep 'unsafe-inline' only for the few style="" attributes that remain.
const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; " +
    "script-src 'self'; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; " +
    "img-src 'self' data:; " +
    "connect-src 'self' ws://localhost:* ws://127.0.0.1:* wss://cb-production-68b3.up.railway.app; " +
    "object-src 'none'; frame-ancestors 'none'; base-uri 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-cache'
};

// Per-asset Cache-Control. HTML stays no-cache so it always re-fetches the
// latest asset references; content-hashed assets are immutable; everything else
// is cacheable for CB_STATIC_MAX_AGE seconds (default 1h) to avoid re-fetching
// app.js / game-engine.js / audio on every repeat visit.
function cacheControlFor(urlPath, ext) {
  if (ext === '.html') return 'no-cache';
  const base = path.basename(urlPath);
  if (/\.[0-9a-f]{8,}\.[^.]+$/.test(base)) return 'public, max-age=31536000, immutable';
  const env = Number(process.env.CB_STATIC_MAX_AGE);
  const seconds = Number.isFinite(env) && env >= 0 ? env : 3600;
  return `public, max-age=${seconds}`;
}

function handleRequest(req, res) {
  let urlPath;
  try { urlPath = decodeURIComponent(req.url.split('?')[0]); } catch (e) { urlPath = '/'; }
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.resolve(ROOT, '.' + urlPath);
  // Boundary-safe containment check (BUG-24): a sibling dir such as
  // "...\web2\..." must NOT pass. Prefix matching (indexOf === 0) would allow it.
  const rel = path.relative(ROOT, filePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    res.writeHead(403, SECURITY_HEADERS); res.end('Forbidden'); return;
  }

  if (isForbidden(urlPath)) { res.writeHead(403, SECURITY_HEADERS); res.end('Forbidden'); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, SECURITY_HEADERS); res.end('Not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    const cacheControl = cacheControlFor(urlPath, ext);
    res.writeHead(200, Object.assign({}, SECURITY_HEADERS, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': cacheControl
    }));
    res.end(data);
  });
}

function createServer() {
  return http.createServer(handleRequest);
}

function startServer(listenPort) {
  const srv = createServer();
  // 0 means "ephemeral port" — don't let `|| PORT` treat it as falsy and
  // fall through to the fixed default (that also lets tests bind freely
  // without clashing with a server already on PORT).
  const port = (listenPort === undefined || listenPort === null) ? PORT : listenPort;
  srv.listen(port, HOST, () => {
    console.log(`Choka Barah static server on http://${HOST}:${port}`);
  });
  return srv;
}

// Entry-point guard: only meaningful when executed directly.
/* istanbul ignore next */
if (require.main === module) {
  startServer();
}

module.exports = { createServer, handleRequest, startServer, MIME, PORT, SECURITY_HEADERS, isForbidden, cacheControlFor };