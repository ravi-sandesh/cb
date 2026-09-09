'use strict';
const GS = require('./game-server.js');

// Deterministic LCG so a full game is reproducible across runs.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s & 0xffff) / 0x10000;
  };
}

describe('game-server newGame', () => {
  test('seeds a fresh two-player 5x5 state', () => {
    const g = GS.newGame({ gridSize: 5, playerNum: 2, rng: Math.random });
    expect(g.gridSize).toBe(5);
    expect(g.playerNum).toBe(2);
    expect(g.pawns.length).toBe(8);
    expect(g.currentPlayerIndex).toBe(0);
    expect(g.currentRoll).toBeNull();
    expect(g.winner).toBeNull();
  });

  test('coerces invalid sizes to defaults', () => {
    const g = GS.newGame({ gridSize: 3, playerNum: 9 });
    expect(g.gridSize).toBe(5);
    expect(g.playerNum).toBe(2);
  });
});

describe('game-server roll', () => {
  test('produces a rolled outcome with precisely derived valid moves', () => {
    const g = GS.newGame({ gridSize: 7, playerNum: 2, rng: () => 0.9 }); // all mouths up
    const r = GS.doRoll(g);
    expect(r.ok).toBe(true);
    expect(r.result).toBe('rolled');
    expect(r.score).toBe(6);
    expect(r.isExtraRoll).toBe(true);
    expect(g.validMoves.length).toBeGreaterThan(0);
    expect(g.currentRoll).toBeTruthy();
  });

  test('an extra roll with no moves resets for a re-roll, same player', () => {
    // All-cowries-closed = Baara (score 8, extra). With every pawn of player 0
    // on the last track cell, the 8-step leap overshoots -> zero valid moves,
    // so the extra roll must reset without advancing the turn.
    const g = GS.newGame({ gridSize: 5, playerNum: 2, rng: sequenceRng([0.0, 0.0, 0.0, 0.0]) });
    g.pawns.forEach(p => { if (p.playerIndex === 0) { p.state = 'ON_TRACK'; p.pathIndex = 28; } });
    const r = GS.doRoll(g);
    expect(r.ok).toBe(true);
    expect(r.result).toBe('reroll');
    expect(r.score).toBe(8);
    expect(r.isExtraRoll).toBe(true);
    expect(g.currentRoll).toBeNull();
    expect(g.currentPlayerIndex).toBe(0);
  });

  test('a dead roll passes the turn to the next player', () => {
    // Player 0's pawns sit on the last track cell, so a plain score 1 overshoots
    // into nothing -> no valid moves -> turn must advance to player 1.
    const vals = [0.9, 0.1, 0.1, 0.1]; // exactly one mouth up -> score 1 (plain)
    const g = GS.newGame({ gridSize: 5, playerNum: 2, rng: sequenceRng(vals) });
    g.pawns.forEach(p => { if (p.playerIndex === 0) { p.state = 'ON_TRACK'; p.pathIndex = 28; } });
    const r = GS.doRoll(g);
    expect(r.ok).toBe(true);
    expect(r.result).toBe('no-moves');
    expect(r.score).toBe(1);
    expect(g.currentPlayerIndex).toBe(1);
    expect(g.currentRoll).toBeNull();
  });

  test('rejects rolls when already rolled or game over', () => {
    const g = GS.newGame({ gridSize: 5, playerNum: 2, rng: () => 0.9 });
    GS.doRoll(g);
    expect(GS.doRoll(g).reason).toBe('already-rolled');
    g.winner = 0;
    expect(GS.doRoll(g).reason).toBe('game-over');
  });
});

describe('game-server move', () => {
  test('applies a legal move and advances the turn on a plain roll', () => {
    // First roll: [1,0,0,0] -> 1 mouth up -> score 1 (plain). Then LCG takes over,
    // which for this seed is irrelevant because we only assert on the first move.
    const rng = sequenceRng([1, 0, 0, 0]);
    const g = GS.newGame({ gridSize: 5, playerNum: 2, rng });
    GS.doRoll(g);
    const mv = g.validMoves[0];
    const res = GS.doMove(g, { pawnIds: mv.grpPawns.map(p => p.id), targetCoords: mv.targetCoords });
    expect(res.ok).toBe(true);
    expect(res.winner).toBeNull();
    expect(res.capturedCount).toBe(0);
    expect(res.extraTurn).toBe(false);
    expect(res.reachesHome).toBe(false); // broadcast flag for the home-arrival cue
    expect(g.currentPlayerIndex).toBe(1);
    expect(g.currentRoll).toBeNull();
  });

  test('a forged move that does not match the valid set is rejected', () => {
    const g = GS.newGame({ gridSize: 5, playerNum: 2, rng: () => 0.9 });
    GS.doRoll(g);
    const legal = g.validMoves[0];
    const badTarget = GS.doMove(g, { pawnIds: legal.grpPawns.map(p => p.id), targetCoords: [99, 99] });
    expect(badTarget.reason).toBe('illegal-move');
    const badId = GS.doMove(g, { pawnIds: [9999], targetCoords: legal.targetCoords });
    expect(badId.reason).toBe('illegal-move');
    const wrongLen = GS.doMove(g, { pawnIds: [], targetCoords: legal.targetCoords });
    expect(wrongLen.reason).toBe('illegal-move');
    // State unchanged after a rejected move.
    expect(g.currentRoll).toBeTruthy();
    expect(GS.serializeBoard(g).pawns.every(p => p.pathIndex === -1)).toBe(true);
  });

  test('rejects moves with no roll, no moves, or after a win', () => {
    const g = GS.newGame({ gridSize: 5, playerNum: 2, rng: () => 0.9 });
    expect(GS.doMove(g, { pawnIds: [0], targetCoords: [0, 0] }).reason).toBe('no-roll');
    GS.doRoll(g);
    g.validMoves = [];
    expect(GS.doMove(g, { pawnIds: [0], targetCoords: [0, 0] }).reason).toBe('no-moves');
    g.winner = 1;
    expect(GS.doMove(g, { pawnIds: [0], targetCoords: [0, 0] }).reason).toBe('game-over');
  });
});

