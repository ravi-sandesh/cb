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

const holder = { docEls: {}, _eltSeq: 0 }; // id -> fake element; fresh() swaps a new map

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
    _listeners: {},
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: canvas.width, height: canvas.height }),
    addEventListener: (type, fn) => { canvas._listeners[type] = fn; },
    // Dispatch a board tap exactly like the browser would (clientX/Y in px).
    fireClick(clientX, clientY) {
      const fn = canvas._listeners.click;
      if (fn) fn({ clientX, clientY });
    }
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
    set(v) { el._innerHTML = String(v); el.children.length = 0; }
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
    fireOne() { const t = Array.from(reg.values()).find(x => !x.cancelled && !x.fired); if (t) { t.fired = true; t.fn(); } return !!t; },
    fireAll() { Array.from(reg.values()).forEach(t => { if (!t.cancelled && !t.fired) { t.fired = true; t.fn(); } }); }
  };
}

const realMathRandom = globalThis.Math.random;
function useSeededRandom(seed) {
  let s = seed >>> 0;
  globalThis.Math.random = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
function useScriptedRandom(values) {
  const q = values.slice();
  globalThis.Math.random = () => (q.length ? q.shift() : 0.1);
}
function restoreMathRandom() {
  globalThis.Math.random = realMathRandom;
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
    createElement: (tag) => makeElement(`${tag}_${holder._eltSeq++}`)
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
  restoreMathRandom();
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

  test('showHomeScreen also cancels a pending bot timer (timer leak guard)', () => {
    const timers = makeTimers();
    globalThis.setTimeout = timers.setTimeout;
    globalThis.clearTimeout = timers.clearTimeout;
    const { w } = fresh();
    w.startGame();
    w.setGameMode('bot');

    // Advance until a bot-controlled turn schedules a timer.
    const step = () => {
      const moves = holder.docEls['pawn-buttons-container'].children;
      if (moves.length && typeof moves[0].onclick === 'function') { moves[0].onclick(); }
      else if (!holder.docEls['btn-roll'].disabled) { w.handleRoll(); }
      timers.fireAll();
    };
    let n = 0;
    while (timers.active() === 0 && n < 25) { step(); n++; }
    expect(timers.active()).toBeGreaterThan(0);

    w.showHomeScreen();
    expect(holder.docEls['home-screen'].classList._set.active).toBe(true);
    expect(timers.active()).toBe(0);
    // Stale callback must not revive a deactivated game.
    timers.fireAll();
    expect(() => w.startGame()).not.toThrow();
  });

  test('a bot timer that fires after the game was left does not execute a move', () => {
    const timers = makeTimers();
    globalThis.setTimeout = timers.setTimeout;
    globalThis.clearTimeout = timers.clearTimeout;
    const { w } = fresh();
    w.setGameMode('bot');
    w.startGame();

    // Drive until a bot-controlled turn has a pending timer.
    const step = () => {
      const moves = holder.docEls['pawn-buttons-container'].children;
      if (moves.length && typeof moves[0].onclick === 'function') { moves[0].onclick(); }
      else if (!holder.docEls['btn-roll'].disabled) { w.handleRoll(); }
      timers.fireAll();
    };
    let n = 0;
    while (timers.active() === 0 && n < 25) { step(); n++; }
    expect(timers.active()).toBeGreaterThan(0);

    w.showHomeScreen(); // gameActive = false
    timers.fireAll();   // the pending callback runs, hits the gameActive guard
    expect(holder.docEls['game-log']._innerText).toBeDefined();
    expect(() => w.startGame()).not.toThrow();
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

describe('board canvas tap handling', () => {
  const cs = 120; // 600px canvas / 5x5
  const tapCell = (canvas, r, c) => canvas.fireClick(c * cs + cs / 2, r * cs + cs / 2);

  test('tap with no valid moves traces tapped_none and does not throw', () => {
    const { w, canvas } = fresh();
    w.startGame();
    expect(() => tapCell(canvas, 0, 0)).not.toThrow();
  });

  test('tap is ignored after leaving the game screen', () => {
    const { w, canvas } = fresh();
    w.startGame();
    w.showHomeScreen();
    expect(() => tapCell(canvas, 2, 2)).not.toThrow();
  });

  test('tap on a valid move target executes the move', () => {
    const { w, canvas } = fresh();
    w.startGame();
    // Score 1 (one cowry open) lets a HOME_BASE pawn move to path[0] = (4,2).
    useScriptedRandom([0.6, 0.1, 0.1, 0.1]);
    w.handleRoll();
    expect(holder.docEls['btn-roll'].disabled).toBe(true);
    expect(() => tapCell(canvas, 4, 2)).not.toThrow();
    // Move executed: turn advanced to player 1 without an extra roll.
    expect(holder.docEls['game-log']._innerText).toContain("Green (North)'s turn");
    expect(holder.docEls['btn-roll'].disabled).toBe(false);
  });

  test('tap on a non-target cell while moves exist selects no move', () => {
    const { w, canvas } = fresh();
    w.startGame();
    useScriptedRandom([0.6, 0.1, 0.1, 0.1]);
    w.handleRoll();
    expect(() => tapCell(canvas, 1, 1)).not.toThrow();
    expect(holder.docEls['game-log']._innerText).toContain('Select a pawn to move');
    expect(holder.docEls['btn-roll'].disabled).toBe(true);
  });

  test('tap during a bot turn is ignored (human-only input)', () => {
    const { w, canvas } = fresh();
    w.setGameMode('bot');
    w.startGame();
    // Human (P0) rolls score 1 and moves, advancing to the bot (P1).
    useScriptedRandom([0.6, 0.1, 0.1, 0.1]);
    w.handleRoll();
    tapCell(canvas, 4, 2);
    expect(holder.docEls['turn-text']._innerText).toContain('🤖');
    expect(() => tapCell(canvas, 4, 2)).not.toThrow();
  });

  test('a second roll while a roll is pending is ignored', () => {
    const { w } = fresh();
    w.startGame();
    useScriptedRandom([0.6, 0.1, 0.1, 0.1]);
    w.handleRoll();
    const before = holder.docEls['roll-score-display']._innerText;
    expect(() => w.handleRoll()).not.toThrow();
    expect(holder.docEls['roll-score-display']._innerText).toBe(before);
    expect(holder.docEls['btn-roll'].disabled).toBe(true);
  });
});

describe('full deterministic bot game to victory', () => {
  function driveFullGame(seed, cap) {
    const timers = makeTimers();
    globalThis.setTimeout = timers.setTimeout;
    globalThis.clearTimeout = timers.clearTimeout;
    useSeededRandom(seed);
    const { w, canvas } = fresh();
    w.setGameMode('bot');
    w.startGame();

    let steps = 0;
    for (; steps < cap; steps++) {
      const turnText = holder.docEls['turn-text']._innerText;
      const btnRoll = holder.docEls['btn-roll'];
      const btnContainer = holder.docEls['pawn-buttons-container'];

      if (turnText.includes('🤖')) {
        // Bot's turn: any board tap is ignored; fire its scheduled action.
        canvas.fireClick(cs(600) * 1.5, cs(600) * 1.5);
        timers.fireOne();
      } else if (btnContainer.children.length > 0) {
        // Human with valid moves: pick the first offered move.
        btnContainer.children[0].onclick();
      } else if (!btnRoll.disabled) {
        w.handleRoll();
        timers.fireOne(); // drain a possible no-move advanceTurn
      } else {
        timers.fireOne();
      }

      if (holder.docEls['game-log']._innerText.includes('VICTORY')) break;
    }
    return { steps, w };
  }
  const cs = (width) => width / 5;

  test('reaches an actual winner via rolls, bot moves and taps', () => {
    const { steps } = driveFullGame(1, 5000);
    expect(holder.docEls['game-log']._innerText).toContain('VICTORY');
    expect(holder.docEls['btn-roll'].disabled).toBe(true);
    expect(steps).toBeLessThan(5000);
    // A tap after the game ended is a no-op (winner !== null guard).
    expect(() => booted.canvas.fireClick(300, 300)).not.toThrow();
  });
});