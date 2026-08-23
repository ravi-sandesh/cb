// ============================================================
// Parity corpus generator
// ------------------------------------------------------------
// Computes the frozen, language-neutral rule corpus for the
// differential JS<->Kotlin engine parity test by calling the
// reference pure functions in web/game-engine.js:
//
//   1. getPlayerPath      -> all 4 player paths (5x5 & 7x7)
//   2. isSafeCell         -> safe squares per board
//   3. scoreCowryRoll     -> every shell pattern (4 & 6 shells)
//   4. calculateValidMoves-> deterministic board states (home
//      entry, gate, overshoot, captures, Gatti, safe, home reach)
//
// Output: parity-corpus.json written to BOTH
//   - web/parity/parity-corpus.json          (web parity test)
//   - engine/src/test/resources/parity/...   (Kotlin parity test)
// Copies are CHECKED IN and kept in sync automatically — ONE run of this
// script refreshes both copies (do not hand-copy).
//
// Run:  node web/scripts/gen-parity-corpus.js
// ============================================================
const fs = require('fs');
const path = require('path');
const E = require('../game-engine.js');

const H = 'HOME_BASE';
const T = 'ON_TRACK';

function pawn(id, player, state, pathIndex) {
    return { id, playerIndex: player, state, pathIndex };
}
const homePawn = (id, player) => pawn(id, player, H, -1);
const trackPawn = (id, player, pathIndex) => pawn(id, player, T, pathIndex);

// Index of the cell (r,c) on a given player's path (-1 if not on it).
function idxOf(gridSize, player, r, c) {
    return E.getPlayerPath(gridSize, player).findIndex(x => x[0] === r && x[1] === c);
}

// Builds a scenario in a readable, deterministic way.
//  myPawns: current player's pawns as { id, state, pathIndex }
//  oppAt:   list of { player, id, r, c } -> opponent pawn placed on their own
//           track at the exact board cell (r,c); throws if not on their path.
function sc(grid, player, score, hasCaptured, myPawns, oppAt = []) {
    const pawns = [...myPawns];
    for (const opp of oppAt) {
        const pi = idxOf(grid, opp.player, opp.r, opp.c);
        if (pi < 0) throw new Error(`cell (${opp.r},${opp.c}) not on P${opp.player} path (${grid}x${grid})`);
        pawns.push(trackPawn(opp.id, opp.player, pi));
    }
    return { grid, player, score, hasCaptured, pawns };
}

// --- cowry scoring: enumerate every shell pattern ---------------------
const cowryRolls = [];
for (const num of [4, 6]) {
    for (let n = 0; n < Math.pow(2, num); n++) {
        const shells = [];
        for (let b = 0; b < num; b++) shells.push(((n >> b) & 1) === 1);
        const r = E.scoreCowryRoll(num === 4 ? 5 : 7, shells);
        cowryRolls.push({ size: num === 4 ? 5 : 7, shells, score: r.score, isExtraRoll: r.isExtraRoll });
    }
}

// --- board geometry ----------------------------------------------------
const paths = [];
for (const gridSize of [5, 7]) {
    for (let p = 0; p < 4; p++) {
        paths.push({ gridSize, playerIndex: p, cells: E.getPlayerPath(gridSize, p) });
    }
}

const safeCells = {};
for (const gridSize of [5, 7]) {
    const cells = [];
    for (let r = 0; r < gridSize; r++) {
        for (let c = 0; c < gridSize; c++) {
            if (E.isSafeCell(gridSize, r, c)) cells.push([r, c]);
        }
    }
    safeCells[gridSize] = cells;
}

