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

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function handleRequest(req, res) {
  let urlPath;
  try { urlPath = decodeURIComponent(req.url.split('?')[0]); } catch (e) { urlPath = '/'; }
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.resolve(ROOT, '.' + urlPath);
  // Boundary-safe containment check (BUG-24): a sibling dir such as
  // "...\web2\..." must NOT pass. Prefix matching (indexOf === 0) would allow it.
  const rel = path.relative(ROOT, filePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function createServer() {
  return http.createServer(handleRequest);
}

function startServer(listenPort) {
  const srv = createServer();
  srv.listen(listenPort || PORT, () => {
    console.log(`Choka Barah static server on http://localhost:${listenPort || PORT}`);
  });
  return srv;
}

// Start only when executed directly (allows require('./server.js') in tests).
if (require.main === module) {
  startServer();
}

module.exports = { createServer, handleRequest, startServer, MIME, PORT };