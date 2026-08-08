// ============================================================
// CHOKA BARAH – Sound Feedback Layer (US-27)
// ------------------------------------------------------------
// Pure, dependency-injected audio core so that the game-event ->
// sound mapping and the mute-gating logic are unit-testable in
// Node/Jest. DOM and WebAudio are confined behind a sink so that
// automated tests use a no-op/stub sink (see testing doc §8.4).
//
// Sink contract:
//   { play(effect: { tone: number, ... }) -> bool }
// ============================================================

'use strict';

// Map of game events -> audio descriptors.
// `tone` is a frequency in Hz used by the WebAudio sink (a single
// short beep); beep is fine for a turn-based board game.
var SOUND_EFFECTS = {
  game_start:  { tone: 440, label: 'Game start' },
  roll:        { tone: 523, label: 'Cowry roll' },
  move:        { tone: 460, label: 'Pawn move' },
  capture:     { tone: 170, label: 'Capture' },
  gatti:       { tone: 760, label: 'Gatti formed' },
  extra_roll:  { tone: 620, label: 'Extra roll' },
  invalid:     { tone: 130, label: 'Invalid move' },
  victory:     { tone: 988, label: 'Victory' }
};

// Resolve an event type to a sound effect descriptor (or null).
function resolveSound(eventType) {
  return SOUND_EFFECTS[eventType] || null;
}

// A sink that does nothing. Used as the default when no audio is
// available, and to back the "no-op implementation" test strategy.
function createNoopSink() {
  return {
    play: function () { return false; }
  };
}

// Build a sound controller around the given stream.
// Returns { isMuted, setMuted, toggleMute, play }.
function createSoundController(sink) {
  var effectiveSink = (sink && typeof sink.play === 'function') ? sink : createNoopSink();
  var muted = false;

  return {
    isMuted: function () { return muted; },
    setMuted: function (v) {
      muted = Boolean(v);
      return muted;
    },
    toggleMute: function () {
      muted = !muted;
      return muted;
    },
    play: function (eventType) {
      if (muted) return false;
      var effect = resolveSound(eventType);
      if (!effect) return false;
      return Boolean(effectiveSink.play(effect));
    }
  };
}

// Web Audio sink. Falls back to a no-op sink when the platform has
// no AudioContext (headless CI, some webviews, SSR).
function createWebAudioSink(env) {
  var g = env || (typeof window !== 'undefined' ? window : globalThis);
  var Ctor = g.AudioContext || g.webkitAudioContext;
  if (!Ctor) return createNoopSink();

  var ctx = null;
  return {
    play: function (effect) {
      try {
        if (!ctx) ctx = new Ctor();
        var now = ctx.currentTime;
        var osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = effect.tone;
        var gain = ctx.createGain();
        gain.gain.setValueAtTime(0.001, now);
        gain.gain.exponentialRampToValueAtTime(0.12, now + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(now + 0.3);
        return true;
      } catch (e) {
        return false;
      }
    }
  };
}

var api = {
  SOUND_EFFECTS: SOUND_EFFECTS,
  resolveSound: resolveSound,
  createSoundController: createSoundController,
  createNoopSink: createNoopSink,
  createWebAudioSink: createWebAudioSink
};

/* istanbul ignore next -- environment plumbing (browser vs CommonJS) */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else if (typeof window !== 'undefined') {
  window.Sound = createSoundController(createWebAudioSink(window));
}