const scenarios = [
    // Fresh 5x5 game: every HOME pawn is its own group -> 4 moves for P0.
    sc(5, 0, 4, {},
       [homePawn(0, 0), homePawn(1, 0), homePawn(2, 0), homePawn(3, 0)]),

    // Single cowrie from HOME lands on the (safe) start square.
    sc(5, 0, 1, {},
       [homePawn(0, 0), homePawn(1, 0), homePawn(2, 0), homePawn(3, 0)]),

    // Overshoot: pawn at idx 20 can't move 8 (needs idx 28 > 24).
    sc(5, 0, 8, {},
       [trackPawn(0, 0, 20), homePawn(1, 0), homePawn(2, 0), homePawn(3, 0)]),

    // Gate blocked (no cut): idx 15 + 2 = 17 >= inner gate 16 -> skipped.
    sc(5, 0, 2, {},
       [trackPawn(0, 0, 15), homePawn(1, 0), homePawn(2, 0), homePawn(3, 0)]),

    // Gate open (cut made): outer-last pawn crosses into the inner ring.
    sc(5, 0, 2, { 0: true },
       [trackPawn(0, 0, 15), trackPawn(1, 0, 1)]),

    // Reaching home: the last path cell (idx 24 = center) is safe and wins.
    sc(5, 0, 1, { 0: true },
       [trackPawn(0, 0, 23)]),

    // Own-Gatti group (2 pawns, same player, same cell) moves together.
    sc(5, 0, 1, { 0: true },
       [trackPawn(0, 0, 5), trackPawn(1, 0, 5), homePawn(2, 0), homePawn(3, 0)]),

    // Capture: P0 (idx 3, unsafe target) cuts a single P1 pawn.
    sc(5, 0, 2, {},
       [trackPawn(0, 0, 3), homePawn(1, 0), homePawn(2, 0), homePawn(3, 0)],
       [{ player: 1, id: 4, r: 1, c: 4 }]),

    // Safe square coexist: P0 lands on an opponent occupying a SAFE cell
    // (its own start square) -> no capture.
    sc(5, 0, 1, {},
       [homePawn(0, 0), homePawn(1, 0), homePawn(2, 0), homePawn(3, 0)],
       [{ player: 1, id: 4, r: 4, c: 2 }]),

    // Opponent Gatti (2 identical P1 pawns) blocks capture entirely.
    sc(5, 0, 2, {},
       [trackPawn(0, 0, 3), homePawn(1, 0), homePawn(2, 0), homePawn(3, 0)],
       [{ player: 1, id: 4, r: 1, c: 4 }, { player: 1, id: 5, r: 1, c: 4 }]),

    // Multiple players: two DIFFERENT opponents (1 pawn each) are not a Gatti,
    // so both are capturable on an unsafe cell.
    sc(5, 0, 2, {},
       [trackPawn(0, 0, 3), homePawn(1, 0)],
       [{ player: 1, id: 4, r: 1, c: 4 }, { player: 2, id: 8, r: 1, c: 4 }]),

    // 7x7 fresh game: Chowka (6) brings each HOME pawn to idx 5.
    sc(7, 0, 6, {},
       [homePawn(0, 0), homePawn(1, 0), homePawn(2, 0), homePawn(3, 0)]),

    // 7x7: reaching the center (index 48) after a cut.
    sc(7, 0, 1, { 0: true },
       [trackPawn(0, 0, 47), trackPawn(1, 0, 10)]),

    // 7x7 capture: P0 lands on P1's single pawn on an unsafe outer cell.
    // P0 idx 10 + 3 = 13 -> [0,2] on the 7x7 outer ring.
    sc(7, 0, 3, { 0: true },
       [trackPawn(0, 0, 10), trackPawn(1, 0, 1)],
       [{ player: 1, id: 4, r: 0, c: 2 }]),

    // 7x7 gate blocked without a cut.
    sc(7, 0, 2, {},
       [trackPawn(0, 0, 23), homePawn(1, 0), homePawn(2, 0), homePawn(3, 0)]),

    // Invalid scores on both boards return no moves.
    sc(5, 0, 9, { 0: true },
       [homePawn(0, 0)]),
    sc(7, 0, 0, {},
       [homePawn(0, 0)])
];

// Compute expected moves per 'capability' scenario with the reference engine.
scenarios.forEach((s, i) => {
    s.label = `scen${i + 1}`;
    s.expected = E.calculateValidMoves(s.grid, s.pawns, s.player, s.hasCaptured, s.score)
        .map(m => ({
            pawnIds: m.grpPawns.map(p => p.id),
            targetPathIndex: m.targetPathIndex,
            targetCoords: m.targetCoords,
            isCapture: m.isCapture,
            reachesHome: m.reachesHome,
            isGattiGroup: m.isGattiGroup
        }));
});

// --- move EXECUTION scenarios ------------------------------------------
// Each entry replays a chosen legal move through the reference executeMove
// and freezes the full result (pawn states, capture flags, winner, extra
// turn). Both engines must reproduce these outcomes identically.
function buildMoveExecution(label, grid, player, hasCaptured, pawnsBefore, roll, pick) {
    const valid = E.calculateValidMoves(grid, pawnsBefore, player, hasCaptured, roll.score);
    if (!valid.length) throw new Error(`${label}: no valid moves to execute`);
    const move = pick(valid);
    const res = E.executeMove(grid, pawnsBefore, hasCaptured, player, move, roll);
    if (res.error) throw new Error(`${label}: reference execution failed: ${res.error}`);
    return {
        label,
        gridSize: grid,
        player,
        // Only the extra-roll flag of the pending roll influences execution.
        rollIsExtraRoll: !!roll.isExtraRoll,
        hasCapturedBefore: hasCaptured,
        pawnsBefore: pawnsBefore.map(p => ({ ...p })),
        move: {
            pawnIds: move.grpPawns.map(p => p.id),
            targetPathIndex: move.targetPathIndex,
            targetCoords: move.targetCoords,
            isCapture: move.isCapture,
            reachesHome: move.reachesHome,
            isGattiGroup: !!move.isGattiGroup
        },
        expected: {
            pawnsAfter: res.pawns.map(p => ({ id: p.id, playerIndex: p.playerIndex, state: p.state, pathIndex: p.pathIndex }))
                .sort((a, b) => a.id - b.id),
            hasCapturedAfter: res.hasCapturedOpponent,
            winnerIndex: res.winner === null ? -1 : res.winner,
            extraTurn: res.extraTurn,
            gattiFormed: res.gattiFormed,
            capturedCount: res.capturedCount,
            reachesHome: res.reachesHome
        }
    };
}

