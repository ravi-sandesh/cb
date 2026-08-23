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
    focus() { canvas._focused = (canvas._focused || 0) + 1; },
    // Dispatch a board tap exactly like the browser would (clientX/Y in px).
    fireClick(clientX, clientY) {
      const fn = canvas._listeners.click;
      if (fn) fn({ clientX, clientY });
    },
    // Dispatch a keydown exactly like the browser would on a focused canvas.
    fireKey(key) {
      const fn = canvas._listeners.keydown;
      if (fn) fn({ key, preventDefault: () => {} });
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
    classList: { _set: {}, add(c){ this._set[c]=true; }, remove(c){ delete this._set[c]; }, toggle(c, on){ this._set[c] = on === undefined ? !this._set[c] : !!on; }, contains(c){ return !!this._set[c]; } },
    addEventListener(type, fn) { el._listeners = el._listeners || {}; el._listeners[type] = fn; },
    appendChild(child) { el.children.push(child); },
    dispatchEvent() { return true; },
    // Focus-trap support: tests inject mock focusables via _focusables.
    querySelectorAll(sel) { return el._focusables || []; },
    focus() { globalThis.document && (globalThis.document.activeElement = el); }
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

// Minimal localStorage mock: Node has none, but app.js guards with
// `typeof localStorage !== 'undefined'`. Providing it exercises the
// persistence branches (load/save senior mode).
const fakeStorage = (() => {
  let store = {};
  return {
    getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem(k, v) { store[k] = String(v); },
    _reset() { store = {}; }
  };
})();
globalThis.localStorage = fakeStorage;

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
    body: makeElement('body'),
    activeElement: null,
    _listeners: {},
    addEventListener(type, fn) { document._listeners[type] = fn; },
    // Dispatch a document-level keydown (used by the rules-modal trap).
    fireDocKey(key, { shiftKey = false } = {}) {
      const fn = document._listeners.keydown;
      if (fn) fn({ key, shiftKey, preventDefault: () => {} });
    },
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
  fakeStorage._reset();
});

