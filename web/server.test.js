// ============================================================
// CHOKA BARAH – Static server unit tests
// Exercises handleRequest directly (no real port) so routing,
// MIME types, 404s and the BUG-24 boundary-containment guard
// are covered by the same jest suite as the rest of the web app.
// ============================================================
'use strict';
const { createServer, handleRequest, MIME, PORT } = require('./server.js');

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