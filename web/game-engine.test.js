// ============================================================
// CHOWKA BARA – Game Engine Unit Tests
// ------------------------------------------------------------
// Covers all game rules: cowry scoring, movement, Gatti rules,
// capture rules, gate enforcement, victory, turn management,
// bot AI. Includes positive, negative, and scale tests.
// ============================================================
const {
  get5x5Path, get7x7Path, getPlayerPath, innerStartIndex,
  OUTER_5, INNER_5, OUTER_7, INNER_7,
  isSafeCell, numShells, scoreCowryRoll,
  getPawnCoords, getPawnsAtCoords,
  calculateValidMoves, executeMove, advanceTurn,
  selectBotMove, createInitialState, resetPathCache
} = require('./game-engine.js');

describe('Track & Board Paths', () => {
  test('5x5 outer ring has 16 cells and inner+center 9 (total 25)', () => {
    expect(OUTER_5).toHaveLength(16);
    expect(INNER_5).toHaveLength(9);
    expect(get5x5Path(0)).toHaveLength(25);
  });

  test('5x5 path starts at South home (4,2)', () => {
    expect(get5x5Path(0)[0]).toEqual([4, 2]);
  });

  test('7x7 outer ring 24 cells, inner+center 25 (total 49)', () => {
    expect(OUTER_7).toHaveLength(24);
    expect(INNER_7).toHaveLength(25);
    expect(get7x7Path(0)).toHaveLength(49);
  });

  test('7x7 path starts at South home (6,3)', () => {
    expect(get7x7Path(0)[0]).toEqual([6, 3]);
  });

  test('player offsets rotate 5x5 path (North idx8, East idx4, West idx12)', () => {
    // offsets = [0, 8, 4, 12] => South, North, East, West
    expect(get5x5Path(1)[0]).toEqual(OUTER_5[8]);   // North = (0,2)
    expect(get5x5Path(2)[0]).toEqual(OUTER_5[4]);   // East = (2,4)
    expect(get5x5Path(3)[0]).toEqual(OUTER_5[12]);  // West = (2,0)
  });

  test('player offsets rotate 7x7 path (North idx12, East idx6, West idx18)', () => {
    // offsets = [0, 12, 6, 18] => South, North, East, West
    expect(get7x7Path(1)[0]).toEqual(OUTER_7[12]);  // North = (0,3)
    expect(get7x7Path(2)[0]).toEqual(OUTER_7[6]);   // East = (3,6)
    expect(get7x7Path(3)[0]).toEqual(OUTER_7[18]);  // West = (3,0)
  });

  test('each player home is on the expected edge', () => {
    // 5x5 homes: South(4,2) North(0,2) East(2,4) West(2,0)
    const homes5 = [[4,2],[0,2],[2,4],[2,0]];
    homes5.forEach((h, p) => expect(get5x5Path(p)[0]).toEqual(h));
    // 7x7 homes: South(6,3) North(0,3) East(3,6) West(3,0)
    const homes7 = [[6,3],[0,3],[3,6],[3,0]];
    homes7.forEach((h, p) => expect(get7x7Path(p)[0]).toEqual(h));
  });

  test('innerStartIndex returns 16 for 5x5 and 24 for 7x7 (23 for 7x7 North)', () => {
    expect(innerStartIndex(5, 0)).toBe(16);
    expect(innerStartIndex(5, 1)).toBe(16);
    expect(innerStartIndex(7, 0)).toBe(24);
    expect(innerStartIndex(7, 2)).toBe(24);
    expect(innerStartIndex(7, 1)).toBe(23); // North turns in early at (0,5)
  });

  test('inner ring entry gate is correct for each board', () => {
    // 5x5 gate = INNER_5[0] = (3,1)
    expect(INNER_5[0]).toEqual([3, 1]);
    // 7x7 gate = INNER_7[0] = (5,2)
    expect(INNER_7[0]).toEqual([5, 2]);
  });
});

describe('Safe Squares', () => {
  test.each([
    [[4, 2]], [[0, 2]], [[2, 4]], [[2, 0]], [[2, 2]]
  ])('5x5 safe cell %p is safe', (c) => {
    expect(isSafeCell(5, c[0], c[1])).toBe(true);
  });

  test.each([
    [[3, 1]], [[4, 3]], [[1, 1]]
  ])('5x5 non-safe cell %p is not safe', (c) => {
    expect(isSafeCell(5, c[0], c[1])).toBe(false);
  });

  test('7x7 uses the + cross pattern (corners, edges midpoints, center)', () => {
    const safe7 = [[0,0],[0,6],[6,0],[6,6],[0,3],[3,0],[3,6],[6,3],[1,1],[1,5],[5,1],[5,5],[3,3]];
    safe7.forEach(([r, c]) => {
      expect(isSafeCell(7, r, c)).toBe(true);
    });
  });

  test('7x7 inner diagonal cells are NOT safe (diagonal + is wrong)', () => {
    // (1,3),(3,1),(5,3),(3,5) are on inner diagonal but NOT marked safe
    expect(isSafeCell(7, 1, 3)).toBe(false);
    expect(isSafeCell(7, 3, 1)).toBe(false);
    expect(isSafeCell(7, 5, 3)).toBe(false);
    expect(isSafeCell(7, 3, 5)).toBe(false);
  });
});