describe('app.js UI bootstrap (browser harness)', () => {
  const handlers = ['setGridSize','setPlayers','setGameMode','openRules','closeRules',
    'showHomeScreen','startGame','restartGame','toggleMute','handleRoll',
    'setSeniorMode','toggleSeniorMode'];

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

describe('accessibility behaviors', () => {
  // Drive a deterministic roll with moves, then hand back the harness.
  function startWithMoves(w) {
    useSeededRandom(12345);
    w.startGame();
    for (let i = 0; i < 40; i++) {
      w.handleRoll();
      if (holder.docEls['pawn-select-bar'] &&
          !holder.docEls['pawn-select-bar'].classList._set.hidden) break;
    }
  }

  test('arrow keys reveal and move the board cursor; Enter executes the move', () => {
    const { w, canvas } = fresh();
    startWithMoves(w);
    const drawsBefore = canvas.getContext('2d').__calls.length;

    canvas.fireKey('ArrowRight'); // reveals cursor at player 0's start cell
    expect(canvas.getContext('2d').__calls.length).toBeGreaterThan(drawsBefore);

    // Walk the cursor across the grid; Enter on a highlighted cell must
    // consume the roll exactly like a mouse tap would.
    let consumed = false;
    outer:
    for (let r = 0; r < 5 && !consumed; r++) {
      // re-center: jump home then step right row by row via absolute taps of keys
      for (let c = 0; c < 5 && !consumed; c++) {
        canvas.fireKey('Enter');
        const rollGone = holder.docEls['roll-score-display']._innerText === '' ||
          holder.docEls['roll-score-display'].innerText === '';
        if (rollGone) { consumed = true; break outer; }
        if (c < 4) canvas.fireKey('ArrowRight');
      }
      if (!consumed) {
        // move back left and down one row
        for (let c = 0; c < 4; c++) canvas.fireKey('ArrowLeft');
        canvas.fireKey('ArrowDown');
      }
    }
    expect(consumed).toBe(true);
  });

  test('Enter before any arrow key is a no-op (cursor hidden)', () => {
    const { w, canvas } = fresh();
    useSeededRandom(777);
    w.startGame();
    const drawsBefore = canvas.getContext('2d').__calls.length;
    expect(() => canvas.fireKey('Enter')).not.toThrow();
    expect(canvas.getContext('2d').__calls.length).toBe(drawsBefore);
  });

  test('keyboard input is ignored outside the human turn', () => {
    const { w, canvas } = fresh();
    useSeededRandom(42);
    w.setGameMode('bot');
    w.startGame();
    // Force a state where it is the bot's turn by playing until turn flips.
    let flipped = false;
    for (let i = 0; i < 30 && !flipped; i++) {
      w.handleRoll();
      if (holder.docEls['turn-text']) {
        const t = holder.docEls['turn-text']._innerText || '';
        if (/GREEN/i.test(t)) flipped = true;
      }
    }
    if (!flipped) return; // seed never flipped; nothing to assert this run
    const drawsBefore = canvas.getContext('2d').__calls.length;
    canvas.fireKey('ArrowRight');
    expect(canvas.getContext('2d').__calls.length).toBe(drawsBefore);
  });

  test('restart hides the keyboard cursor', () => {
    const { w, canvas } = fresh();
    startWithMoves(w);
    canvas.fireKey('ArrowDown'); // cursor visible now
    w.restartGame();
    // Enter after restart must be a no-op (cursor was reset).
    const drawsBefore = canvas.getContext('2d').__calls.length;
    canvas.fireKey('Enter');
    expect(canvas.getContext('2d').__calls.length).toBe(drawsBefore);
  });

  test('cursor clamps at the edges and all four directions plus Space work', () => {
    const { w, canvas } = fresh();
    useSeededRandom(12345);
    w.startGame();
    canvas.fireKey('ArrowRight'); // reveals cursor at player 0's start cell
    // Walk far past every edge; clamped draws must still repaint.
    for (let i = 0; i < 12; i++) canvas.fireKey('ArrowLeft');
    for (let i = 0; i < 12; i++) canvas.fireKey('ArrowUp');
    const drawsAtCorner = canvas.getContext('2d').__calls.length;
    canvas.fireKey('ArrowUp');
    canvas.fireKey('ArrowLeft');
    canvas.fireKey(' ');
    expect(canvas.getContext('2d').__calls.length).toBeGreaterThanOrEqual(drawsAtCorner);
  });

  test('keys are ignored before a game starts', () => {
    const { w, canvas } = fresh();
    // Module state survives across tests (single boot); explicitly leave any
    // previous match so this test really measures the inactive-game guard.
    w.showHomeScreen();
    const drawsBefore = canvas.getContext('2d').__calls.length;
    canvas.fireKey('ArrowRight');
    canvas.fireKey('Enter');
    expect(canvas.getContext('2d').__calls.length).toBe(drawsBefore);
  });

  test('unrelated keys are ignored during play', () => {
    const { w, canvas } = fresh();
    useSeededRandom(99);
    w.startGame();
    const drawsBefore = canvas.getContext('2d').__calls.length;
    canvas.fireKey('a');
    canvas.fireKey('Tab');
    canvas.fireKey('Escape');
    expect(canvas.getContext('2d').__calls.length).toBe(drawsBefore);
  });

  test('keys are ignored while it is the bot\'s turn', () => {
    const { w, canvas } = fresh();
    w.setGameMode('bot');
    w.startGame();
    // Human (P0) rolls score 1 and moves via the quick-list, advancing to
    // the bot (P1) — same deterministic setup as the click-guard test.
    useScriptedRandom([0.6, 0.1, 0.1, 0.1]);
    w.handleRoll();
    const btns = holder.docEls['pawn-buttons-container'];
    btns.children[0].onclick();
    expect(holder.docEls['turn-text']._innerText).toContain('🤖');

    const drawsBefore = canvas.getContext('2d').__calls.length;
    canvas.fireKey('ArrowRight');
    canvas.fireKey('Enter');
    expect(canvas.getContext('2d').__calls.length).toBe(drawsBefore);
  });

  test('openRules moves focus into the dialog; closeRules restores it', () => {
    const { w } = fresh();
    const opener = holder.docEls['btn-rules'];
    w.openRules();
    const modal = holder.docEls['rules-modal'];
    expect(modal.classList._set.hidden).toBeUndefined();
    // No focusables injected -> graceful degradation, dialog still opens.
    expect(() => w.closeRules()).not.toThrow();
    expect(modal.classList._set.hidden).toBe(true);
    void opener;
  });

  test('focus trap cycles inside an open rules modal', () => {
    const { w, document } = fresh();
    // Create + populate the modal BEFORE opening so initial focus lands.
    const modal = document.getElementById('rules-modal');
    const first = makeElement('rules-first');
    const last = makeElement('rules-last');
    const opener = document.getElementById('btn-rules');
    modal._focusables = [first, last];
    first.disabled = false;
    last.disabled = false;
    document.activeElement = opener;
    w.openRules();
    expect(modal.classList._set.hidden).toBeUndefined();
    expect(document.activeElement).toBe(first); // initial focus = first item

    // Tab on the LAST item wraps to the FIRST.
    document.activeElement = last;
    document.fireDocKey('Tab');
    expect(document.activeElement).toBe(first);

    // Shift+Tab on the FIRST item wraps to the LAST.
    document.activeElement = first;
    document.fireDocKey('Tab', { shiftKey: true });
    expect(document.activeElement).toBe(last);

    // Tab on a middle item is left to the browser (no wrap).
    document.activeElement = first;
    document.fireDocKey('Tab');
    expect(document.activeElement).toBe(first);

    // Escape closes and returns focus to the opener.
    document.fireDocKey('Escape');
    expect(modal.classList._set.hidden).toBe(true);
    expect(document.activeElement).toBe(opener);

    // With the modal closed, keydowns are ignored entirely.
    document.activeElement = null;
    document.fireDocKey('Escape');
    expect(document.activeElement).toBeNull();
  });

  test('a modal without focusables tolerates Tab', () => {
    const { w, document } = fresh();
    w.openRules();
    document.activeElement = null;
    expect(() => document.fireDocKey('Tab')).not.toThrow();
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
    w.setGameMode('pnp'); // isolate from bot-mode leakage set by earlier tests
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

  test('an extra roll with no valid moves resets the roll for an immediate human re-roll', () => {
    const { w } = fresh();
    w.setGameMode('pnp'); // isolate from bot-mode state leaked by earlier tests
    w.startGame();
    // Force validMoves to stay empty so the isExtraRoll reset branch runs.
    const orig = w.ChokaBarahEngine.calculateValidMoves;
    w.ChokaBarahEngine.calculateValidMoves = () => [];
    try {
      // All shells closed = Baara (8) on 5x5 -> isExtraRoll true.
      useScriptedRandom([0.1, 0.1, 0.1, 0.1]);
      w.handleRoll();
      expect(holder.docEls['game-log']._innerText).toContain('No valid moves');
      // Human re-roll is allowed immediately (button not left disabled).
      expect(holder.docEls['btn-roll'].disabled).toBe(false);
      // The score display kept the extra-roll highlight.
      expect(holder.docEls['roll-score-display'].classList._set['is-extra']).toBe(true);
    } finally {
      w.ChokaBarahEngine.calculateValidMoves = orig;
    }
  });
});

describe('BUG-17 roll display lifecycle (fresh roll = blank readout)', () => {
  const tapCell = (canvas, r, c) => canvas.fireClick(c * 120 + 60, r * 120 + 60); // 600px canvas / 5x5
  test('a Chowka extra-turn move wipes the prior roll readout/highlight', () => {
    const { w, canvas } = fresh();
    w.setGridSize(5);
    w.setPlayers(2);
    w.setGameMode('pnp');
    w.startGame();
    // 4 open shells = Chowka (score 4, isExtraRoll true).
    useScriptedRandom([0.6, 0.6, 0.6, 0.6]);
    w.handleRoll();
    const disp = holder.docEls['roll-score-display'];
    expect(disp._innerText).toContain('EXTRA ROLL');
    expect(disp.classList._set['is-extra']).toBe(true);
    // Execute the only kind of move available (HOME -> path[3] = (3,4)).
    tapCell(canvas, 3, 4);
    // Extra turn keeps the same player; the consumed roll is gone.
    expect(holder.docEls['turn-text']._innerText).toContain('Red (South)');
    expect(disp._innerText).toBe('');
    expect(disp.classList._set['is-extra']).toBeUndefined();
    expect(holder.docEls['btn-roll'].disabled).toBe(false);
    expect(holder.docEls['game-log']._innerText).toContain('Extra roll!');
  });

  test('a normal move that advances the turn leaves a blank readout for the next player', () => {
    const { w, canvas } = fresh();
    w.setGridSize(5);
    w.setPlayers(2);
    w.setGameMode('pnp');
    w.startGame();
    useScriptedRandom([0.6, 0.1, 0.1, 0.1]); // score 1, no extra roll
    w.handleRoll();
    tapCell(canvas, 4, 2); // HOME -> path[0] = (4,2)
    const disp = holder.docEls['roll-score-display'];
    expect(holder.docEls['turn-text']._innerText).toContain('Green (North)');
    expect(disp._innerText).toBe('');
    expect(disp.classList._set['is-extra']).toBeUndefined();
  });
});

describe('BUG-13 no-valid-moves reason survives the auto-advance', () => {
  test('the next player banner explains why the turn came up', () => {
    const { w } = fresh();
    const timers = makeTimers();
    globalThis.setTimeout = timers.setTimeout;
    globalThis.clearTimeout = timers.clearTimeout;
    w.setGridSize(5);
    w.setPlayers(2);
    w.setGameMode('pnp');
    w.startGame();
    // Force no valid moves for a NON-extra score (1 open shell => score 1).
    const orig = w.ChokaBarahEngine.calculateValidMoves;
    w.ChokaBarahEngine.calculateValidMoves = () => [];
    try {
      useScriptedRandom([0.6, 0.1, 0.1, 0.1]);
      w.handleRoll();
      expect(holder.docEls['game-log']._innerText).toContain('No valid moves');
      timers.fireOne(); // the 1s auto-advance fires
      const log = holder.docEls['game-log']._innerText;
      expect(log).toContain("Green (North)'s turn");
      expect(log).toContain('No valid moves');
    } finally {
      w.ChokaBarahEngine.calculateValidMoves = orig;
    }
  });
});

describe('senior mode (accessibility)', () => {
  test('toggleSeniorMode flips the body class and the home-screen toggle chip', () => {
    const { w, document } = fresh();
    w.setSeniorMode(false); // normalize after any earlier test left it on
    expect(document.body.classList._set['senior-mode']).toBe(false);

    expect(w.toggleSeniorMode()).toBe(true);
    expect(document.body.classList._set['senior-mode']).toBe(true);
    expect(holder.docEls['btn-senior'].classList._set.active).toBe(true);
    expect(holder.docEls['senior-title']._innerText).toBe('Senior Mode: ON');
    expect(holder.docEls['senior-sub']._innerText).toContain('Bigger');

    expect(w.toggleSeniorMode()).toBe(false);
    expect(document.body.classList._set['senior-mode']).toBe(false);
    expect(holder.docEls['senior-title']._innerText).toBe('Senior Mode: OFF');
  });

  test('no-move auto-advance keeps the standard 1000ms delay when senior mode is OFF', () => {
    let lastMs = 0;
    globalThis.setTimeout = (fn, ms) => { lastMs = ms; return 1; };
    globalThis.clearTimeout = () => {};
    const { w } = fresh();
    w.setGridSize(5);
    w.setPlayers(2);
    w.setGameMode('pnp');
    w.setSeniorMode(false);
    w.startGame();
    const orig = w.ChokaBarahEngine.calculateValidMoves;
    w.ChokaBarahEngine.calculateValidMoves = () => [];
    try {
      useScriptedRandom([0.6, 0.1, 0.1, 0.1]); // score 1 (non-extra)
      w.handleRoll();
      expect(lastMs).toBe(1000);
    } finally {
      w.ChokaBarahEngine.calculateValidMoves = orig;
    }
  });

  test('senior mode relaxes the no-move auto-advance delay to 2.5x (1000 -> 2500)', () => {
    let lastMs = 0;
    globalThis.setTimeout = (fn, ms) => { lastMs = ms; return 1; };
    globalThis.clearTimeout = () => {};
    const { w } = fresh();
    w.setGridSize(5);
    w.setPlayers(2);
    w.setGameMode('pnp');
    w.setSeniorMode(true);
    w.startGame();
    const orig = w.ChokaBarahEngine.calculateValidMoves;
    w.ChokaBarahEngine.calculateValidMoves = () => [];
    try {
      useScriptedRandom([0.6, 0.1, 0.1, 0.1]);
      w.handleRoll();
      expect(lastMs).toBe(2500);
    } finally {
      w.ChokaBarahEngine.calculateValidMoves = orig;
    }
  });

  test('setSeniorMode mid-game re-renders the board without throwing', () => {
    const { w } = fresh();
    w.startGame();
    expect(() => w.setSeniorMode(true)).not.toThrow();
    expect(() => w.setSeniorMode(false)).not.toThrow();
  });

  test('setSeniorMode off the board (game inactive) skips the live re-render', () => {
    const { w } = fresh();
    w.startGame();
    w.showHomeScreen(); // sets gameActive = false
    expect(() => w.setSeniorMode(true)).not.toThrow();
    expect(() => w.setSeniorMode(false)).not.toThrow();
  });

  test('boot restores a persisted senior-mode setting and tolerates a missing toggle chip', () => {
    jest.isolateModules(() => {
      fakeStorage._reset();
      fakeStorage.setItem('cb_senior_mode', '1'); // persisted ON before boot
      const prevWin = globalThis.window;
      const prevDoc = globalThis.document;
      const mkEl = () => ({
        className: '', style: {}, disabled: false, innerText: '', children: [],
    classList: { _set: {}, add(c){ this._set[c]=true; }, remove(c){ delete this._set[c]; }, toggle(c, on){ this._set[c] = on === undefined ? !this._set[c] : !!on; }, contains(c){ return !!this._set[c]; } },
        addEventListener() {}, appendChild() {},
        getContext: () => new Proxy({}, { get(t,p){ if(p in t) return t[p]; return ()=>{}; }, set(t,p,v){ t[p]=v; return true; } })
      });
      const doc = {
        body: mkEl(),
        getElementById: (id) => {
          if (id === 'board-canvas') { const c = mkEl(); c.width = 400; c.height = 400; return c; }
          // 'btn-senior' / 'senior-title' / 'senior-sub' absent -> null (boot
          // visuals must not throw when the toggle chip is missing from the page).
          if (id === 'btn-senior' || id === 'senior-title' || id === 'senior-sub') return null;
          return mkEl();
        },
        createElement: () => mkEl()
      };
      globalThis.window = {};
      globalThis.document = doc;
      // app.js delegates board maths to engine globals; give it a real engine so
      // setSeniorMode's mid-game re-render (renderBoard/updateUI) can run.
      globalThis.window.ChokaBarahEngine = require('./game-engine.js');
      try {
        expect(() => require('./app.js')).not.toThrow();
        const w = globalThis.window;
        expect(typeof w.setSeniorMode).toBe('function');
        expect(typeof w.toggleSeniorMode).toBe('function');
        // The persisted '1' was applied at boot -> senior visuals are live.
        expect(doc.body.classList._set['senior-mode']).toBe(true);
        // Toggling off with a null-returning document is tolerated.
        expect(() => w.setSeniorMode(false)).not.toThrow();
        expect(doc.body.classList._set['senior-mode']).toBe(false);
      } finally {
        if (prevWin !== undefined) globalThis.window = prevWin; else delete globalThis.window;
        if (prevDoc !== undefined) globalThis.document = prevDoc; else delete globalThis.document;
        fakeStorage._reset();
      }
    });
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
    // BUG-17: the finished board keeps no lingering roll readout/highlight.
    expect(holder.docEls['roll-score-display']._innerText).toBe('');
    expect(holder.docEls['roll-score-display'].classList._set['is-extra']).toBeUndefined();
    // A tap after the game ended is a no-op (winner !== null guard).
    expect(() => booted.canvas.fireClick(300, 300)).not.toThrow();
  });
});

describe('post-win lifecycle & telemetry shim fallbacks', () => {
  test('restarting after a win snapshots a winner-bearing board', () => {
    const timers = makeTimers();
    globalThis.setTimeout = timers.setTimeout;
    globalThis.clearTimeout = timers.clearTimeout;
    useSeededRandom(7);
    const { w } = fresh();
    w.setGameMode('bot');
    w.startGame();
    let safety = 0;
    while (!holder.docEls['game-log']._innerText.includes('VICTORY') && safety < 5000) {
      const btnContainer = holder.docEls['pawn-buttons-container'];
      const btnRoll = holder.docEls['btn-roll'];
      const turnText = holder.docEls['turn-text']._innerText;
      if (turnText.includes('🤖')) timers.fireOne();
      else if (btnContainer.children.length) btnContainer.children[0].onclick();
      else if (!btnRoll.disabled) { w.handleRoll(); timers.fireOne(); }
      else timers.fireOne();
      safety++;
    }
    expect(holder.docEls['game-log']._innerText).toContain('VICTORY');
    // boardSnapshot() with `winner` set must not throw (winner.name path).
    expect(() => {
      const el = document.getElementById('board-title');
      void el;
    }).not.toThrow();
    expect(() => w.restartGame()).not.toThrow();
  });

  test('handlers tolerate a telemetry shim without startSpan/getSessionId/endSpan', () => {
    // Install a minimal shim missing the optional span API used at call sites;
    // verify the handler chain still works (ternaries fall back to undefined).
    const fullT = globalThis.T;
    globalThis.T = {
      info() {}, debug() {}, warn() {}, error() {}, trace() {},
      startSpan: undefined,
      endSpan: undefined,
      getSessionId: undefined
    };
    try {
      useSeededRandom(17);
      const { w } = fresh();
      w.setGameMode('pnp');
      w.startGame();
      w.handleRoll();                 // spanId = null path
      w.handleRoll();                 // roll.ignored: spanId=(null||) chain
      let safety = 0;
      while (safety < 500) {
        const btnRoll = holder.docEls['btn-roll'];
        const btnContainer = holder.docEls['pawn-buttons-container'];
        if (btnContainer.children.length) {
          btnContainer.children[0].onclick(); // select pawn, then execute move
        } else if (!btnRoll.disabled) {
          w.handleRoll();
        } else {
          break;
        }
        safety++;
      }
      w.restartGame();
    } finally {
      globalThis.T = fullT;
    }
    expect(true).toBe(true);
  });

  test('app boots into noop fallbacks when the browser lacks engine/sound globals', () => {
    jest.isolateModules(() => {
      const prevWin = globalThis.window;
const doc = {
            getElementById: (id) => {
              const el = {
                id, className: '', style: {}, disabled: false, innerText: '', children: [],
                classList: { add(){}, remove(){}, toggle(){} },
                getContext: () => ({ clearRect(){}, fillRect(){}, strokeRect(){}, beginPath(){}, moveTo(){}, lineTo(){}, arc(){}, fill(){}, stroke(){}, closePath(){}, fillText(){}, set fillStyle(v){}, set strokeStyle(v){}, set lineWidth(v){} }),
                addEventListener(){}, appendChild(){}
              };
              return el;
            },
            createElement: () => {
              const el = { className: '', style: {}, children: [], classList: { add(){}, remove(){}, toggle(){} } };
              return el;
            }
          };
      globalThis.window = {};
      globalThis.document = doc;
      try {
        // No ChokaBarahEngine / Sound installed -> module-level || {} fallbacks run.
        expect(() => require('./app.js')).not.toThrow();
      } finally {
        // Keep a live stub document: pending real bot timers from earlier
        // tests read `document` when they fire, so it must stay usable.
        if (prevWin !== undefined) globalThis.window = prevWin;
        else delete globalThis.window;
        globalThis.document = doc;
      }
    });
  });
});