const first = (valid) => valid[0];
const findCapture = (valid) => valid.find(m => m.isCapture);

// Opponent helper: place an opponent pawn on its own path at cell (r,c).
function oppPawn(player, id, grid, r, c) {
    const pi = idxOf(grid, player, r, c);
    if (pi < 0) throw new Error(`(${r},${c}) not on P${player} ${grid}x${grid} path`);
    return trackPawn(id, player, pi);
}

const moveExecutions = [
    // Plain home-entry advance: turn passes (no extra roll).
    buildMoveExecution('plain-home-advance', 5, 0, {},
        [homePawn(0, 0), homePawn(1, 0), homePawn(2, 0), homePawn(3, 0)],
        { score: 2, isExtraRoll: false }, first),

    // Capture: pawn cut, gate flag flips on for P0, extra turn granted.
    buildMoveExecution('capture-extra-turn', 5, 0, {},
        [trackPawn(0, 0, 3), homePawn(1, 0), homePawn(2, 0), homePawn(3, 0),
         oppPawn(1, 4, 5, 1, 4)],
        { score: 2, isExtraRoll: false },
        findCapture),

    // Moving Gatti group advances together as one unit.
    buildMoveExecution('gatti-group-move', 5, 0, { 0: true },
        [trackPawn(0, 0, 5), trackPawn(1, 0, 5), homePawn(2, 0), homePawn(3, 0)],
        { score: 3, isExtraRoll: false }, first),

    // Reaching the center finishes ALL of P0's pawns -> victory.
    buildMoveExecution('reach-home-victory', 5, 0, { 0: true },
        [trackPawn(0, 0, 23)],
        { score: 1, isExtraRoll: false }, first),

    // Chowka extra roll keeps the seat after a plain advance (extraTurn true).
    buildMoveExecution('extra-roll-flag', 5, 0, {},
        [homePawn(0, 0), homePawn(1, 0), homePawn(2, 0), homePawn(3, 0)],
        { score: 4, isExtraRoll: true }, first),

    // Safe-square landing onto an opponent: coexist, no capture, no unlock.
    buildMoveExecution('safe-coexist', 5, 0, {},
        [homePawn(0, 0), homePawn(1, 0), homePawn(2, 0), homePawn(3, 0),
         oppPawn(1, 4, 5, 4, 2)],
        { score: 1, isExtraRoll: false },
        first)
];

moveExecutions.forEach(m => {
    m.expected.hasCapturedAfter = Object.keys(m.expected.hasCapturedAfter)
        .sort().reduce((acc, k) => { acc[k] = m.expected.hasCapturedAfter[k]; return acc; }, {});
});

const corpus = {
    formatVersion: 2,
    paths,
    safeCells,
    cowryRolls,
    validMoves: scenarios.map(s => ({
        label: s.label, gridSize: s.grid, player: s.player, score: s.score,
        hasCaptured: s.hasCaptured, pawns: s.pawns, expected: s.expected
    })),
    moveExecutions
};

const outFile = path.join(__dirname, '..', 'parity', 'parity-corpus.json');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(corpus, null, 2) + '\n');

// Keep the Kotlin-side copy in sync automatically: the engine test reads the
// corpus from its own test resources. One generator run refreshes both.
const kotlinFile = path.join(__dirname, '..', '..', 'engine', 'src', 'test', 'resources', 'parity', 'parity-corpus.json');
fs.mkdirSync(path.dirname(kotlinFile), { recursive: true });
fs.writeFileSync(kotlinFile, JSON.stringify(corpus, null, 2) + '\n');

console.log(`Wrote ${outFile}`);
console.log(`Synced ${kotlinFile}`);
console.log(`  paths:        ${paths.length}`);
console.log(`  safeCells:    5x5=${safeCells[5].length}, 7x7=${safeCells[7].length}`);
console.log(`  cowryRolls:   ${cowryRolls.length}`);
console.log(`  validMoves:   ${scenarios.length} scenario(s)`);
console.log(`  moveExecs:    ${moveExecutions.length} scenario(s)`);