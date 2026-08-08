// ============================================================
// CHOKA BARAH – Structured Telemetry / Observability Logger
// ------------------------------------------------------------
// Google/Meta-style structured (NDJSON) logging engine, gated by
// an environment flag so that it imposes ZERO runtime cost when
// disabled.
//
// Enablement is resolved from (highest priority first):
//   1. window.__CHOKA_ENV__ / window.__CHOKA_TELEMETRY__  (embedder/bundler)
//   2. URL query params:  ?CB_TELEMETRY_ENABLED=true&CB_TELEMETRY_LEVEL=debug&CB_TELEMETRY_SINK=json
//   3. localStorage keys: cb.telemetry.enabled / cb.telemetry.level
//   4. Default: disabled unless code is clearly in dev mode
//
// Output formats:
//   sink = 'json'    -> one NDJSON object per line (log aggregators: ELK, GCP Cloud Logging, Grafana Loki)
//   sink = 'console' -> human-friendly prefix + JSON context
//
// Record schema (aligned with structured logging best practices):
//   timestamp, severity, level, logger(component), event, sessionId,
//   traceId, spanId, message, context{}
// ============================================================

(function (global) {
  'use strict';

  var LEVELS = { TRACE: 10, DEBUG: 20, INFO: 30, WARN: 40, ERROR: 50 };

  // ---- Config resolution helpers ----
  function env(name, fallback) {
    if (global.__CHOKA_ENV__ && name in global.__CHOKA_ENV__) {
      var v = global.__CHOKA_ENV__[name];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    if (global.location) {
      var qp = new URLSearchParams(global.location.search);
      if (qp.has(name)) return qp.get(name);
    }
    return fallback;
  }

  function localStorageGet(key) {
    try {
      if (global.localStorage) return global.localStorage.getItem(key);
    } catch (e) { /* storage may be unavailable (private mode / SSR) */ }
    return null;
  }

  function truthy(v, fallback) {
    if (v === undefined || v === null || v === '') return fallback;
    if (typeof v === 'boolean') return v;
    var s = String(v).toLowerCase();
    return !(s === '0' || s === 'false' || s === 'off' || s === 'no');
  }

  function loadConfig() {
    var override = global.__CHOKA_TELEMETRY__ || {};
    var enabled = truthy(
      env('CB_TELEMETRY_ENABLED', override.enabled !== undefined ? String(override.enabled) : localStorageGet('cb.telemetry.enabled')),
      false
    );

    var levelRaw = (
      env('CB_TELEMETRY_LEVEL', override.level || localStorageGet('cb.telemetry.level')) || 'INFO'
    ).toUpperCase();
    var minLevel = LEVELS[levelRaw] || LEVELS.INFO;

    var sinkName = env('CB_TELEMETRY_SINK', override.sink || 'console');

    var maxBuffer = parseInt(
      env('CB_TELEMETRY_BUFFER', override.maxBuffer != null ? String(override.maxBuffer) : '2000'), 10
    ) || 2000;

    return { enabled: enabled, minLevel: minLevel, levelName: levelRaw, sink: sinkName, maxBuffer: maxBuffer };
  }

  function genId() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return global.crypto.randomUUID();
    }
    return 'xxxxxxxxxxxx'.replace(/x/g, function () {
      return Math.floor(Math.random() * 16).toString(16);
    });
  }

  function fmtTs(iso) {
    try { return new Date(iso).toISOString(); } catch (e) { return iso; }
  }

  function Telemetry(config) {
    this.config = config;
    this.sessionId = 'sess_' + genId();
    this.traceId = this.sessionId;
    this.spanStack = [];
    this.buffer = [];
    this.listeners = [];
  }

  Telemetry.prototype.isEnabled = function () { return !!this.config.enabled; };
  Telemetry.prototype.getSessionId = function () { return this.sessionId; };
  Telemetry.prototype.getTraceId = function () { return this.traceId; };

  Telemetry.prototype.setLevel = function (lv) {
    var name = String(lv).toUpperCase();
    if (LEVELS[name]) { this.config.minLevel = LEVELS[name]; this.config.levelName = name; }
  };

  // OpenTelemetry-style spans: nestable operation tracing.
  Telemetry.prototype.startSpan = function (name, fields) {
    var spanId = genId();
    var parent = this.spanStack.length ? this.spanStack[this.spanStack.length - 1] : null;
    var span = {
      name: name,
      spanId: spanId,
      parentId: parent ? parent.spanId : null,
      start: Date.now(),
      fields: fields || {}
    };
    this.spanStack.push(span);
    this._log(LEVELS.TRACE, 'TRACE', 'telemetry', 'span.start', 'start span ' + name, { spanId: spanId, parentId: span.parentId, name: name, ...(fields || {}) });
    return spanId;
  };

  Telemetry.prototype.endSpan = function (spanId, fields) {
    var idx = -1;
    for (var i = 0; i < this.spanStack.length; i++) {
      if (this.spanStack[i].spanId === spanId) { idx = i; break; }
    }
    if (idx === -1) return;
    var span = this.spanStack.splice(idx, 1)[0];
    var durationMs = Date.now() - span.start;
    this._log(LEVELS.DEBUG, 'DEBUG', 'telemetry', 'span.end', 'end span ' + span.name + ' (' + durationMs + 'ms)',
      { spanId: span.spanId, parentId: span.parentId, name: span.name, durationMs: durationMs, ...span.fields, ...(fields || {}) });
  };

  Telemetry.prototype._emit = function (rec) {
    this.buffer.push(rec);
    if (this.buffer.length > this.config.maxBuffer) this.buffer.shift();
    for (var i = 0; i < this.listeners.length; i++) {
      try { this.listeners[i](rec); } catch (e) { /* listener must not break logging */ }
    }

    var c = this.config;
    if (c.sink === 'json') {
      if (global.console && global.console.log) global.console.log(JSON.stringify(rec));
      return;
    }
    // console (human-friendly)
    var header = fmtTs(rec.timestamp) + ' [' + rec.severity + '] [' + rec.logger + '] ' + rec.event;
    var ctx = JSON.stringify(rec.context || {});
    var msg = header + ' ' + rec.message + (ctx !== '{}' ? ' ' + ctx : '');
    if (!global.console) return;
    if (rec.severity === 'ERROR') global.console.error(msg);
    else if (rec.severity === 'WARN') global.console.warn(msg);
    else if (rec.severity === 'DEBUG') global.console.debug(msg);
    else global.console.info(msg);
  };

  Telemetry.prototype._log = function (level, levelName, logger, event, message, context) {
    if (!this.config.enabled) return;
    if (level < this.config.minLevel) return;
    var rec = {
      timestamp: new Date().toISOString(),
      severity: levelName,
      level: level,
      logger: logger,
      event: event,
      sessionId: this.sessionId,
      traceId: this.traceId,
      spanId: this.spanStack.length ? this.spanStack[this.spanStack.length - 1].spanId : null,
      message: message || '',
      context: context || {}
    };
    this._emit(rec);
  };

  Telemetry.prototype.trace  = function (l, e, m, c) { this._log(10, 'TRACE', l, e, m, c); };
  Telemetry.prototype.debug  = function (l, e, m, c) { this._log(20, 'DEBUG', l, e, m, c); };
  Telemetry.prototype.info   = function (l, e, m, c) { this._log(30, 'INFO', l, e, m, c); };
  Telemetry.prototype.warn   = function (l, e, m, c) { this._log(40, 'WARN', l, e, m, c); };
  Telemetry.prototype.error  = function (l, e, m, c) { this._log(50, 'ERROR', l, e, m, c); };

  // Subscribe to records (in-app telemetry viewer hook).
  Telemetry.prototype.subscribe = function (fn) {
    this.listeners.push(fn);
    var tel = this;
    return function () {
      var i = tel.listeners.indexOf(fn);
      if (i >= 0) tel.listeners.splice(i, 1);
    };
  };

  Telemetry.prototype.flush = function () { this.buffer = []; };

  var telemetry = new Telemetry(loadConfig());

  global.Telemetry = telemetry;
  global.TelemetryLevels = LEVELS;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { telemetry: telemetry, LEVELS: LEVELS };
  }
})(typeof window !== 'undefined' ? window : globalThis);