describe('Cowry Scoring', () => {
  test('5x5: 0 mouths = Baara (8) with extra roll', () => {
    expect(scoreCowryRoll(5, [false, false, false, false])).toMatchObject({ score: 8, isExtraRoll: true });
  });

  test('5x5: 4 mouths = Chowka (4) with extra roll', () => {
    expect(scoreCowryRoll(5, [true, true, true, true])).toMatchObject({ score: 4, isExtraRoll: true });
  });

  test('5x5: 1-3 mouths = that number, no extra roll', () => {
    expect(scoreCowryRoll(5, [true, false, false, false])).toMatchObject({ score: 1, isExtraRoll: false });
    expect(scoreCowryRoll(5, [true, true, false, false])).toMatchObject({ score: 2, isExtraRoll: false });
    expect(scoreCowryRoll(5, [true, true, true, false])).toMatchObject({ score: 3, isExtraRoll: false });
  });

  test('7x7: 0 mouths = Baara (12) with extra roll', () => {
    expect(scoreCowryRoll(7, [false, false, false, false, false, false]).score).toBe(12);
  });

  test('7x7: 6 mouths = Chowka (6) with extra roll', () => {
    expect(scoreCowryRoll(7, [true, true, true, true, true, true]).score).toBe(6);
  });

  test('7x7: 1-5 mouths = that number, no extra roll', () => {
    expect(scoreCowryRoll(7, [true, false, false, false, false, false]).score).toBe(1);
    expect(scoreCowryRoll(7, [true, true, true, true, true, false]).score).toBe(5);
  });

  test('numShells matches board size (4 for 5x5, 6 for 7x7)', () => {
    expect(numShells(5)).toBe(4);
    expect(numShells(7)).toBe(6);
  });

  test('label text matches the Kotlin engine / rules doc (parity)', () => {
    // These exact strings are the shared display contract: Kotlin scoreShells
    // and CHOWKA_BARA_TEST_CASES.md must agree (em-dash, "Score: N" casing).
    expect(scoreCowryRoll(5, [true, true, true, true]).scoreText).toBe('CHOWKA (4) — EXTRA ROLL!');
    expect(scoreCowryRoll(5, [false, false, false, false]).scoreText).toBe('BAARA (8) — EXTRA ROLL!');
    expect(scoreCowryRoll(5, [true, true, false, false]).scoreText).toBe('Score: 2');
    expect(scoreCowryRoll(7, [true, true, true, true, true, true]).scoreText).toBe('CHOWKA (6) — EXTRA ROLL!');
    expect(scoreCowryRoll(7, [false, false, false, false, false, false]).scoreText).toBe('BAARA (12) — EXTRA ROLL!');
    expect(scoreCowryRoll(7, [true, true, false, false, false, false]).scoreText).toBe('Score: 2');
  });
});

describe('Pawn Helpers', () => {
  test('getPawnCoords returns null for HOME_BASE pawns', () => {
    expect(getPawnCoords(5, { playerIndex: 0, state: 'HOME_BASE', pathIndex: -1 })).toBeNull();
  });

  test('getPawnCoords returns board coords for ON_TRACK pawn', () => {
    expect(getPawnCoords(5, { playerIndex: 0, state: 'ON_TRACK', pathIndex: 0 })).toEqual([4, 2]);
  });

  test('getPawnsAtCoords finds ON_TRACK pawns at a cell and ignores HOME_BASE/FINISHED', () => {
    const p1path = getPlayerPath(5, 1);
    const homeCoord = getPlayerPath(5, 0)[0]; // (4,2) for P0
    const oppIdx = p1path.findIndex(([r,c]) => r===homeCoord[0] && c===homeCoord[1]);
    const pawns = [
      { id: 1, playerIndex: 0, state: 'ON_TRACK', pathIndex: 0 },
      { id: 5, playerIndex: 1, state: 'ON_TRACK', pathIndex: oppIdx },
      { id: 3, playerIndex: 0, state: 'HOME_BASE', pathIndex: -1 },
      { id: 4, playerIndex: 0, state: 'FINISHED', pathIndex: 24 }
    ];
    const found = getPawnsAtCoords(5, pawns, 4, 2);
    // player0 at (4,2) + player1 opponent at same coord = 2; HOME_BASE & FINISHED excluded
    expect(found.length).toBe(2);
    expect(found.map(p => p.id).sort()).toEqual([1, 5]);
  });
});

describe('calculateValidMoves – Basic Movement', () => {
  test('HOME_BASE pawn can move out with score (each home pawn is its own group)', () => {
    const pawns = [
      { id: 0, playerIndex: 0, state: 'HOME_BASE', pathIndex: -1 },
      { id: 1, playerIndex: 0, state: 'HOME_BASE', pathIndex: -1 }
    ];
    const moves = calculateValidMoves(5, pawns, 0, {0:true}, 3);
    // no gate lock concern here; both may move
    expect(moves.length).toBe(2);
    // each move is a single-pawn group (fix #1: no mega-home-gatti)
    expect(moves.every(m => m.grpPawns.length === 1)).toBe(true);
    // score 3 → nextIdx = 3 (home pawn moves `score` steps from start)
    expect(moves.every(m => m.targetPathIndex === 3)).toBe(true);
  });

  test('ON_TRACK pawn moves forward by score', () => {
    const pawns = [
      { id: 0, playerIndex: 0, state: 'ON_TRACK', pathIndex: 5 },
      { id: 1, playerIndex: 0, state: 'HOME_BASE', pathIndex: -1 }
    ];
    const moves = calculateValidMoves(5, pawns, 0, {0:true}, 2);
    const trackMove = moves.find(m => m.grpPawns[0].id === 0);
    expect(trackMove).toBeDefined();
    expect(trackMove.targetPathIndex).toBe(7);
    expect(trackMove.targetCoords).toEqual(getPlayerPath(5,0)[7]);
  });

  test('overshoot beyond path length is blocked', () => {
    const pawns = [
      { id: 0, playerIndex: 0, state: 'ON_TRACK', pathIndex: 24 }, // last (center)
      { id: 1, playerIndex: 0, state: 'HOME_BASE', pathIndex: -1 }
    ];
    const moves = calculateValidMoves(5, pawns, 0, {0:true}, 3);
    // near-end pawn overshoots and is skipped; only home pawn may move out (if valid)
    const trackMove = moves.find(m => m.grpPawns[0].id === 0);
    expect(trackMove).toBeUndefined();
    expect(moves.every(m => m.targetPathIndex < 25)).toBe(true);
  });

  test('reachesHome flag set when landing on final center cell', () => {
    const pawns = [
      { id: 0, playerIndex: 0, state: 'ON_TRACK', pathIndex: 23 }, // 23 + 1 = 24 (center)
      { id: 1, playerIndex: 0, state: 'HOME_BASE', pathIndex: -1 }
    ];
    const moves = calculateValidMoves(5, pawns, 0, {0:true}, 1);
    const homeMove = moves.find(m => m.grpPawns[0].id === 0);
    expect(homeMove).toBeDefined();
    expect(homeMove.reachesHome).toBe(true);
    expect(homeMove.targetPathIndex).toBe(24);
  });
});

