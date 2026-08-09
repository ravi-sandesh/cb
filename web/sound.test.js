// ============================================================
// CHOWKA BARAH – Sound Feedback Unit Tests (US-27)
// ------------------------------------------------------------
// Covers the pure sound core: event -> effect mapping, mute-gating
// (play must be suppressed when muted and for unknown events), the
// no-op sink fallback, and the WebAudio sink (via an injected fake
// AudioContext so the browser path is deterministic).
// ============================================================
const {
  SOUND_EFFECTS,
  resolveSound,
  createSoundController,
  createNoopSink,
  createWebAudioSink
} = require('./sound.js');

describe('SOUND_EFFECTS / resolveSound', () => {
  test('exposes the US-27 core events (roll, move, capture, victory)', () => {
    for (const ev of ['roll', 'move', 'capture', 'victory']) {
      expect(SOUND_EFFECTS[ev]).toBeDefined();
      expect(typeof SOUND_EFFECTS[ev].tone).toBe('number');
      expect(SOUND_EFFECTS[ev].label).toBeTruthy();
    }
  });

  test('resolves known events to a descriptor', () => {
    expect(resolveSound('roll')).toBe(SOUND_EFFECTS.roll);
    expect(resolveSound('victory').tone).toBe(988);
  });

  test('resolves unknown/empty events to null', () => {
    expect(resolveSound('nope')).toBeNull();
    expect(resolveSound()).toBeNull();
    expect(resolveSound(null)).toBeNull();
    expect(resolveSound('')).toBeNull();
  });
});

describe('createSoundController', () => {
  function mockSink() {
    const calls = [];
    return {
      calls,
      play(effect) { calls.push(effect.key || effect.tone); return true; }
    };
  }

  test('starts unmuted', () => {
    const c = createSoundController(mockSink());
    expect(c.isMuted()).toBe(false);
  });

  test('setMuted/toggleMute flip the flag', () => {
    const c = createSoundController(mockSink());
    expect(c.setMuted(true)).toBe(true);
    expect(c.isMuted()).toBe(true);
    expect(c.setMuted(false)).toBe(false);
    expect(c.toggleMute()).toBe(true);
    expect(c.toggleMute()).toBe(false);
  });

  test('play dispatches to the sink for a known event when unmuted', () => {
    const sink = mockSink();
    const c = createSoundController(sink);
    expect(c.play('roll')).toBe(true);
    expect(sink.calls).toEqual([523]);
  });

  test('play is suppressed entirely when muted', () => {
    const sink = mockSink();
    const c = createSoundController(sink);
    c.setMuted(true);
    expect(c.play('victory')).toBe(false);
    expect(sink.calls).toEqual([]);
  });

  test('play returns false for unknown events (unmuted)', () => {
    const sink = mockSink();
    const c = createSoundController(sink);
    expect(c.play('mystery')).toBe(false);
    expect(sink.calls).toEqual([]);
  });

  test('play returns false for unknown events even when muted (muted checked first)', () => {
    const sink = mockSink();
    const c = createSoundController(sink);
    c.setMuted(true);
    expect(c.play('mystery')).toBe(false);
  });

  test('falls back to a no-op sink when given no valid sink', () => {
    const c = createSoundController();
    expect(c.play('roll')).toBe(false);
    const c2 = createSoundController({});
    expect(c2.play('capture')).toBe(false);
  });
});

describe('createNoopSink', () => {
  test('play is a no-op returning false', () => {
    const sink = createNoopSink();
    expect(sink.play({ tone: 440 })).toBe(false);
  });
});

describe('createWebAudioSink', () => {
  function fakeAudioEnv({ throwOnCreate = false } = {}) {
    const calls = { oscillators: 0, gains: 0, starts: 0, stops: 0, connects: 0 };
    function FakeCtx() {
      if (throwOnCreate) throw new Error('audio init failed');
      this.currentTime = 10;
      this.destination = {};
      this.createOscillator = () => {
        calls.oscillators++;
        return {
          type: '',
          frequency: { value: 0 },
          connect: () => { calls.connects++; },
          start: () => { calls.starts++; },
          stop: () => { calls.stops++; }
        };
      };
      this.createGain = () => {
        calls.gains++;
        return { gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} }, connect: () => { calls.connects++; } };
      };
    }
    return { env: { AudioContext: FakeCtx }, calls };
  }

  test('falls back to a no-op sink when no AudioContext exists', () => {
    const sink = createWebAudioSink({}); // bare env, no AudioContext
    expect(sink.play({ tone: 440 })).toBe(false);
  });

  test('falls back when neither AudioContext nor webkitAudioContext exists', () => {
    const sink = createWebAudioSink({ webkitAudioContext: undefined });
    expect(sink.play({ tone: 440 })).toBe(false);
  });

  test('plays a tone through the injected AudioContext and returns true', () => {
    const { env, calls } = fakeAudioEnv();
    const sink = createWebAudioSink(env);
    expect(sink.play({ tone: 523 })).toBe(true);
    expect(calls.oscillators).toBe(1);
    expect(calls.gains).toBe(1);
    expect(calls.starts).toBe(1);
    expect(calls.stops).toBe(1);
    expect(calls.connects).toBe(2);
  });

  test('reuses a single AudioContext across multiple plays', () => {
    const { env, calls } = fakeAudioEnv();
    const sink = createWebAudioSink(env);
    sink.play({ tone: 523 });
    sink.play({ tone: 440 });
    expect(calls.oscillators).toBe(2);
    // one ctx instance reused -> currentTime stays 10 (would be >10 if new ctx per play)
    expect(calls.gains).toBe(2);
  });

  test('returns false without crashing when the AudioContext constructor throws', () => {
    const { env } = fakeAudioEnv({ throwOnCreate: true });
    const sink = createWebAudioSink(env);
    expect(sink.play({ tone: 440 })).toBe(false);
  });

  test('uses webkitAudioContext when AudioContext is absent', () => {
    function FakeWebkit() {
      this.currentTime = 0;
      this.destination = {};
      this.createOscillator = () => ({ frequency: { value: 0 }, connect(){}, start(){}, stop(){} });
      this.createGain = () => ({ gain: { setValueAtTime(){}, exponentialRampToValueAtTime(){} }, connect(){} });
    }
    const sink = createWebAudioSink({ webkitAudioContext: FakeWebkit });
    expect(sink.play({ tone: 523 })).toBe(true);
  });

  test('resolves the environment to globalThis when no env is passed', () => {
    // In Node there is no window, so the default env is globalThis (no AudioContext).
    const sink = createWebAudioSink();
    expect(sink.play({ tone: 440 })).toBe(false);
  });

  test('resolves to window.AudioContext in a browser-like global', () => {
    function FakeBrowserAudio() {
      this.currentTime = 0;
      this.destination = {};
      this.createOscillator = () => ({ frequency: { value: 0 }, connect(){}, start(){}, stop(){} });
      this.createGain = () => ({ gain: { setValueAtTime(){}, exponentialRampToValueAtTime(){} }, connect(){} });
    }
    const prevWindow = globalThis.window;
    globalThis.window = { AudioContext: FakeBrowserAudio };
    try {
      const sink = createWebAudioSink();
      expect(sink.play({ tone: 523 })).toBe(true);
    } finally {
      if (prevWindow === undefined) delete globalThis.window;
      else globalThis.window = prevWindow;
    }
  });
});
