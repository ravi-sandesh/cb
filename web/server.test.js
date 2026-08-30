// ============================================================
// CHOKA BARAH – Static server unit tests
// Exercises handleRequest directly (no real port) so routing,
// MIME types, 404s and the BUG-24 boundary-containment guard
// are covered by the same jest suite as the rest of the web app.
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { createServer, handleRequest, startServer, MIME, PORT, isForbidden, cacheControlFor } = require('./server.js');

// Mock response whose end() settles a promise, so tests can await the
// async fs.readFile callback inside handleRequest.
function mockRes() {
  const res = { _status: 200, _headers: {}, _body: '' };
  let resolveEnd;
  res.done = new Promise((resolve) => { resolveEnd = resolve; });
  res.writeHead = (status, headers) => { res._status = status; res._headers = headers || {}; return res; };
  res.end = (body) => { res._body = body || ''; resolveEnd(res); return res; };
  return res;
}

// Invoke handleRequest with a raw URL path (same shape http passes for req.url)
// and await the fs.readFile callback so the response body is settled.
async function request(urlPath) {
  const res = mockRes();
  handleRequest({ url: urlPath }, res);
  return res.done;
}

describe('server routing', () => {
  test('ships a handler factory and default port', () => {
    expect(typeof createServer).toBe('function');
    expect(typeof handleRequest).toBe('function');
    expect(PORT).toBe(3111);
    // MIME covers the asset types used by index.html.
    expect(MIME['.html']).toContain('text/html');
    expect(MIME['.js']).toContain('application/javascript');
    expect(MIME['.css']).toContain('text/css');
  });

  test('deny-list: databases, journals and dotfiles are forbidden', async () => {
    for (const p of ['/online-dev.db', '/data.sqlite3', '/x.db-journal', '/.env', '/.git/config']) {
      const res = await request(p);
      expect(res._status).toBe(403);
    }
    // Legitimate assets stay reachable.
    const ok = await request('/index.html');
    expect(ok._status).toBe(200);
  });

  test('deny-list helpers: extensionless and empty inputs', () => {
    expect(isForbidden('/foo')).toBe(false);          // no extension -> allowed
    expect(isForbidden('')).toBe(false);              // empty path
    expect(isForbidden('/app.js')).toBe(false);       // real extension, not forbidden
    expect(isForbidden('/x.db/config')).toBe(false);  // dotless final segment
    expect(isForbidden('/x/.db')).toBe(true);         // dotfile segment
  });

  test('every response carries the security headers', async () => {
    const ok = await request('/index.html');
    expect(ok._headers['X-Content-Type-Options']).toBe('nosniff');
    expect(ok._headers['X-Frame-Options']).toBe('DENY');
    expect(ok._headers['Referrer-Policy']).toBe('no-referrer');
    expect(String(ok._headers['Content-Security-Policy'])).toContain("default-src 'self'");
    expect(String(ok._headers['Content-Security-Policy'])).toContain("script-src 'self';");
    expect(String(ok._headers['Content-Security-Policy'])).toContain("frame-ancestors 'none'");

    const denied = await request('/online-dev.db');
    expect(denied._headers['X-Content-Type-Options']).toBe('nosniff');
  });

  test('GET / maps to index.html with 200 + text/html', async () => {
    const res = await request('/');
    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toContain('text/html');
    expect(res._body.toString()).toContain('CHOKA BARAH');
  });

  test('GET /index.html serves the app shell', async () => {
    const res = await request('/index.html');
    expect(res._status).toBe(200);
  });

  test('GET /game-engine.js serves JS with application/javascript', async () => {
    const res = await request('/game-engine.js');
    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toContain('application/javascript');
    expect(res._body.length).toBeGreaterThan(1000);
  });

  test('GET /app.js serves the UI bundle', async () => {
    const res = await request('/app.js');
    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toContain('application/javascript');
  });

  test('unknown file yields 404', async () => {
    const res = await request('/does-not-exist.js');
    expect(res._status).toBe(404);
    expect(res._body).toBe('Not found');
  });

  test('GET /parity/parity-corpus.json serves JSON with application/json', async () => {
    const res = await request('/parity/parity-corpus.json');
    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toContain('application/json');
  });

  test('an extension outside the MIME map falls back to application/octet-stream', async () => {
    // coverage/lcov.info is a real sibling file whose '.info' extension is
    // absent from MIME, so it exercises the octet-stream fallback branch.
    const res = await request('/coverage/lcov.info');
    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toBe('application/octet-stream');
    expect(res._body.length).toBeGreaterThan(0);
  });
});