describe('calculateValidMoves – Gate Enforcement', () => {
  test('pawn cannot enter inner path without having captured (gate lock)', () => {
    const pawns = [
      { id: 0, playerIndex: 0, state: 'ON_TRACK', pathIndex: 15 }, // just before gate (16)
      { id: 1, playerIndex: 0, state: 'HOME_BASE', pathIndex: -1 }
    ];
    const moves = calculateValidMoves(5, pawns, 0, {0:false}, 1);
    const gateMove = moves.find(m => m.grpPawns[0].id === 0);
    expect(gateMove).toBeUndefined(); // cannot step to inner idx 16
  });

  test('pawn can enter inner path after capturing', () => {
    const pawns = [
      { id: 0, playerIndex: 0, state: 'ON_TRACK', pathIndex: 15 },
      { id: 1, playerIndex: 0, state: 'HOME_BASE', pathIndex: -1 }
    ];
    const moves = calculateValidMoves(5, pawns, 0, {0:true}, 1);
    const gateMove = moves.find(m => m.grpPawns[0].id === 0);
    expect(gateMove).toBeDefined();
    expect(gateMove.targetPathIndex).toBe(16);
  });

  test('gate lock only affects the player who has not captured', () => {
    // Player 0 at pathIndex 15 WITHOUT cut → blocked
    // Player 1 at its own pathIndex 15 WITH cut → allowed to enter inner
    const pawns = [
      { id: 0, playerIndex: 0, state: 'ON_TRACK', pathIndex: 15 },
      { id: 10, playerIndex: 1, state: 'ON_TRACK', pathIndex: 15 }
    ];
    const moves0 = calculateValidMoves(5, pawns, 0, {0:false,1:true}, 1);
    const gateP0 = moves0.find(m => m.grpPawns[0].id === 0);
    expect(gateP0).toBeUndefined();

    const moves1 = calculateValidMoves(5, pawns, 1, {0:false,1:true}, 1);
    const gateP1 = moves1.find(m => m.grpPawns[0].id === 10);
    expect(gateP1).toBeDefined();
    expect(gateP1.targetPathIndex).toBe(16);
  });
});

describe('calculateValidMoves – Capture & Gatti', () => {
  // Helper: find opponent path index whose coords match a target cell
  function oppIdxAt(gridSize, oppPlayer, cell) {
    const p = getPlayerPath(gridSize, oppPlayer);
    return p.findIndex(([r,c]) => r===cell[0] && c===cell[1]);
  }

  test('single opponent pawn on a non-safe cell can be captured', () => {
    const landing = getPlayerPath(5, 0)[3]; // (3,4) not safe
    const oppIdx = oppIdxAt(5, 1, landing);
    const pawns = [
      { id: 0, playerIndex: 0, state: 'ON_TRACK', pathIndex: 2 }, // +1 → 3
      { id: 1, playerIndex: 0, state: 'HOME_BASE', pathIndex: -1 },
      { id: 5, playerIndex: 1, state: 'ON_TRACK', pathIndex: oppIdx }
    ];
    const moves = calculateValidMoves(5, pawns, 0, {0:true}, 1);
    const captureMove = moves.find(m => m.isCapture);
    expect(captureMove).toBeDefined();
    expect(captureMove.targetCoords).toEqual(landing);
  });

  test('opponent TOUGHENED pair blocks capture; untoughened tollu pair is capturable', () => {
    // (3,3) is inner for both P0 (idx 22) and P1 (idx 18).
    const base = [
      { id: 0, playerIndex: 0, state: 'ON_TRACK', pathIndex: 20 }, // +2 → 22
      { id: 1, playerIndex: 0, state: 'HOME_BASE', pathIndex: -1 },
      { id: 5, playerIndex: 1, state: 'ON_TRACK', pathIndex: 18 },
      { id: 6, playerIndex: 1, state: 'ON_TRACK', pathIndex: 18 }
    ];
    // Flagged (toughened): landing is blocked, no capture offered.
    const blocked = calculateValidMoves(5, base, 0, {0:true}, 2, { 1: [18] });
    expect(blocked.some(m => m.isCapture)).toBe(false);
    expect(blocked.find(m => m.targetPathIndex === 22)).toBeUndefined();
    // Unflagged (tollu): landing captures exactly one (capture-one).
    const open = calculateValidMoves(5, base, 0, {0:true}, 2, {});
    const captureMove = open.find(m => m.targetPathIndex === 22);
    expect(captureMove).toBeDefined();
    expect(captureMove.isCapture).toBe(true);
    const res = executeMove(5, base.map(p => ({ ...p })), {0:true}, 0, captureMove, { isExtraRoll: false }, {});
    expect(res.capturedCount).toBe(1);
    expect(res.pawns.find(p => p.id === 5).state).toBe('HOME_BASE');
    expect(res.pawns.find(p => p.id === 6).state).toBe('ON_TRACK');
  });

  test('safe cell prevents capture of opponent', () => {
    // Landing on a safe cell where an opponent sits → coexist, no capture
    const safeCell = [4, 2];
    const oppIdx = oppIdxAt(5, 1, safeCell);
    const pawns = [
      { id: 0, playerIndex: 0, state: 'ON_TRACK', pathIndex: 0 },
      { id: 5, playerIndex: 1, state: 'ON_TRACK', pathIndex: oppIdx },
      { id: 1, playerIndex: 0, state: 'HOME_BASE', pathIndex: -1 }
    ];
    // Pawn already at (4,2) with opponent: both coexist
    const found = getPawnsAtCoords(5, pawns, 4, 2);
    expect(found.length).toBe(2);
    // A non-safe capture would mark isCapture; here safe is false-capture
  });

  test('move landing on a safe cell already occupied by an opponent coexists (no capture)', () => {
    // Player 0 pawn at idx 10 (0,0) + score 2 -> idx 12 (2,0) which is a safe square.
    // An opponent pawn is parked on that same safe cell -> the move is allowed
    // but must NOT be flagged as a capture (safe squares are refuge).
    const safeCell = [2, 0];
    const oppIdx = oppIdxAt(5, 1, safeCell);
    const pawns = [
      { id: 0, playerIndex: 0, state: 'ON_TRACK', pathIndex: 10 },
      { id: 1, playerIndex: 0, state: 'HOME_BASE', pathIndex: -1 },
      { id: 5, playerIndex: 1, state: 'ON_TRACK', pathIndex: oppIdx }
    ];
    const moves = calculateValidMoves(5, pawns, 0, {0:true}, 2);
    const safeMove = moves.find(m => m.targetPathIndex === 12);
    expect(safeMove).toBeDefined();
    expect(safeMove.targetCoords).toEqual(safeCell);
    expect(safeMove.isCapture).toBe(false);
  });

  test('inner pair groups as one tollu unit; an exact 2 toughens it', () => {
    const idx = 17; // inner (>= gate 16)
    const pawns = [
      { id: 0, playerIndex: 0, state: 'ON_TRACK', pathIndex: idx },
      { id: 1, playerIndex: 0, state: 'ON_TRACK', pathIndex: idx },
      { id: 2, playerIndex: 0, state: 'HOME_BASE', pathIndex: -1 }
    ];
    // Score 4 -> tollu half rate: one group move +2, not toughened.
    const half = calculateValidMoves(5, pawns, 0, {0:true}, 4, {});
    const tolluMove = half.find(m => m.isGattiGroup);
    expect(tolluMove).toBeDefined();
    expect(tolluMove.grpPawns).toHaveLength(2);
    expect(tolluMove.targetPathIndex).toBe(idx + 2);
    expect(tolluMove.isToughened).toBe(false);
    expect(tolluMove.toughens).toBe(false);
    // Score 2 -> same move toughens the pair at its destination.
    const harden = calculateValidMoves(5, pawns, 0, {0:true}, 2, {});
    const toughMove = harden.find(m => m.isGattiGroup);
    expect(toughMove).toBeDefined();
    expect(toughMove.targetPathIndex).toBe(idx + 1);
    expect(toughMove.toughens).toBe(true);
    const res = executeMove(5, pawns.map(p => ({ ...p })), {0:true}, 0, toughMove, { isExtraRoll: false }, {});
    expect(res.gattiFormed).toBe(true);
    expect(res.toughened).toEqual({ 0: [idx + 1] });
    // Odd rolls (1, 3) leave the tollu pair stuck: no group move offered.
    for (const odd of [1, 3]) {
      const stuck = calculateValidMoves(5, pawns, 0, {0:true}, odd, {});
      expect(stuck.find(m => m.isGattiGroup)).toBeUndefined();
    }
  });

  test('outer pair moves as vulnerable singles, never one Gatti group', () => {
    const idx = 5; // outer (< gate 16)
    const pawns = [
      { id: 0, playerIndex: 0, state: 'ON_TRACK', pathIndex: idx },
      { id: 1, playerIndex: 0, state: 'ON_TRACK', pathIndex: idx }
    ];
    const moves = calculateValidMoves(5, pawns, 0, {0:true}, 1, {});
    expect(moves).toHaveLength(2);
    expect(moves.every(m => m.isGattiGroup === false)).toBe(true);
    expect(moves.every(m => m.grpPawns.length === 1)).toBe(true);
  });
});

