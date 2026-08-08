// ============================================================
// CHOKA BARAH – Minimal static file server (dev/E2E only).
// Serves the web/ directory over HTTP so Playwright tests can
// load the app without file:// limitations. No dependencies.
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

http.createServer((req, res) => {
  let urlPath;
  try { urlPath = decodeURIComponent(req.url.split('?')[0]); } catch (e) { urlPath = '/'; }
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.resolve(ROOT, '.' + urlPath);
  if (filePath.indexOf(ROOT) !== 0) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log(`Choka Barah static server on http://localhost:${PORT}`);
});