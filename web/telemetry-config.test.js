// ============================================================
// CHOKA BARAH – Telemetry config resolution edges
// telemetry.js reads enablement at LOAD time from (highest first):
//   1. window.__CHOKA_ENV__          (embedder)
//   2. URL query params              (location.search)
//   3. localStorage keys             (cb.telemetry.*)
//   4. fallbacks / dev-mode defaults
// Each test rebuilds the singleton with a different global soup so
// the resolution precedence and the truthy/fallback branches in
// env(), truthy(), loadConfig() and genId() are all exercised.
// ============================================================
'use strict';

const ORIG = {
  env: globalThis.__CHOKA_ENV__,
  telemetry: globalThis.__CHOKA_TELEMETRY__,
  location: globalThis.location,
  localStorage: globalThis.localStorage,
  crypto: globalThis.crypto
};

function withGlobals(opts) {
  delete globalThis.__CHOKA_ENV__;
  delete globalThis.__CHOKA_TELEMETRY__;
  delete globalThis.location;
  delete globalThis.localStorage;
  setCrypto(ORIG.crypto);
  if (opts.env) globalThis.__CHOKA_ENV__ = opts.env;
  if (opts.telemetry) globalThis.__CHOKA_TELEMETRY__ = opts.telemetry;
  if (opts.location) globalThis.location = opts.location;
  if (opts.localStorage) {
    globalThis.localStorage = {
      getItem: (k) => (opts.localStorage[k] !== undefined ? opts.localStorage[k] : null)
    };
  }
  if ('crypto' in opts) setCrypto(opts.crypto);
}

// globalThis.crypto is a getter-only accessor in Node; freeze it via
// defineProperty so telemetry.js sees the value we set.
function setCrypto(value) {
  try {
    Object.defineProperty(globalThis, 'crypto', { value, configurable: true, writable: true });
  } catch (e) {
    globalThis.crypto = value;
  }
}

function restoreGlobals() {
  delete globalThis.__CHOKA_ENV__;
  delete globalThis.__CHOKA_TELEMETRY__;
  delete globalThis.location;
  delete globalThis.localStorage;
  setCrypto(ORIG.crypto);
  if (ORIG.env !== undefined) globalThis.__CHOKA_ENV__ = ORIG.env;
  if (ORIG.telemetry !== undefined) globalThis.__CHOKA_TELEMETRY__ = ORIG.telemetry;
  if (ORIG.location !== undefined) globalThis.location = ORIG.location;
  if (ORIG.localStorage !== undefined) globalThis.localStorage = ORIG.localStorage;
}

function freshTelemetry() {
  jest.resetModules();
  return require('./telemetry.js').telemetry;
}

afterEach(() => restoreGlobals());

describe('telemetry config resolution (module-load)', () => {
  test('__CHOKA_ENV__ wins over query params and localStorage', () => {
    withGlobals({
      env: { CB_TELEMETRY_ENABLED: true, CB_TELEMETRY_LEVEL: 'WARN', CB_TELEMETRY_SINK: 'console' },
      location: { search: '?CB_TELEMETRY_ENABLED=false&CB_TELEMETRY_LEVEL=debug' },
      localStorage: { 'cb.telemetry.enabled': '0' }
    });
    const tel = freshTelemetry();
    expect(tel.isEnabled()).toBe(true);
    expect(tel.config.levelName).toBe('WARN');
    expect(tel.config.minLevel).toBe(40);
  });

  test('an empty embedder value falls through to the query string', () => {
    withGlobals({
      env: { CB_TELEMETRY_ENABLED: '', CB_TELEMETRY_LEVEL: '' },
      location: { search: '?CB_TELEMETRY_ENABLED=true&CB_TELEMETRY_LEVEL=debug' }
    });
    const tel = freshTelemetry();
    expect(tel.isEnabled()).toBe(true);
    expect(tel.config.levelName).toBe('DEBUG');
  });

  test('query string wins over localStorage, and parse handles query booleans', () => {
    withGlobals({
      location: { search: '?CB_TELEMETRY_ENABLED=false&CB_TELEMETRY_SINK=json' },
      localStorage: { 'cb.telemetry.enabled': 'true' }
    });
    const tel = freshTelemetry();
    expect(tel.isEnabled()).toBe(false); // 'false' parsed by truthy()
    expect(tel.config.sink).toBe('json');
  });

  test('localStorage supplies enablement when nothing higher is present', () => {
    withGlobals({ localStorage: { 'cb.telemetry.enabled': '1', 'cb.telemetry.level': 'debug' } });
    const tel = freshTelemetry();
    expect(tel.isEnabled()).toBe(true); // truthy('1', fallback)
    expect(tel.config.levelName).toBe('DEBUG');
  });

  test('module default is disabled with INFO level when no source is present', () => {
    withGlobals({});
    const tel = freshTelemetry();
    expect(tel.isEnabled()).toBe(false);
    expect(tel.config.minLevel).toBe(30);
    expect(tel.config.sink).toBe('console');
  });

  test('legacy __CHOKA_TELEMETRY__ override is used as the fallback chain', () => {
    withGlobals({
      telemetry: { enabled: true, level: 'ERROR', maxBuffer: 2500 }
    });
    const tel = freshTelemetry();
    expect(tel.isEnabled()).toBe(true);
    expect(tel.config.levelName).toBe('ERROR');
    expect(tel.config.maxBuffer).toBe(2500);
  });

  test('bad level name falls back to INFO', () => {
    withGlobals({ location: { search: '?CB_TELEMETRY_LEVEL=chatty&CB_TELEMETRY_ENABLED=on' } });
    const tel = freshTelemetry();
    expect(tel.config.levelName).toBe('CHATTY');
    expect(tel.config.minLevel).toBe(30);
  });

  test('a non-numeric CB_TELEMETRY_BUFFER falls back to 2000', () => {
    withGlobals({ location: { search: '?CB_TELEMETRY_BUFFER=abc' } });
    const tel = freshTelemetry();
    expect(tel.config.maxBuffer).toBe(2000);
  });

  test('genId uses the Math.random fallback when crypto.randomUUID is absent', () => {
    withGlobals({ crypto: undefined });
    const tel = freshTelemetry();
    expect(typeof tel.getSessionId()).toBe('string');
    expect(tel.getSessionId()).toMatch(/^sess_[0-9a-f]{12}$/);
  });

  test('setLevel only accepts known level names', () => {
    withGlobals({});
    const tel = freshTelemetry();
    tel.setLevel('WARN');
    expect(tel.config.minLevel).toBe(40);
    tel.setLevel('no-such-level');
    expect(tel.config.minLevel).toBe(40); // unchanged
    expect(tel.config.levelName).toBe('WARN');
  });
});