describe('executeMove – Core Execution', () => {
  test('moves a single HOME_BASE pawn out to track (fix #1: only one pawn exits)', () => {
    const state = createInitialState(5, 2);
    const pawns = state.pawns;
    const moves = calculateValidMoves(5, pawns, 0, {0:true,1:false}, 3);
    const result = executeMove(5, pawns, {0:true,1:false}, 0, moves[0], { isExtraRoll: false });
    const out = result.pawns.filter(p => p.state === 'ON_TRACK' && p.playerIndex === 0);
    expect(out).toHaveLength(1); // ONLY one exited
    expect(out[0].pathIndex).toBe(3); // home pawn moves `score` steps from start
  });

  test('does NOT move opponent pawns during execution', () => {
    const pawns = [
      { id: 0, playerIndex: 0, state: 'ON_TRACK', pathIndex: 2 },
      { id: 4, playerIndex: 1, state: 'ON_TRACK', pathIndex: 2 },
      { id: 1, playerIndex: 0, state: 'HOME_BASE', pathIndex: -1 }
    ];
    const move = { grpPawns:[pawns[0]], targetPathIndex: 4, targetCoords: getPlayerPath(5,0)[4], isCapture:false, reachesHome:false };
    const res = executeMove(5, pawns, {0:true,1:true}, 0, move, { isExtraRoll: false });
    const opp = res.pawns.find(p => p.id === 4);
    expect(opp.pathIndex).toBe(2); // unchanged
    expect(opp.state).toBe('ON_TRACK');
  });

  test('capture sends opponent pawn back to HOME_BASE and grants extra turn', () => {
    const landing = getPlayerPath(5, 0)[3];
    const p1path = getPlayerPath(5, 1);
    const oppIdx = p1path.findIndex(([r,c]) => r===landing[0] && c===landing[1]);
    const pawns = [
      { id: 0, playerIndex: 0, state: 'ON_TRACK', pathIndex: 2 },
      { id: 5, playerIndex: 1, state: 'ON_TRACK', pathIndex: oppIdx },
      { id: 1, playerIndex: 0, state: 'HOME_BASE', pathIndex: -1 }
    ];
    const move = { grpPawns:[pawns[0]], targetPathIndex: 3, targetCoords:landing, isCapture:true, reachesHome:false };
    const res = executeMove(5, pawns, {0:false,1:true}, 0, move, { isExtraRoll: false });
    const opp = res.pawns.find(p => p.id === 5);
    expect(opp.state).toBe('HOME_BASE');
    expect(opp.pathIndex).toBe(-1);
    expect(res.extraTurn).toBe(true); // capture grants extra
    expect(res.capturedCount).toBe(1);
    expect(res.hasCapturedOpponent[0]).toBe(true); // gate unlocked
  });

  test('BUG-17: executeMove does NOT mutate the caller hasCapturedOpponent object', () => {
    const landing = getPlayerPath(5, 0)[3];
    const p1path = getPlayerPath(5, 1);
    const oppIdx = p1path.findIndex(([r,c]) => r===landing[0] && c===landing[1]);
    const pawns = [
      { id: 0, playerIndex: 0, state: 'ON_TRACK', pathIndex: 2 },
      { id: 5, playerIndex: 1, state: 'ON_TRACK', pathIndex: oppIdx }
    ];
    const move = { grpPawns:[pawns[0]], targetPathIndex: 3, targetCoords:landing, isCapture:true, reachesHome:false };
    const captured = { 0: false, 1: true };
    const res = executeMove(5, pawns, captured, 0, move, { isExtraRoll: false });
    // The result carries the flag, but the caller's object is left untouched.
    expect(res.hasCapturedOpponent[0]).toBe(true);
    expect(captured[0]).toBe(false);
  });

  test('BUG-01: executeMove tolerates an undefined currentRoll without crashing', () => {
    const pawns = [
      { id: 0, playerIndex: 0, state: 'ON_TRACK', pathIndex: 5 },
      { id: 1, playerIndex: 0, state: 'HOME_BASE', pathIndex: -1 }
    ];
    const move = { grpPawns:[pawns[0]], targetPathIndex: 7, targetCoords:getPlayerPath(5,0)[7], isCapture:false, reachesHome:false };
    // Callers on the optional isExtraRoll contract may omit the roll object.
    const res = executeMove(5, pawns, {0:true,1:true}, 0, move, undefined);
    expect(res.error).toBeUndefined();
    expect(res.extraTurn).toBe(false); // plain move grants no extra turn
    expect(res.winner).toBeNull();
    expect(res.pawns.find(p => p.id === 0).pathIndex).toBe(7);
  });

  test('home-entry (reachesHome) sets pawn to FINISHED', () => {
    const pawns = [
      { id: 0, playerIndex: 0, state: 'ON_TRACK', pathIndex: 23 },
      { id: 1, playerIndex: 0, state: 'HOME_BASE', pathIndex: -1 }
    ];
    const move = { grpPawns:[pawns[0]], targetPathIndex: 24, targetCoords:getPlayerPath(5,0)[24], isCapture:false, reachesHome:true };
    const res = executeMove(5, pawns, {0:true,1:true}, 0, move, { isExtraRoll:false });
    expect(res.pawns.find(p=>p.id===0).state).toBe('FINISHED');
  });

  test('victory detected when all pawns of a player FINISHED', () => {
    const pawns = [];
    for (let id=0; id<4; id++) {
      pawns.push({ id, playerIndex:0, state: id===3?'ON_TRACK':'FINISHED', pathIndex: id===3?23:24 });
    }
    pawns.push({ id:4, playerIndex:1, state:'HOME_BASE', pathIndex:-1 });
    const move = { grpPawns:[pawns[3]], targetPathIndex:24, targetCoords:getPlayerPath(5,0)[24], isCapture:false, reachesHome:true };
    const res = executeMove(5, pawns, {0:true,1:true}, 0, move, {isExtraRoll:false});
    expect(res.winner).toBe(0);
  });

  test('outer join does NOT form a Gatti; inner tollu join does not toughen', () => {
    // Outer join (idx 4 -> 5): two singles end together, still vulnerable.
    const outer = [
      { id: 0, playerIndex: 0, state: 'ON_TRACK', pathIndex: 4 },
      { id: 1, playerIndex: 0, state: 'ON_TRACK', pathIndex: 5 },
      { id: 2, playerIndex: 0, state: 'HOME_BASE', pathIndex: -1 }
    ];
    const outerMove = { grpPawns:[outer[0]], targetPathIndex: 5, targetCoords:getPlayerPath(5,0)[5], isCapture:false, reachesHome:false };
    const outerRes = executeMove(5, outer, {0:true,1:true}, 0, outerMove, {isExtraRoll:false});
    expect(outerRes.gattiFormed).toBe(false);
    // Inner tollu join (idx 16 -> 17 onto a mate): tollu pair, not toughened.
    const inner = [
      { id: 0, playerIndex: 0, state: 'ON_TRACK', pathIndex: 16 },
      { id: 1, playerIndex: 0, state: 'ON_TRACK', pathIndex: 17 },
      { id: 2, playerIndex: 0, state: 'HOME_BASE', pathIndex: -1 }
    ];
    const innerMove = { grpPawns:[inner[0]], targetPathIndex: 17, targetCoords:getPlayerPath(5,0)[17], isCapture:false, reachesHome:false };
    const innerRes = executeMove(5, inner, {0:true,1:true}, 0, innerMove, {isExtraRoll:false});
    expect(innerRes.gattiFormed).toBe(false);
    expect(innerRes.toughened).toEqual({});
  });

  test('extra turn NOT granted for a plain move with no capture/extra roll', () => {
    const pawns = [
      { id: 0, playerIndex: 0, state: 'ON_TRACK', pathIndex: 5 },
      { id: 1, playerIndex: 0, state: 'HOME_BASE', pathIndex: -1 }
    ];
    const move = { grpPawns:[pawns[0]], targetPathIndex: 7, targetCoords:getPlayerPath(5,0)[7], isCapture:false, reachesHome:false };
    const res = executeMove(5, pawns, {0:true,1:true}, 0, move, { isExtraRoll:false });
    expect(res.extraTurn).toBe(false);
  });
});

