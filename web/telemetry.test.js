// ============================================================
// CHOKA BARAH – Back-end observability "trace" checks (Phase 7)
// Validates the structured (NDJSON/OpenTelemetry-style) telemetry
// engine in telemetry.js: record schema, span start/end nesting,
// severity & level gating, sink correctness and buffer cap. This is
// the "backend trace" companion to the browser E2E layers.
// ============================================================
'use strict';
const { telemetry, LEVELS } = require('./telemetry.js');

function spy(fn) {
  const calls = [];
  const orig = console[fn];
  console[fn] = (...a) => { calls.push(a); };
  return () => { console[fn] = orig; return calls; };
}

function spyMethods(methods) {
  const orig = {};
  const calls = {};
  methods.forEach((m) => {
    orig[m] = console[m];
    calls[m] = [];
    console[m] = (...a) => { calls[m].push(a); };
  });
  return { calls, restore: () => methods.forEach((m) => { console[m] = orig[m]; }) };
}

beforeEach(() => {
  // Force the singleton on at TRACE level for a clean, observable sink.
  telemetry.config.enabled = true;
  telemetry.config.minLevel = LEVELS.TRACE;
  telemetry.config.levelName = 'TRACE';
  telemetry.buffer = [];
});
afterEach(() => {
  telemetry.config.enabled = false;
  telemetry.config.minLevel = LEVELS.INFO;
  telemetry.config.levelName = 'INFO';
  telemetry.buffer = [];
});

function collect() {
  const recs = [];
  const off = telemetry.subscribe(r => recs.push(r));
  return { recs, unwrap() { off(); return recs; } };
}

describe('Telemetry enablement & gating', () => {
  test('is disabled by default and isEnabled reflects config', () => {
    telemetry.config.enabled = false;
    expect(telemetry.isEnabled()).toBe(false);
    const c = collect();
    telemetry.info('engine', 'test.off', 'should not be recorded', {});
    c.unwrap();
    expect(c.recs).toHaveLength(0);
  });

  test('records are emitted once enabled', () => {
    const c = collect();
    telemetry.info('engine', 'test.on', 'recorded', { k: 1 });
    const recs = c.unwrap();
    expect(recs).toHaveLength(1);
    expect(c.recs).toHaveLength(1);
  });

  test('level filtering drops sub-threshold records', () => {
    telemetry.config.minLevel = LEVELS.INFO;
    const c = collect();
    telemetry.debug('engine', 'a.debug', 'dropped', {});
    telemetry.info('engine', 'b.info', 'kept', {});
    const recs = c.unwrap();
    expect(recs).toHaveLength(1);
    expect(recs[0].event).toBe('b.info');
  });
});

describe('Structured record schema', () => {
  test('every record carries full structured fields', () => {
    const c = collect();
    telemetry.warn('ui', 'warn.example', 'some warning', { reason: 'x' });
    const [rec] = c.unwrap();
    expect(typeof rec.timestamp).toBe('string');
    expect(rec.severity).toBe('WARN');
    expect(rec.level).toBe(LEVELS.WARN);
    expect(rec.logger).toBe('ui');
    expect(rec.event).toBe('warn.example');
    expect(rec.sessionId).toMatch(/^sess_/);
    expect(typeof rec.traceId).toBe('string');
    expect(rec.message).toBe('some warning');
    expect(rec.context).toEqual({ reason: 'x' });
    // Round-trips through JSON (aggregator-safe NDJSON body).
    expect(JSON.parse(JSON.stringify(rec))).toEqual(rec);
  });
});

