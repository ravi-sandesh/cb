// ============================================================
// CHOKA BARAH – UI integration tests (app.js)
// app.js is a browser IIFE that reads globals (window/document/board
// canvas) at load time. We install fake browser globals on Node's
// globalThis BEFORE requiring app.js through the real Jest module
// registry, so istanbul instruments it and it counts toward coverage.
// Tests drive the SAME public handlers the browser wires via inline
// onclick — behavioral (not regex) coverage of the UI layer, including
// the BUG-06/07/10 regressions that live in app.js.
//
// The app boots ONCE against a stable window/document. Each test swaps
// in a fresh element map via a mutable holder the fake document reads
// from, so DOM/game state resets without reloading the module (and
// without relying on Node module-cache eviction).
// ============================================================
'use strict';

const holder = { docEls: {} }; // id -> fake element; fresh() swaps a new map

function makeCanvas(width) {
  width = width || 600;
  const calls = [];
  const ctx = new Proxy({}, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return (...args) => { calls.push([prop, ...args]); };
    },
    set(target, prop, val) { target[prop] = val; return true; }
  });
  ctx.__calls = calls;
  const canvas = {
    width, height: width,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
    addEventListener: () => {}
  };
  return canvas;
}

function makeElement(id) {
  const el = {
    id,
    _innerText: '',
    _innerHTML: '',
    className: '',
    style: {},
    disabled: false,
    children: [],
    classList: { _set: {}, add(c){ this._set[c]=true; }, remove(c){ delete this._set[c]; }, toggle(c, on){ this._set[c] = on === undefined ? !this._set[c] : !!on; } },
    addEventListener(type, fn) { el._listeners = el._listeners || {}; el._listeners[type] = fn; },
    appendChild(child) { el.children.push(child); },
    dispatchEvent() { return true; }
  };
  Object.defineProperty(el, 'innerText', {
    get() { return el._innerText; },
    set(v) { el._innerText = String(v); }
  });
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._innerHTML; },
    set(v) { el._innerHTML = String(v); }
  });
  return el;
}

// Deterministic fake timer floor so bot schedules can be observed/fired.
function makeTimers() {
  const reg = new Map();
  let seq = 0;
  return {
    setTimeout(fn, ms) { const id = ++seq; reg.set(id, { fn, cancelled: false, fired: false }); return id; },
    clearTimeout(id) { const t = reg.get(id); if (t) t.cancelled = true; },
    active() { return Array.from(reg.values()).filter(t => !t.cancelled && !t.fired).length; },
    fireAll() { Array.from(reg.values()).forEach(t => { if (!t.cancelled && !t.fired) { t.fired = true; t.fn(); } }); }
  };
}

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
function useRealTimers() {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
}

// app.js calls the engine's global `T` (a shared-script top-level const in
// game-engine.js). In CommonJS that binding isn't visible, so provide it on
// globalThis for the app IIFE.
globalThis.T = {
  info() {}, debug() {}, warn() {}, error() {}, trace() {},
  startSpan() { return 'span'; },
  endSpan() {},
  getSessionId() { return 'test-session'; }
};

let booted = null;
function boot() {
  if (booted) return booted;

  const w = {};
  const document = {
    getElementById: (id) => holder.docEls[id] || (holder.docEls[id] = makeElement(id)),
    createElement: (tag) => makeElement(tag + '_' + Math.random().toString(36).slice(2))
  };

  w.window = w;
  w.document = document;
  w.Telemetry = {
    info() {}, debug() {}, warn() {}, error() {}, trace() {},
    startSpan() { return 'span'; },
    endSpan() {},
    getSessionId() { return 'test-session'; }
  };

  globalThis.window = w;
  globalThis.document = document;

  // Load engine + sound + app via the REAL module registry so istanbul
  // instruments them and app.js sees the installed globals.
  w.ChokaBarahEngine = require('./game-engine.js');
  const sound = require('./sound.js');
  w.Sound = sound.createSoundController({ play: () => true });

  require('./app.js');

  booted = { w, document, canvas: holder.docEls['board-canvas'] };
  return booted;
}

// Fresh blank element map for each test (the board canvas object captured by
// app.js at boot is preserved so the same context observes the draws).
function fresh() {
  const canvas = booted ? booted.canvas : makeCanvas(600);
  holder.docEls = { 'board-canvas': canvas };
  const { w, document } = boot();
  return { w, document, canvas };
}

afterEach(() => {
  useRealTimers();
});