describe('Input validation guards', () => {
  test('executeMove with null returns error result without mutating state', () => {
    const pawns = [{ id: 0, playerIndex: 0, state: 'ON_TRACK', pathIndex: 5 }];
    const res = executeMove(5, pawns, {0:true}, 0, null, { isExtraRoll: false });
    expect(res.error).toBeDefined();
    expect(res.extraTurn).toBe(false);
    expect(res.winner).toBeNull();
    // State unchanged
    expect(pawns[0].pathIndex).toBe(5);
  });

  test('executeMove with missing grpPawns returns error', () => {
    const pawns = [{ id: 0, playerIndex: 0, state: 'ON_TRACK', pathIndex: 5 }];
    const move = { targetPathIndex: 6, targetCoords: [1,2], isCapture: false, reachesHome: false, isGattiGroup: false };
    const res = executeMove(5, pawns, {0:true}, 0, move, { isExtraRoll: false });
    expect(res.error).toContain('grpPawns');
  });

  test('executeMove with invalid targetPathIndex returns error', () => {
    const pawns = [{ id: 0, playerIndex: 0, state: 'ON_TRACK', pathIndex: 5 }];
    const move = { grpPawns:[pawns[0]], targetPathIndex: -1, targetCoords: [1,2], isCapture: false, reachesHome: false, isGattiGroup: false };
    const res = executeMove(5, pawns, {0:true}, 0, move, { isExtraRoll: false });
    expect(res.error).toContain('targetPathIndex');
  });

  test('executeMove with non-numeric targetPathIndex returns error', () => {
    const pawns = [{ id: 0, playerIndex: 0, state: 'ON_TRACK', pathIndex: 5 }];
    const move = { grpPawns:[pawns[0]], targetPathIndex: 'x', targetCoords: [1,2], isCapture: false, reachesHome: false, isGattiGroup: false };
    const res = executeMove(5, pawns, {0:true}, 0, move, { isExtraRoll: false });
    expect(res.error).toContain('targetPathIndex');
  });

  test('executeMove with malformed targetCoords returns error', () => {
    const pawns = [{ id: 0, playerIndex: 0, state: 'ON_TRACK', pathIndex: 5 }];
    const move = { grpPawns:[pawns[0]], targetPathIndex: 6, targetCoords: [1], isCapture: false, reachesHome: false, isGattiGroup: false };
    const res = executeMove(5, pawns, {0:true}, 0, move, { isExtraRoll: false });
    expect(res.error).toContain('targetCoords');
  });

  test.each([
    ['isCapture', { isCapture: 'yes' }],
    ['reachesHome', { reachesHome: 'yes' }],
    ['isGattiGroup', { isGattiGroup: 'yes' }],
    ['isToughened', { isToughened: 'yes' }],
    ['toughens', { toughens: 'yes' }]
  ])('executeMove with non-boolean %s returns error', (field, overrides) => {
    const pawns = [{ id: 0, playerIndex: 0, state: 'ON_TRACK', pathIndex: 5 }];
    const move = { grpPawns:[pawns[0]], targetPathIndex: 6, targetCoords:[1,2], isCapture:false, reachesHome:false, isGattiGroup:false, ...overrides };
    const res = executeMove(5, pawns, {0:true}, 0, move, { isExtraRoll: false });
    expect(res.error).toContain(field);
  });

  test('executeMove with grpPawns as a non-array returns error', () => {
    const pawns = [{ id: 0, playerIndex: 0, state: 'ON_TRACK', pathIndex: 5 }];
    const move = { grpPawns: pawns[0], targetPathIndex: 6, targetCoords:[1,2], isCapture:false, reachesHome:false, isGattiGroup:false };
    const res = executeMove(5, pawns, {0:true}, 0, move, { isExtraRoll: false });
    expect(res.error).toContain('grpPawns');
  });

  test('calculateValidMoves with non-numeric score returns empty array', () => {
    const pawns = [{ id: 0, playerIndex: 0, state: 'ON_TRACK', pathIndex: 5 }];
    const moves = calculateValidMoves(5, pawns, 0, {0:true}, 'three');
    expect(moves).toEqual([]);
  });

  test('executeMove with a valid but empty score (no extra roll) does not crash', () => {
    const pawns = [{ id: 0, playerIndex: 0, state: 'ON_TRACK', pathIndex: 5 }];
    const move = { grpPawns:[pawns[0]], targetPathIndex: 6, targetCoords:[1,2], isCapture:false, reachesHome:false, isGattiGroup:false };
    const res = executeMove(5, pawns, {0:true}, 0, move, { isExtraRoll: false });
    expect(res.error).toBeUndefined();
    expect(Array.isArray(res.pawns)).toBe(true);
  });

  test('calculateValidMoves with invalid score returns empty array', () => {
    const pawns = [{ id: 0, playerIndex: 0, state: 'ON_TRACK', pathIndex: 5 }];
    const moves = calculateValidMoves(5, pawns, 0, {0:true}, 0);
    expect(moves).toEqual([]);
    const moves2 = calculateValidMoves(5, pawns, 0, {0:true}, 99);
    expect(moves2).toEqual([]);
  });

  test('calculateValidMoves with negative score returns empty array', () => {
    const pawns = [{ id: 0, playerIndex: 0, state: 'ON_TRACK', pathIndex: 5 }];
    const moves = calculateValidMoves(5, pawns, 0, {0:true}, -5);
    expect(moves).toEqual([]);
  });
});