describe('BUG-24 boundary containment guard', () => {
  test('traversal with ../ is forbidden', async () => {
    const res = await request('/../secret.txt');
    expect(res._status).toBe(403);
  });

  test('traversal via encoded .. is forbidden', async () => {
    const res = await request('/..%2fsecret.txt');
    expect(res._status).toBe(403);
  });

  test('percent-encoded traversal resolving outside ROOT is forbidden', async () => {
    const res = await request('/%2e%2e/secret.txt');
    expect(res._status).toBe(403);
  });

  test('sibling directory prefix must not escape (web2 bug)', async () => {
    // A path that path.resolve treats as "<ROOT>\..\web2\..." resolves outside
    // ROOT even though its literal prefix is ROOT's own name. Guard must block.
    const res = await request('/..\\web2\\index.html');
    expect(res._status).toBe(403);
  });

  test('malformed percent-encoding degrades to root route', async () => {
    const res = await request('/%E0%A4%A');
    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toContain('text/html');
  });

  test('query strings are stripped before routing', async () => {
    const res = await request('/index.html?foo=bar');
    expect(res._status).toBe(200);
  });
});

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = require('net').createServer();
    s.listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

describe('startServer runtime path', () => {
  test('startServer listens when started without an explicit port', async () => {
    const srv = startServer(0); // ephemeral: never clashes with a running dev server
    await new Promise((resolve, reject) => {
      srv.on('listening', () => {
        expect(typeof srv.address().port).toBe('number');
        expect(srv.address().port).toBeGreaterThan(0);
        srv.close(resolve);
      });
      srv.on('error', (e) => reject(new Error('server failed to bind: ' + e.message)));
    });
  });

  test('startServer honours an explicitly supplied port', async () => {
    const port = await getFreePort();
    const srv = startServer(port);
    await new Promise((resolve, reject) => {
      srv.on('listening', () => {
        expect(srv.address().port).toBe(port);
        srv.close(resolve);
      });
      srv.on('error', (e) => reject(new Error('server failed to bind: ' + e.message)));
    });
  });

  test('createServer returns an http.Server wrapper', () => {
    const srv = createServer();
    expect(srv instanceof http.Server).toBe(true);
  });

  test('startServer binds the loopback interface by default', async () => {
    const srv = startServer(0); // ephemeral port; HOST default must be 127.0.0.1
    await new Promise((resolve, reject) => {
      srv.on('listening', () => {
        expect(srv.address().address).toBe('127.0.0.1');
        srv.close(resolve);
      });
      srv.on('error', (e) => reject(new Error('loopback bind failed: ' + e.message)));
    });
  });
});

describe('static cache policy', () => {
  test('HTML is never cached so asset references stay fresh', () => {
    expect(cacheControlFor('/index.html', '.html')).toBe('no-cache');
    expect(cacheControlFor('/', '.html')).toBe('no-cache');
  });

  test('plain assets are cacheable for the configured max-age (default 1h)', () => {
    const prev = process.env.CB_STATIC_MAX_AGE;
    delete process.env.CB_STATIC_MAX_AGE;
    expect(cacheControlFor('/app.js', '.js')).toBe('public, max-age=3600');
    expect(cacheControlFor('/sound.mp3', '.mp3')).toBe('public, max-age=3600');
    process.env.CB_STATIC_MAX_AGE = prev;
  });

  test('CB_STATIC_MAX_AGE override is honoured', () => {
    const prev = process.env.CB_STATIC_MAX_AGE;
    process.env.CB_STATIC_MAX_AGE = '0';
    expect(cacheControlFor('/app.js', '.js')).toBe('public, max-age=0');
    process.env.CB_STATIC_MAX_AGE = '86400';
    expect(cacheControlFor('/game-engine.js', '.js')).toBe('public, max-age=86400');
    process.env.CB_STATIC_MAX_AGE = prev;
  });

  test('content-hashed assets are immutable', () => {
    expect(cacheControlFor('/app.ab12cd34.js', '.js')).toBe('public, max-age=31536000, immutable');
  });

  test('200 responses carry the asset cache header while error responses stay no-cache', async () => {
    const ok = await request('/app.js');
    expect(ok._status).toBe(200);
    expect(ok._headers['Cache-Control']).toBe('public, max-age=3600');
    expect(ok._headers['Content-Security-Policy']).toBeDefined();
    const missing = await request('/does-not-exist.js');
    expect(missing._status).toBe(404);
    expect(missing._headers['Cache-Control']).toBe('no-cache');
  });
});