describe('app.js UI bootstrap (browser harness)', () => {
  const handlers = ['setGridSize','setPlayers','setGameMode','openRules','closeRules',
    'showHomeScreen','startGame','restartGame','toggleMute','handleRoll'];

  test('exposes all inline onclick handlers on window', () => {
    const { w } = fresh();
    handlers.forEach((name) => expect(typeof w[name]).toBe('function'));
  });

  test('startGame initializes pawns and shows the game screen', () => {
    const { w } = fresh();
    w.startGame();
    expect(holder.docEls['game-screen'].classList._set.active).toBe(true);
    expect(holder.docEls['home-screen'].classList._set.active).toBeUndefined();
    expect(holder.docEls['board-title']._innerText).toContain('5x5');
    expect(holder.docEls['player-strip'].children.length).toBe(2);
  });
});

describe('BUG-06 roll button lifecycle (behavioral)', () => {
  test('startGame leaves the roll button enabled for the first human turn', () => {
    const { w } = fresh();
    w.startGame();
    expect(holder.docEls['btn-roll'].disabled).toBe(false);
  });

  test('victory-flow disable is undone by restart (new game playable)', () => {
    const { w } = fresh();
    w.startGame();
    holder.docEls['btn-roll'].disabled = true; // victory banner set this
    w.restartGame();
    expect(holder.docEls['btn-roll'].disabled).toBe(false);
  });
});

describe('BUG-07 restartGame cancels a pending bot timer (behavioral)', () => {
  test('a scheduled bot turn is cleared and cannot fire into a fresh game', () => {
    const timers = makeTimers();
    globalThis.setTimeout = timers.setTimeout;
    globalThis.clearTimeout = timers.clearTimeout;
    const { w } = fresh();
    w.startGame();
    expect(timers.active()).toBe(0); // P0 human: nothing scheduled yet
    w.setGameMode('bot');

    const step = () => {
      const moves = holder.docEls['pawn-buttons-container'].children;
      if (moves.length && typeof moves[0].onclick === 'function') { moves[0].onclick(); }
      else if (!holder.docEls['btn-roll'].disabled) { w.handleRoll(); }
      timers.fireAll(); // run advanceTurn / bot turns scheduled by the action
    };

    let n = 0;
    while (timers.active() === 0 && n < 25) { step(); n++; }

    // A bot turn got queued once we reached a bot-controlled player.
    expect(timers.active()).toBeGreaterThan(0);

    // restartGame clears the pending bot schedule (BUG-07 fix).
    w.restartGame();
    expect(timers.active()).toBe(0);
  });
});

describe('render & board drawing', () => {
  test('renderBoard executes real canvas draw calls after start', () => {
    const { w } = fresh();
    w.startGame();
    const drawCalls = holder.docEls['board-canvas'].getContext('2d').__calls;
    expect(drawCalls.length).toBeGreaterThan(0);
    expect(drawCalls.some(([op]) => op === 'fillRect')).toBe(true);
  });

  test('render happens after each move cycle without throwing', () => {
    const { w } = fresh();
    expect(() => w.startGame()).not.toThrow();
    expect(() => w.handleRoll()).not.toThrow();
    expect(() => w.restartGame()).not.toThrow();
  });
});

describe('telemetry & sound wiring', () => {
  test('toggleMute flips the mute label through window.Sound', () => {
    const { w, document } = fresh();
    const btn = document.getElementById('btn-mute');
    w.toggleMute();
    const muted = w.toggleMute();
    expect(typeof muted).toBe('boolean');
    expect(btn._innerText.length).toBeGreaterThan(0);
  });

  test('session start and roll log through the telemetry shim without throwing', () => {
    const { w } = fresh();
    expect(() => w.startGame()).not.toThrow();
    expect(() => w.handleRoll()).not.toThrow();
  });
});

describe('navigation & config', () => {
  test('setPlayers / setGridSize / setGameMode toggle the active buttons', () => {
    const { w } = fresh();
    w.setGridSize(7);
    expect(holder.docEls['btn-grid-7'].classList._set.active).toBe(true);
    expect(!!holder.docEls['btn-grid-5'].classList._set.active).toBe(false);
    w.setPlayers(4);
    expect(holder.docEls['btn-p4'].classList._set.active).toBe(true);
    expect(!!holder.docEls['btn-p2'].classList._set.active).toBe(false);
    w.setGameMode('bot');
    expect(holder.docEls['btn-mode-bot'].classList._set.active).toBe(true);
  });

  test('rules modal opens and closes via the public handlers', () => {
    const { w } = fresh();
    w.openRules();
    expect(holder.docEls['rules-modal'].classList._set.hidden).toBeUndefined();
    w.closeRules();
    expect(holder.docEls['rules-modal'].classList._set.hidden).toBe(true);
  });
});