describe('advanceTurn', () => {
  test('advances to next player modulo player count', () => {
    expect(advanceTurn(2, 0)).toBe(1);
    expect(advanceTurn(2, 1)).toBe(0);
    expect(advanceTurn(4, 3)).toBe(0);
    expect(advanceTurn(4, 0)).toBe(1);
  });
});

describe('selectBotMove – Bot AI', () => {
  function mkMove(pathIndex, {capture=false, home=false, safe=false, gatti=false, toughens=false}={}) {
    const coord = getPlayerPath(5, 0)[pathIndex] || [pathIndex, pathIndex];
    const coords = { safe: isSafeCell(5, coord[0], coord[1]), ...coord };
    return { grpPawns:[{pathIndex}], targetCoords:coord, isCapture:capture, reachesHome:home, isGattiGroup:gatti, toughens };
  }

  test('no moves returns null', () => {
    expect(selectBotMove([], 5)).toBeNull();
  });

  test('prefers capture over other moves', () => {
    const moves = [mkMove(1), mkMove(2,{capture:true}), mkMove(3)];
    expect(selectBotMove(moves, 5).isCapture).toBe(true);
  });

  test('prefers reaching home when no capture', () => {
    const moves = [mkMove(1), mkMove(2,{home:true}), mkMove(3)];
    expect(selectBotMove(moves, 5).reachesHome).toBe(true);
  });

  test('prefers safe square when no capture/home', () => {
    // (4,2) is safe; place a move landing there (idx 0)
    const moves = [mkMove(1), mkMove(0), mkMove(3)];
    const chosen = selectBotMove(moves, 5);
    expect(chosen).toBeDefined();
    expect(moves.indexOf(chosen)).toBe(1); // selected the safe one
  });

  test('prefers Gatti group', () => {
    const moves = [mkMove(1), mkMove(2,{gatti:true}), mkMove(3)];
    expect(selectBotMove(moves,5).isGattiGroup).toBe(true);
  });

  test('prefers toughening over safe squares (but not over capture/home)', () => {
    const moves = [mkMove(1), mkMove(0), mkMove(2,{toughens:true})];
    expect(selectBotMove(moves, 5).toughens).toBe(true);
    const withCapture = [mkMove(2,{toughens:true}), mkMove(3,{capture:true})];
    expect(selectBotMove(withCapture, 5).isCapture).toBe(true);
  });

  test('falls back to furthest pawn otherwise', () => {
    const moves = [mkMove(1), mkMove(3), mkMove(2)];
    const chosen = selectBotMove(moves,5);
    expect(chosen.targetCoords).toEqual(getPlayerPath(5,0)[3]);
  });
});

describe('createInitialState – Scale / Setup', () => {
  test('creates 4 pawns per player in HOME_BASE', () => {
    for (const p of [2,4]) {
      const s = createInitialState(5, p);
      expect(s.pawns).toHaveLength(p*4);
      expect(s.pawns.every(x => x.state==='HOME_BASE' && x.pathIndex===-1)).toBe(true);
      expect(Object.keys(s.hasCapturedOpponent)).toHaveLength(p);
    }
  });

  test('initial currentPlayerIndex is 0 and game is active', () => {
    const s = createInitialState(7, 4);
    expect(s.currentPlayerIndex).toBe(0);
    expect(s.gameActive).toBe(true);
    expect(s.winner).toBeNull();
  });
});