describe('Span start/end (OpenTelemetry-style)', () => {
  test('nested spans get parent links and duration on end', () => {
    const c = collect();
    const outer = telemetry.startSpan('outer', { step: 'begin' });
    const inner = telemetry.startSpan('inner', {});
    telemetry.endSpan(inner, { outcome: 'done' });
    telemetry.endSpan(outer, { ok: true });
    const recs = c.unwrap();

    const innerEnd = recs.find(r => r.event === 'span.end' && r.context.spanId === inner);
    const outerEnd = recs.find(r => r.event === 'span.end' && r.context.spanId === outer);
    expect(innerEnd.context.parentId).toBe(outer);        // nested correctly
    expect(typeof innerEnd.context.durationMs).toBe('number');
    expect(outerEnd.context.durationMs).toBeGreaterThanOrEqual(0);
    expect(innerEnd.context.parentId).toBe(outer);
  });

  test('ending an unknown span is a safe no-op', () => {
    const c = collect();
    telemetry.endSpan('no-such-span', {});
    const recs = c.unwrap();
    expect(recs.filter(r => r.event === 'span.end' && r.context.spanId === 'no-such-span')).toHaveLength(0);
  });

  test('start/end handle a missing fields argument via the empty-fields fallback', () => {
    const c = collect();
    const spanId = telemetry.startSpan('no-fields');
    telemetry.endSpan(spanId);
    const recs = c.unwrap();
    expect(recs.filter(r => r.event === 'span.start' || r.event === 'span.end')).toHaveLength(2);
    // fields/context restored to {} in the spread fallback, so records stay aggregate-safe.
    for (const r of recs) expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });

  test('message and context omitted fall back to empty defaults', () => {
    const c = collect();
    telemetry.info('engine', 'no.msg');
    const [rec] = c.unwrap();
    expect(rec.message).toBe('');
    expect(rec.context).toEqual({});
  });
});

describe('console severity dispatch & sink fallbacks', () => {
  test('error dispatches through console.error', () => {
    const s = spyMethods(['error', 'warn', 'debug', 'info', 'log']);
    telemetry.error('engine', 'err.x', 'boom', {});
    s.restore();
    expect(s.calls.error).toHaveLength(1);
  });

  test('warn dispatches through console.warn', () => {
    const s = spyMethods(['warn']);
    telemetry.warn('ui', 'warn.x', 'careful');
    s.restore();
    expect(s.calls.warn).toHaveLength(1);
  });

  test('debug dispatches through console.debug', () => {
    const s = spyMethods(['debug']);
    telemetry.debug('ui', 'dbg.x', 'trace detail');
    s.restore();
    expect(s.calls.debug).toHaveLength(1);
  });

  test('info dispatches through console.info', () => {
    const s = spyMethods(['info']);
    telemetry.info('ui', 'info.x', 'note');
    s.restore();
    expect(s.calls.info).toHaveLength(1);
  });

  test('records survive when no console is available', () => {
    const origConsole = globalThis.console;
    const buffer = [];
    const off = telemetry.subscribe((r) => buffer.push(r));
    // @ts-expect-error console is optional per telemetry contract
    globalThis.console = null;
    try {
      telemetry.info('engine', 'no.console', 'silent', {});
    } finally {
      globalThis.console = origConsole;
    }
    off();
    expect(buffer).toHaveLength(1);
  });

  test('unsubscribe removes exactly one listener and is idempotent', () => {
    const recs = [];
    const off = telemetry.subscribe((r) => recs.push(r));
    off();                          // removes the listener
    off();                          // second call is a safe no-op (i === -1)
    telemetry.info('engine', 'after.unsub', 'm', {});
    expect(recs).toHaveLength(0);
  });
});

describe('Buffer cap & JSON sink', () => {
  test('buffer stops growing past maxBuffer', () => {
    telemetry.config.maxBuffer = 5;
    telemetry.buffer = [];
    for (let i = 0; i < 12; i++) telemetry.info('engine', 'b.' + i, 'x', {});
    expect(telemetry.buffer.length).toBe(5);
  });

  test('json sink emits parseable single-line records', () => {
    telemetry.config.sink = 'json';
    const log = spy('log');
    telemetry.info('engine', 'sink.json', 'hello', { a: 1 });
    const calls = log();
    expect(calls.length).toBe(1);
    JSON.parse(calls[0][0]);                          // must not throw
    telemetry.config.sink = 'console';
  });

  test('json sink is buffered even when the platform console is unavailable', () => {
    telemetry.config.sink = 'json';
    const origConsole = globalThis.console;
    globalThis.console = false;                      // falsy: log branch skipped
    try {
      telemetry.info('engine', 'sink.no.console', 'hello', {});
    } finally {
      globalThis.console = origConsole;
    }
    telemetry.config.sink = 'console';
    expect(telemetry.buffer.length).toBeGreaterThan(0);
  });
});