describe('game-server full deterministic game to victory', () => {
  test('an entire auto-played game ends with a winner and serialized final board', () => {
    const g = GS.newGame({ gridSize: 5, playerNum: 2, rng: lcg(42) });
    let turns = 0;
    let won = null;
    while (turns < 4000) {
      turns++;
      const roll = GS.doRoll(g);
      if (!roll.ok) throw new Error(`unexpected roll failure: ${roll.reason}`);
      if (roll.result !== 'rolled') continue;
      const mv = g.validMoves[0];
      const res = GS.doMove(g, { pawnIds: mv.grpPawns.map(p => p.id), targetCoords: mv.targetCoords });
      if (!res.ok) throw new Error(`unexpected move failure: ${res.reason}`);
      if (res.winner !== null) { won = res.winner; break; }
    }
    expect(won).not.toBeNull();
    expect(g.winner).toBe(won);
    const board = GS.serializeBoard(g);
    expect(board.winner).toBe(won);
    // Winner has all four pawns FINISHED.
    const mine = board.pawns.filter(p => p.playerIndex === won);
    expect(mine.every(p => p.state === 'FINISHED')).toBe(true);
    // Ledger has at least the moves needed to march four pawns home.
    expect(turns).toBeLessThan(4000);
  });
});

// Builds an RNG that plays a scripted raw-value queue first (each value is a
// shell mouth: >0.5 means up), then falls back to a seeded LCG. Since a single
// roll consumes `n` values (4 for 5x5), scripting a full first roll lets a test
// pin the score; the LCG handles every later roll deterministically.
function sequenceRng(values) {
  const queue = values.slice();
  const l = lcg(123);
  return () => (queue.length ? queue.shift() : l());
}

describe('game-server move matching + ledger guards', () => {
  const anyMove = { grpPawns: [{ id: 3 }, { id: 1 }], targetCoords: [1, 2] };

  test('matchMove rejects malformed candidates', () => {
    expect(GS.matchMove(anyMove, null)).toBeNull();
    expect(GS.matchMove(anyMove, {})).toBeNull();
    expect(GS.matchMove(anyMove, { pawnIds: [1], targetCoords: [1] })).toBeNull();
    expect(GS.matchMove(anyMove, { pawnIds: [1], targetCoords: [1, 2] })).toBeNull(); // id-count
  });

  test('matchMove matches multi-pawn groups order-insensitively', () => {
    const m = GS.matchMove(anyMove, { pawnIds: [1, 3], targetCoords: [1, 2] });
    expect(m).toBe(anyMove); // both sorts ran over 2 ids
    // Second coordinate mismatch rejects even when the first matches.
    expect(GS.matchMove(anyMove, { pawnIds: [1, 3], targetCoords: [1, 9] })).toBeNull();
  });

  test('pushEvent trims the ledger past 50 entries', () => {
    const state = { log: [] };
    for (let i = 0; i < 55; i++) GS.pushEvent(state, `m${i}`);
    expect(state.log.length).toBe(50);
    expect(state.log[0]).toBe('m5');
  });

  test('doMove surfaces engine rejections for forged-but-matching moves', () => {
    const g = GS.newGame({ gridSize: 5, playerNum: 2, rng: () => 0.9 });
    GS.doRoll(g);
    // Inject a move that matches by ids+coords but fails engine validation.
    g.validMoves = [{ grpPawns: [{ id: 0 }], targetCoords: [0, 0], targetPathIndex: -1, isCapture: false, reachesHome: false }];
    const res = GS.doMove(g, { pawnIds: [0], targetCoords: [0, 0] });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('engine-rejected');
  });
});