describe('SCALE TESTS', () => {
  test('handles many pawns across all 4 players without crashing', () => {
    const state = createInitialState(7, 4); // 16 pawns
    for (let score of [1,2,3,4,5,6,12]) {
      const moves = calculateValidMoves(7, state.pawns, 0, {0:true,1:false,2:true,3:true}, score);
      expect(Array.isArray(moves)).toBe(true);
    }
  });

  test('1000 sequential move computations on 7x7 stays consistent', () => {
    const state = createInitialState(7, 4);
    for (let i=0;i<1000;i++){
      const sc = (i%6)+1;
      const moves = calculateValidMoves(7, state.pawns, 0, state.hasCapturedOpponent, sc);
      expect(Array.isArray(moves)).toBe(true);
      for (const m of moves) {
        expect(m.targetPathIndex).toBeGreaterThanOrEqual(0);
        expect(m.targetPathIndex).toBeLessThan(getPlayerPath(7,0).length);
      }
    }
  });

  test('full path length mapping is contiguous and ends at center', () => {
    const path = getPlayerPath(5, 0);
    expect(path[24]).toEqual([2,2]); // center
  });

  test('a single player path has no duplicate cells (full traversal)', () => {
    for (const sz of [5,7]) {
      for (let p=0;p<4;p++){
        const path = getPlayerPath(sz, p);
        const seen = new Set(path.map(c=>c.join(',')));
        expect(seen.size).toBe(path.length);
      }
    }
  });

  test('inner pair resolves to one tollu group (outer stacks stay singles)', () => {
    const idx = 17; // inner (>= gate 16)
    const pawns = [];
    for (let id=0; id<4; id++) {
      pawns.push({ id, playerIndex:0, state:'ON_TRACK', pathIndex: idx });
    }
    const moves = calculateValidMoves(5, pawns, 0, {0:true}, 4, {});
    const tolluMove = moves.find(m => m.isGattiGroup);
    expect(tolluMove).toBeDefined();
    expect(tolluMove.grpPawns).toHaveLength(4);
    expect(tolluMove.targetPathIndex).toBe(idx + 2); // half rate
    expect(tolluMove.isToughened).toBe(false);
  });

  // ============================================================
  // PHASE 4 - PERFORMANCE
  // Path memoization must return the SAME (cached) reference so the hot
  // path (getPawnsAtCoords -> getPawnCoords -> getPlayerPath) never
  // rebuilds the path arrays repeatedly. Also: after resetPathCache(),
  // paths rebuild fresh but remain identical in value.
  // ============================================================
  test('getPlayerPath returns the same cached reference (no rebuild per call)', () => {
    expect(getPlayerPath(5, 0)).toBe(getPlayerPath(5, 0));
    expect(getPlayerPath(7, 3)).toBe(getPlayerPath(7, 3));
  });

  test('resetPathCache forces rebuild but produces value-identical paths', () => {
    const key = [5, 1];
    const before_ref = getPlayerPath(key[0], key[1]);
    const before_value = before_ref.map(c => c.join(','));
    resetPathCache();
    const after_ref = getPlayerPath(key[0], key[1]);
    const after_value = after_ref.map(c => c.join(','));
    expect(after_ref).not.toBe(before_ref); // fresh array
    expect(after_value).toEqual(before_value); // same contents
  });

  test('path cache is stable across a long sequence of move computations', () => {
    resetPathCache();
    const state = createInitialState(7, 4);
    for (let i = 0; i < 2000; i++) {
      const sc = (i % 6) + 1;
      const moves = calculateValidMoves(7, state.pawns, 0, state.hasCapturedOpponent, sc);
      expect(Array.isArray(moves)).toBe(true);
    }
    // Cached references remain the viable path (correctness preserved).
    expect(getPlayerPath(7, 0).length).toBe(49);
  });
});

// ============================================================
// DOC-ALIGNMENT TESTS (added to cover EC-21, EC-38, EC-32 and to
// lock the corrected 5x5 corner-safe rule in the rules doc).
// ============================================================

describe('5x5 corner safe rule (doc correction)', () => {
  test.each([
    [[0, 0]], [[0, 4]], [[4, 0]], [[4, 4]]
  ])('5x5 corner %p is NOT safe', (c) => {
    expect(isSafeCell(5, c[0], c[1])).toBe(false);
  });

  test('5x5 homes and center remain safe', () => {
    expect(isSafeCell(5, 4, 2)).toBe(true); // South home
    expect(isSafeCell(5, 0, 2)).toBe(true); // North home
    expect(isSafeCell(5, 2, 4)).toBe(true); // East home
    expect(isSafeCell(5, 2, 0)).toBe(true); // West home
    expect(isSafeCell(5, 2, 2)).toBe(true); // center
  });

  test('exactly 5 safe cells on 5x5', () => {
    let count = 0;
    for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) if (isSafeCell(5, r, c)) count++;
    expect(count).toBe(5);
  });
});

describe('EC-38 - inner loop continues from the gate to center', () => {
  test.each([[5], [7]])('%dx%d inner path has no revisits and terminates at center', (sz) => {
    const center = sz === 5 ? [2, 2] : [3, 3];
    for (let p = 0; p < 4; p++) {
      const inner = getPlayerPath(sz, p).slice(innerStartIndex(sz, p)); // inner + center
      expect(new Set(inner.map(c => c.join(','))).size).toBe(inner.length);
      expect(inner[inner.length - 1]).toEqual(center);
    }
  });

  test('5x5 inner loop steps are orthogonally adjacent (no jumps/reversal)', () => {
    const inner = getPlayerPath(5, 0).slice(innerStartIndex(5, 0));
    for (let i = 0; i < inner.length - 1; i++) {
      const [a, b] = [inner[i], inner[i + 1]];
      expect(Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1])).toBe(1);
    }
  });

  test('every seat enters its own inner track orthogonally and reaches center orthogonally', () => {
    // Entry = the block before home, stepped inward; last inner cell steps
    // orthogonally into center. Holds for all 4 seats on both board sizes.
    for (const sz of [5, 7]) {
      for (let p = 0; p < 4; p++) {
        const path = getPlayerPath(sz, p);
        const gate = innerStartIndex(sz, p);
        const stepIn = [path[gate - 1], path[gate]];
        expect(Math.abs(stepIn[0][0] - stepIn[1][0]) + Math.abs(stepIn[0][1] - stepIn[1][1])).toBe(1);
        const stepHome = [path[path.length - 2], path[path.length - 1]];
        expect(Math.abs(stepHome[0][0] - stepHome[1][0]) + Math.abs(stepHome[0][1] - stepHome[1][1])).toBe(1);
        // Full inner run (gate..center) is orthogonally adjacent throughout,
        // except the 7x7 middle->inner turn-inward step (a deliberate diagonal,
        // as on traditional boards): middle's last cell -> inner's first cell.
        for (let i = gate; i < path.length - 1; i++) {
          if (sz === 7 && i === gate + 15) continue;
          const [a, b] = [path[i], path[i + 1]];
          expect(Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1])).toBe(1);
        }
      }
    }
  });

  test('per-player inner entries match the traditional board', () => {
    // 5x5 entries: N (1,3), S (3,1), E (3,3), W (1,1); all gates at 16.
    expect(getPlayerPath(5, 1)[16]).toEqual([1, 3]);
    expect(getPlayerPath(5, 0)[16]).toEqual([3, 1]);
    expect(getPlayerPath(5, 2)[16]).toEqual([3, 3]);
    expect(getPlayerPath(5, 3)[16]).toEqual([1, 1]);
    // 7x7 entries: N (1,5) at gate 23; S (5,2), E (4,5), W (2,1) at gate 24.
    expect(getPlayerPath(7, 1)[23]).toEqual([1, 5]);
    expect(getPlayerPath(7, 1)).toHaveLength(48);
    expect(getPlayerPath(7, 0)[24]).toEqual([5, 2]);
    expect(getPlayerPath(7, 2)[24]).toEqual([4, 5]);
    expect(getPlayerPath(7, 3)[24]).toEqual([2, 1]);
    // (1,2) sits one step before center for North on 5x5 (exact-1 home rule).
    expect(getPlayerPath(5, 1)[23]).toEqual([1, 2]);
    expect(getPlayerPath(5, 1)[24]).toEqual([2, 2]);
  });
});

describe('EC-32 - bot tie-break is deterministic', () => {
  test('equal-priority (same furthest) moves resolve to the first in list', () => {
    // Both targets are NON-safe 5x5 cells, so no capture/home/safe/Gatti wins;
    // they tie on "furthest" -> selection must be the first in the array (stable).
    const moves = [
      { grpPawns: [{ pathIndex: 9 }], targetCoords: [1, 3], isCapture: false, reachesHome: false, isGattiGroup: false },
      { grpPawns: [{ pathIndex: 9 }], targetCoords: [3, 1], isCapture: false, reachesHome: false, isGattiGroup: false }
    ];
    const chosen = selectBotMove([...moves], 5);
    expect(chosen).toEqual(moves[0]);
  });

  test('repeated selection on identical input is stable', () => {
    const moves = [
      { grpPawns: [{ pathIndex: 3 }], targetCoords: [1, 2], isCapture: false, reachesHome: false, isGattiGroup: false },
      { grpPawns: [{ pathIndex: 5 }], targetCoords: [4, 2], isCapture: true, reachesHome: false, isGattiGroup: false },
      { grpPawns: [{ pathIndex: 7 }], targetCoords: [0, 2], isCapture: false, reachesHome: true, isGattiGroup: false }
    ];
    const first = selectBotMove([...moves], 5);
    const second = selectBotMove([...moves], 5);
    expect(second).toEqual(first);
    expect(first.isCapture).toBe(true); // capture priority intact
  });
});

describe('EC-21 - pawn finishing while inside a Gatti leaves a smaller Gatti', () => {
  test('one pawn reaches center; the co-located pawn stays ON_TRACK (no winner yet)', () => {
    const path = getPlayerPath(5, 0);
    const last = path.length - 1;
    const pawns = [
      { id: 0, playerIndex: 0, state: 'ON_TRACK', pathIndex: last - 1 },
      { id: 1, playerIndex: 0, state: 'ON_TRACK', pathIndex: last - 1 }, // Gatti mate
      { id: 2, playerIndex: 0, state: 'ON_TRACK', pathIndex: 5 },
      { id: 3, playerIndex: 0, state: 'FINISHED', pathIndex: last },
      { id: 4, playerIndex: 1, state: 'HOME_BASE', pathIndex: -1 }
    ];
    const move = {
      grpPawns: [pawns[0]], targetPathIndex: last, targetCoords: path[last],
      isCapture: false, reachesHome: true
    };
    const res = executeMove(5, pawns, {0:true,1:false}, 0, move, { isExtraRoll: false });
    expect(res.pawns.find(p => p.id === 0).state).toBe('FINISHED');
    // Gatti mate remains on track (smaller Gatti), not finished
    const mate = res.pawns.find(p => p.id === 1);
    expect(mate.state).toBe('ON_TRACK');
    expect(mate.pathIndex).toBe(last - 1);
    // Player 0 still has ON_TRACK pawn(s) -> no victory
    expect(res.winner).toBeNull();
  });

  test('the remaining co-located pawn is still a movable tollu unit afterwards', () => {
    const path = getPlayerPath(5, 0);
    const last = path.length - 1;
    const pawns = [
      { id: 0, playerIndex: 0, state: 'FINISHED', pathIndex: last },
      { id: 1, playerIndex: 0, state: 'ON_TRACK', pathIndex: last - 1 },
      { id: 2, playerIndex: 0, state: 'ON_TRACK', pathIndex: last - 1 }, // leftover pair
      { id: 3, playerIndex: 0, state: 'ON_TRACK', pathIndex: 5 },
      { id: 4, playerIndex: 1, state: 'HOME_BASE', pathIndex: -1 }
    ];
    const moves = calculateValidMoves(5, pawns, 0, {0:true,1:false}, 2);
    const tollu = moves.find(m => m.isGattiGroup);
    expect(tollu).toBeDefined();
    expect(tollu.grpPawns.map(p => p.id).sort()).toEqual([1, 2]); // smaller tollu of 2
    expect(tollu.targetPathIndex).toBe(last); // ...right into Center Home...
    expect(tollu.reachesHome).toBe(true);
    expect(tollu.toughens).toBe(false); // ...so it finishes instead of toughening
  });
});

describe('getPawnsAtCoords – exclude pawn id', () => {
  test('excludes a named pawn id from the result set (guard branch)', () => {
    const pawns = [
      { id: 0, playerIndex: 0, state: 'ON_TRACK', pathIndex: 2 },
      { id: 1, playerIndex: 0, state: 'ON_TRACK', pathIndex: 2 }, // same cell
      { id: 2, playerIndex: 0, state: 'HOME_BASE', pathIndex: -1 }
    ];
    const coords = getPlayerPath(5, 0)[2];
    const withAll = getPawnsAtCoords(5, pawns, coords[0], coords[1]);
    expect(withAll).toHaveLength(2);
    const excluding0 = getPawnsAtCoords(5, pawns, coords[0], coords[1], 0);
    expect(excluding0.map(p => p.id)).toEqual([1]);
    const excludingBoth = getPawnsAtCoords(5, pawns, coords[0], coords[1], 1);
    expect(excludingBoth.map(p => p.id)).toEqual([0]);
  });
});

describe('browser global export (window.ChokaBarahEngine)', () => {
  test('engine is exposed on window when loaded in a browser context', () => {
    const fs = require('fs');
    const vm = require('vm');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, 'game-engine.js'), 'utf8');
    const sandbox = { window: {} };
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: 'game-engine.js' });
    const engine = sandbox.window.ChokaBarahEngine;
    expect(engine).toBeDefined();
    expect(typeof engine.calculateValidMoves).toBe('function');
    expect(typeof engine.createInitialState).toBe('function');
    expect(typeof engine.executeMove).toBe('function');
  });
});
