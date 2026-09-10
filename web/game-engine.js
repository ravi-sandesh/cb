// ============================================================
// CHOKA BARAH – Pure Game Engine (No DOM Dependencies)
// Extracted from app.js for unit testing
// Instrumented with structured telemetry (see telemetry.js).
// T is a no-op logger when telemetry is disabled / absent.
// ============================================================

// ---- Telemetry ----
// TELEMETRY_ENABLED gates the logging calls on the hot path. The message
// template literals and structured-field objects are only built when a
// telemetry sink is attached; otherwise isSafeCell/getPawnsAtCoords (called
// per cell / per pawn) skip that allocation entirely.
const TELEMETRY_ENABLED = !!(typeof window !== 'undefined' && window.Telemetry);
const T = (typeof window !== 'undefined' && window.Telemetry) || { enabled:false, info(){}, debug(){}, warn(){}, error(){}, trace(){}, startSpan(){}, endSpan(){} };

// ---- Board Paths ----

// 5x5 outer ring (anti-clockwise, 16 cells). Player 0 (South) starts at (4,2).
const OUTER_5 = [
    [4,2],[4,3],[4,4],[3,4],[2,4],[1,4],[0,4],[0,3],
    [0,2],[0,1],[0,0],[1,0],[2,0],[3,0],[4,0],[4,1]
];
// 5x5 inner ring CLOCKWISE (8 cells) + center. Base order starts at the
// North entry (1,3); every other player rotates it so THEIR entry cell
// (the block before home, stepped inward) comes first:
//   S entry (3,1) -> rot 4, N entry (1,3) -> rot 0,
//   E entry (3,3) -> rot 2, W entry (1,1) -> rot 6.
const INNER_5_RING = [
    [1,3],[2,3],[3,3],[3,2],[3,1],[2,1],[1,1],[1,2]
];
const INNER_5_ROT = [4, 0, 2, 6]; // South, North, East, West
const CENTER_5 = [2, 2];
// Legacy alias: South's full inner run (unchanged cell order for P0).
const INNER_5 = [
    [3,1],[3,2],[3,3],[2,3],[1,3],[1,2],[1,1],[2,1],[2,2]
];

// 7x7 outer ring (anti-clockwise, 24 cells). Player 0 (South) starts at (6,3).
const OUTER_7 = [
    [6,3],[6,4],[6,5],[6,6],[5,6],[4,6],[3,6],[2,6],[1,6],[0,6],
    [0,5],[0,4],[0,3],[0,2],[0,1],[0,0],[1,0],[2,0],[3,0],[4,0],
    [5,0],[6,0],[6,1],[6,2]
];
// 7x7 middle ring CLOCKWISE (16 cells), base order starts at the South
// entry (5,2). Rotation puts each player's entry first:
//   S (5,2) -> 0, N (1,5) -> 9, E (4,5) -> 12, W (2,1) -> 4.
const MIDDLE_7_RING = [
    [5,2],[5,1],[4,1],[3,1],[2,1],[1,1],[1,2],[1,3],
    [1,4],[1,5],[2,5],[3,5],[4,5],[5,5],[5,4],[5,3]
];
const MIDDLE_7_ROT = [0, 9, 12, 4]; // South, North, East, West
// 7x7 inner ring CLOCKWISE (8 cells), base order starts at the South
// turn-in (4,2). Rotation per player: S -> 0, N (2,4) -> 4,
// E (4,4) -> 6, W (4,2) -> 0. Center (3,3) is appended unrotated;
// every rotation ends on a side-midpoint for an orthogonal home step.
const INNER_7_RING = [
    [4,2],[3,2],[2,2],[2,3],[2,4],[3,4],[4,4],[4,3]
];
const INNER_7_ROT = [0, 4, 6, 0]; // South, North, East, West
const CENTER_7 = [3, 3];
// Legacy alias: South's full inner run (unchanged cell order for P0).
const INNER_7 = [
    [5,2],[5,3],[5,4],[5,5],[4,5],[3,5],[2,5],[1,5],
    [1,4],[1,3],[1,2],[1,1],[2,1],[3,1],[4,1],[5,1],
    [4,2],[4,3],[4,4],[3,4],[2,4],[2,3],[2,2],[3,2],
    [3,3]
];

// Rotate a ring left by k cells (entry cell lands first).
function rotRing(ring, k) {
    const n = ring.length;
    const r = ((k % n) + n) % n;
    const out = [];
    for (let i = 0; i < n; i++) out.push(ring[(r + i) % n]);
    return out;
}

function rotFor(table, pIndex) {
    return (pIndex >= 0 && pIndex < table.length) ? table[pIndex] : 0;
}

function get5x5Path(pIndex) {
    const offsets = [0, 8, 4, 12]; // South, North, East, West
    const off = offsets[pIndex] || 0;
    const outer = [];
    for (let i = 0; i < 16; i++) outer.push(OUTER_5[(off + i) % 16]);
    const inner = rotRing(INNER_5_RING, rotFor(INNER_5_ROT, pIndex));
    inner.push(CENTER_5);
    return outer.concat(inner);
}

function get7x7Path(pIndex) {
    const offsets = [0, 12, 6, 18]; // South, North, East, West
    const off = offsets[pIndex] || 0;
    // North turns into the middle ring one step early at (0,5): its outer
    // run is 23 cells, so its gate sits at index 23, not 24.
    const outerLen = (pIndex === 1) ? 23 : 24;
    const outer = [];
    for (let i = 0; i < outerLen; i++) outer.push(OUTER_7[(off + i) % 24]);
    const middle = rotRing(MIDDLE_7_RING, rotFor(MIDDLE_7_ROT, pIndex));
    const inner = rotRing(INNER_7_RING, rotFor(INNER_7_ROT, pIndex));
    inner.push(CENTER_7);
    return outer.concat(middle, inner);
}

// Memoized player paths. Paths are pure read-only data (never mutated by the
// engine or tests), so caching them is safe and avoids rebuilding the same
// array on every getPawnCoords/getPawnsAtCoords call (the hot path in
// calculateValidMoves / executeMove). Phase 4 performance.
const _pathCache = {};

function getPlayerPath(gridSize, pIndex) {
    const key = `${gridSize}:${pIndex}`;
    if (_pathCache[key]) return _pathCache[key];
    const path = gridSize === 5 ? get5x5Path(pIndex) : get7x7Path(pIndex);
    _pathCache[key] = path;
    T.trace('engine.track', 'track.path_built', `Built player ${pIndex} path (${path.length} cells)`, { gridSize, playerIndex: pIndex, pathLength: path.length });
    return path;
}

// Test/bench hook: clears the path cache (also lets a future hot-reload of
// board constants rebuild cleanly). Not part of the public engine API.
function resetPathCache() {
    for (const k in _pathCache) delete _pathCache[k];
}

function innerStartIndex(gridSize, playerIndex) {
    if (gridSize === 5) return 16;
    // North turns into the middle ring one step early at (0,5).
    return playerIndex === 1 ? 23 : 24;
}

// ---- Safe Squares ----

function isSafeCell(gridSize, r, c) {
    const safe =
        gridSize === 5
            ? (r===4&&c===2)||(r===0&&c===2)||(r===2&&c===4)||(r===2&&c===0)||(r===2&&c===2)
            : (r===0&&c===0)||(r===0&&c===6)||(r===6&&c===0)||(r===6&&c===6)||
              (r===0&&c===3)||(r===3&&c===0)||(r===3&&c===6)||(r===6&&c===3)||
              (r===1&&c===1)||(r===1&&c===5)||(r===5&&c===1)||(r===5&&c===5)||
              (r===3&&c===3);
    if (TELEMETRY_ENABLED) T.trace('engine.track', 'track.safe_cell_check', `Checked safe status of (${r},${c})`, { gridSize, row: r, col: c, isSafe: safe });
    return safe;
}

// ---- Cowry Roll ----

function numShells(gridSize) {
    return gridSize === 5 ? 4 : 6;
}

function scoreCowryRoll(gridSize, shells) {
    const mouthUp = shells.filter(s => s).length;
    let score, scoreText, isExtraRoll;
    if (gridSize === 5) {
        score = mouthUp === 4 ? 4 : mouthUp === 0 ? 8 : mouthUp;
        // P4 BUG-19 (label parity): scoreText is the SINGLE source of truth for
        // how a roll is rendered everywhere. It MUST stay byte-identical to the
        // Kotlin engine's scoreShells() label (engine/.../GameEngine.kt) and to
        // the exact expectations in CHOWKA_BARA_TEST_CASES.md and GameModelsTest.
        // Rules for touch-ups, to keep all surfaces in lockstep:
        //   - The separator is an em dash "—", never a plain hyphen "-".
        //   - Plain rolls are cased "Score: N" (title case), NOT "SCORE: N".
        //   - Kotlin mirror: `label = when (score) { 4 -> "CHOWKA (4) — EXTRA
        //     ROLL!" ... else -> "Score: $score" }` (GameEngine.kt scoreShells).
        // If this string ever needs to change, update scoreShells() + its test
        // pin in the same change (the diff coverage gate enforces it on CI).
        scoreText = mouthUp === 4 ? 'CHOWKA (4) — EXTRA ROLL!' :
                    mouthUp === 0 ? 'BAARA (8) — EXTRA ROLL!' : `Score: ${score}`;
        isExtraRoll = (score === 4 || score === 8);
    } else {
        score = mouthUp === 6 ? 6 : mouthUp === 0 ? 12 : mouthUp;
        // Symmetric label contract for the 7x7 board (6 cowries). Chowka = all 6
        // mouths (score 6), Baara = all closed (score 12). Same punctuation rule.
        scoreText = mouthUp === 6 ? 'CHOWKA (6) — EXTRA ROLL!' :
                    mouthUp === 0 ? 'BAARA (12) — EXTRA ROLL!' : `Score: ${score}`;
        isExtraRoll = (score === 6 || score === 12);
    }
    const result = { shells, score, scoreText, isExtraRoll };
    T.trace('engine.roll', 'roll.scored', `Scored cowry roll = ${score}`, { gridSize, shells, mouthUp, score, isExtraRoll });
    return result;
}

// ---- Pawn Helpers ----

function getPawnCoords(gridSize, pawn) {
    if (pawn.state === 'HOME_BASE') return null;
    const path = getPlayerPath(gridSize, pawn.playerIndex);
    return path[pawn.pathIndex];
}

function getPawnsAtCoords(gridSize, pawns, r, c, excludePawnId = null) {
    const found = pawns.filter(p => {
        if (p.id === excludePawnId) return false;
        if (p.state === 'HOME_BASE' || p.state === 'FINISHED') return false;
        const coord = getPawnCoords(gridSize, p);
        return coord && coord[0] === r && coord[1] === c;
    });
    if (TELEMETRY_ENABLED) T.trace('engine.move', 'move.pawns_at_coords', `Found ${found.length} pawns at (${r},${c})`, { row: r, col: c, count: found.length, ids: found.map(p => p.id) });
    return found;
}

// ---- Valid Move Calculation ----
function validateScore(gridSize, score) {
    const maxScore = gridSize === 5 ? 8 : 12;
    if (typeof score !== 'number' || score < 1 || score > maxScore) {
        return { ok: false, reason: `score ${score} invalid for grid ${gridSize}` };
    }
    return { ok: true };
}

function calculateValidMoves(gridSize, pawns, currentPlayerIndex, hasCapturedOpponent, score, toughened) {
    const scoreValidation = validateScore(gridSize, score);
    if (!scoreValidation.ok) {
        T.warn('engine.move', 'move.invalid_score', `calculateValidMoves rejected: ${scoreValidation.reason}`, { score, gridSize });
        return [];
    }
    const spanId = T.startSpan ? T.startSpan('calculateMoves', { player: currentPlayerIndex, score }) : null;
    const path = getPlayerPath(gridSize, currentPlayerIndex);
    const innerGate = innerStartIndex(gridSize, currentPlayerIndex);
    const hasInner = hasCapturedOpponent[currentPlayerIndex];
    const toughCells = ((toughened && toughened[currentPlayerIndex]) || []);

    // Opponent TOUGHENED cells, keyed by board coordinate, for the blockade:
    // a non-toughened mover can neither pass through nor stop on one.
    const oppToughCoords = {};
    pawns.forEach(p => {
        if (p.playerIndex === currentPlayerIndex || p.state !== 'ON_TRACK') return;
        const cells = ((toughened && toughened[p.playerIndex]) || []);
        if (cells.indexOf(p.pathIndex) === -1) return;
        const coord = getPlayerPath(gridSize, p.playerIndex)[p.pathIndex];
        if (coord) oppToughCoords[coord[0] + ',' + coord[1]] = true;
    });

    const validMoves = [];
    const myPawns = pawns.filter(p => p.playerIndex === currentPlayerIndex && p.state !== 'FINISHED');

    // Group by cell position — EXCEPT outer-track pawns (pathIndex < gate),
    // which move as vulnerable singles even when stacked: Gatti is
    // inner-only now, so an outer stack is never one movable unit.
    const groups = {};
    myPawns.forEach(pawn => {
        const key = (pawn.state === 'HOME_BASE' || pawn.pathIndex < innerGate)
            ? `SINGLE_${pawn.id}` : `${pawn.pathIndex}`;
        if (!groups[key]) groups[key] = { pawns: [], pathIndex: pawn.state === 'HOME_BASE' ? -1 : pawn.pathIndex };
        groups[key].pawns.push(pawn);
    });

    // Telemetry: log grouping decision (each HOME pawn is its own unit; ON_TRACK pawns grouped by Gatti).
    T.debug('engine.move', 'move.groups_computed', `Computed ${Object.keys(groups).length} movable group(s)`,
        { player: currentPlayerIndex, groups: Object.keys(groups).map(k => ({ key: k, count: groups[k].pawns.length })) });

    Object.values(groups).forEach(group => {
        const { pawns: grpPawns, pathIndex: curIdx } = group;
        const isHome = curIdx === -1;
        const isPair = grpPawns.length >= 2;
        // Inner pairs are tollu until toughened (a roll of 2 hardens them).
        // The flag alone is not enough: a lone single sitting on a stale
        // flagged cell moves as an ordinary single (no blockade pass).
        const moverToughened = !isHome && isPair && toughCells.indexOf(curIdx) !== -1;
        const isTollu = isPair && !isHome && !moverToughened;
        // Pairs move on even rolls only, together: tollu at half rate,
        // toughened at full rate. Odd rolls offer no pair move at all.
        if (isPair && !isHome && score % 2 !== 0) {
            T.trace('engine.move', 'move.pair_stuck', `Pair cannot move on odd score ${score}`,
                { pawnIds: grpPawns.map(p => p.id), curIdx, score, reason: 'pair-even-only' });
            return;
        }
        let step = score;
        if (isTollu) step = score / 2;

        // A home pawn entering the track moves `score` steps from the start
        // cell (path[0]) — same distance an on-track pawn covers from its
        // current position. With score=2, both land at path[2].
        let nextIdx = isHome ? score : (curIdx + step);

        if (nextIdx >= path.length) {
            T.trace('engine.move', 'move.overshoot_skipped', `Group at idx ${curIdx} + ${score} overshoots path (len ${path.length})`,
                { pawnIds: grpPawns.map(p => p.id), curIdx, score, nextIdx, reason: 'overshoot' });
            return;
        }
        if (!hasInner && nextIdx >= innerGate) {
            T.trace('engine.move', 'move.gate_blocked', `Group cannot enter inner path (no cut yet)`,
                { pawnIds: grpPawns.map(p => p.id), nextIdx, innerGate, hasInner, reason: 'gate' });
            return;
        }

        // Blockade: a non-toughened mover can neither pass through nor stop
        // on an opponent's toughened cell. (A toughened mover passes freely;
        // landing capture immunity is enforced by the capture rules below.)
        if (!moverToughened) {
            const from = isHome ? 1 : curIdx + 1;
            for (let ii = from; ii < nextIdx; ii++) {
                const cell = path[ii];
                if (cell && oppToughCoords[cell[0] + ',' + cell[1]]) {
                    T.trace('engine.move', 'move.blockade_blocked', `Move crosses a toughened cell at path idx ${ii}`,
                        { pawnIds: grpPawns.map(p => p.id), curIdx, nextIdx, blockedIdx: ii, reason: 'blockade' });
                    return;
                }
            }
        }

        const targetCoords = path[nextIdx];
        const [tr, tc] = targetCoords;
        const safe = isSafeCell(gridSize, tr, tc);
        const reachesHome = (nextIdx === path.length - 1);

        const pawnsAtTarget = getPawnsAtCoords(gridSize, pawns, tr, tc, null);
        const opponentsAtTarget = pawnsAtTarget.filter(p => p.playerIndex !== currentPlayerIndex);
        // Opponent pairs occupying the target, grouped per player so the
        // toughened flag (stored per player + pathIndex) resolves correctly.
        const perPlayerLists = {};
        opponentsAtTarget.forEach(p => { (perPlayerLists[p.playerIndex] = perPlayerLists[p.playerIndex] || []).push(p); });
        // Only a TOUGHENED pair is immune: tollu pairs and stacked outer
        // singles are capturable (capture-one), matching the inner-only
        // Gatti rule. Safe squares still shelter everyone.
        const opponentToughened = Object.keys(perPlayerLists).some(pi => {
            const list = perPlayerLists[pi];
            return list.length >= 2 && ((toughened && toughened[pi]) || []).indexOf(list[0].pathIndex) !== -1;
        });
        const myGroupIsGatti = grpPawns.length >= 2;
        // A tollu pair moving on an exact 2 hardens into a TOUGHENED Gatti
        // at its destination (unless the destination is Center Home, where
        // the pair finishes instead of toughening).
        const toughens = isTollu && score === 2 && !reachesHome;

        let isCapture = false;
        let blocked = false;
        let capturesGatti = false;

        if (opponentsAtTarget.length > 0) {
            if (safe) {
                isCapture = false;
                blocked = false;
            } else if (opponentToughened) {
                if (moverToughened && myGroupIsGatti) {
                    // Gatti captures Gatti: a toughened pair landing on an
                    // opponent's toughened pair takes the WHOLE pair home.
                    isCapture = true;
                    capturesGatti = true;
                } else {
                    blocked = true; // Tollu/singles cannot touch a toughened Gatti
                    T.trace('engine.move', 'move.gatti_blocked', `Target is an opponent toughened Gatti; cannot capture`,
                        { pawnIds: grpPawns.map(p => p.id), targetCoords, opponentCount: opponentsAtTarget.length, reason: 'opponent_gatti' });
                }
            } else {
                isCapture = true;
            }
        }

        if (blocked) return;

        validMoves.push({
            grpPawns,
            targetPathIndex: nextIdx,
            targetCoords,
            isCapture,
            reachesHome,
            isGattiGroup: myGroupIsGatti,
            isToughened: moverToughened && myGroupIsGatti,
            toughens,
            capturesGatti
        });
    });

    T.debug('engine.move', 'move.valid_computed', `Computed ${validMoves.length} valid move(s)`,
        { player: currentPlayerIndex, score, count: validMoves.length, moves: validMoves.map(m => ({ coords: m.targetCoords, capture: m.isCapture, home: m.reachesHome, gatti: m.isGattiGroup })) });
    if (spanId && T.endSpan) T.endSpan(spanId, { outcome: 'computed', count: validMoves.length });
    return validMoves;
}

// ---- Move Execution ----
// Guard: validate move input
function validateMove(move) {
    if (!move) return { ok: false, reason: 'move is null/undefined' };
    if (!Array.isArray(move.grpPawns) || move.grpPawns.length === 0) return { ok: false, reason: 'grpPawns empty' };
    if (typeof move.targetPathIndex !== 'number' || move.targetPathIndex < 0) return { ok: false, reason: 'invalid targetPathIndex' };
    if (!Array.isArray(move.targetCoords) || move.targetCoords.length !== 2) return { ok: false, reason: 'invalid targetCoords' };
    if (typeof move.isCapture !== 'boolean') return { ok: false, reason: 'isCapture not boolean' };
    if (typeof move.reachesHome !== 'boolean') return { ok: false, reason: 'reachesHome not boolean' };
    // isGattiGroup is optional; treat undefined as false
    if (move.isGattiGroup !== undefined && typeof move.isGattiGroup !== 'boolean') return { ok: false, reason: 'isGattiGroup not boolean' };
    // isToughened / toughens / capturesGatti are optional; treat undefined as false
    if (move.isToughened !== undefined && typeof move.isToughened !== 'boolean') return { ok: false, reason: 'isToughened not boolean' };
    if (move.toughens !== undefined && typeof move.toughens !== 'boolean') return { ok: false, reason: 'toughens not boolean' };
    if (move.capturesGatti !== undefined && typeof move.capturesGatti !== 'boolean') return { ok: false, reason: 'capturesGatti not boolean' };
    return { ok: true };
}

function executeMove(gridSize, pawns, hasCapturedOpponent, currentPlayerIndex, move, currentRoll, toughened) {
    const validation = validateMove(move);
    if (!validation.ok) {
        T.warn('engine.move', 'move.invalid_input', `executeMove rejected: ${validation.reason}`, { move });
        return {
            pawns,
            hasCapturedOpponent,
            toughened: (toughened || {}),
            extraTurn: false,
            gattiFormed: false,
            capturedCount: 0,
            winner: null,
            reachesHome: false,
            error: validation.reason
        };
    }
    const spanId = T.startSpan ? T.startSpan('executeMove', { player: currentPlayerIndex, target: move.targetCoords }) : null;
    const { grpPawns, targetPathIndex, targetCoords, isCapture, reachesHome } = move;
    const [tr, tc] = targetCoords;
    const safe = isSafeCell(gridSize, tr, tc);

    T.debug('engine.move', 'move.start', `Executing move for ${grpPawns.length} pawn(s) to ${tr},${tc}`,
        { pawnIds: grpPawns.map(p => p.id), targetPathIndex, targetCoords, isCapture, reachesHome, safe });

    // Create new pawns array (immutable approach for testing)
    const newPawns = pawns.map(p => ({ ...p }));
    // BUG-17-FIX (observational purity): capture XORs the "gate unlocked" flag
    // into hasCapturedOpponent. We must NEVER write into the caller's map object
    // — app.js and parity tests reuse the array they pass in, and an in-place
    // write hidden inside a "pure" function is the classic API surprise. Copy
    // the map once up front (copy-on-write), mutate only the copy, and hand it
    // back in `result`. Pre-fix code did `hasCapturedOpponent[i]=true` in place
    // AND then re-spread the already-mutated original into the result.
    const newHasCaptured = { ...hasCapturedOpponent };
    const grpPawnIds = new Set(grpPawns.map(p => p.id));
    // Copy-on-write for the toughened map (same contract as hasCapturedOpponent).
    const newToughened = {};
    Object.keys(toughened || {}).forEach(k => { newToughened[k] = ((toughened || {})[k] || []).slice(); });

    grpPawns.forEach(pawn => {
        const idx = newPawns.findIndex(p => p.id === pawn.id);
        if (idx !== -1) {
            newPawns[idx].state = reachesHome ? 'FINISHED' : 'ON_TRACK';
            newPawns[idx].pathIndex = targetPathIndex;
        }
    });

    // BUG-01-FIX: tolerate a caller that omits currentRoll (undefined).
    //   Why it breaks pre-fix: `currentRoll.isExtraRoll` threw a TypeError
    //   (cannot read properties of undefined). That crashed the web app whenever
    //   executeMove was invoked without a fresh requestContext — the app's
    //   executeMove passes `currentRoll || { isExtraRoll: false }` as a guard,
    //   but unit tests and older callers passed nothing at all.
    //   Why the guard is correct: a plain move with no captured roll must NOT
    //   silently grant an extra turn. `!!(x && x.isExtraRoll)` yields `true`
    //   ONLY for an explicitly extra roll; a capture forces `extraTurn = true`
    //   itself in the capture block below, so a capture can never be lost.
    let extraTurn = !!(currentRoll && currentRoll.isExtraRoll);
    let gattiFormed = false;
    let capturedCount = 0;

    // Handle capture: normally capture-one (lowest id). A Gatti-vs-Gatti
    // landing takes the WHOLE defender pair home. Toughened pairs never
    // reach this branch as victims except via capturesGatti (landing on
    // them is otherwise blocked in validMoves).
    if (isCapture && !safe) {
        const victims = [];
        newPawns.forEach(p => {
            if (p.playerIndex !== currentPlayerIndex && p.state === 'ON_TRACK') {
                const coord = getPawnCoords(gridSize, p);
                if (coord && coord[0] === tr && coord[1] === tc) victims.push(p);
            }
        });
        victims.sort((a, b) => a.id - b.id);
        const caught = (move.capturesGatti === true) ? victims : victims.slice(0, 1);
        caught.forEach(p => {
            p.state = 'HOME_BASE';
            p.pathIndex = -1;
            capturedCount++;
        });
        newHasCaptured[currentPlayerIndex] = true;
        extraTurn = true;
        T.info('engine.move', 'move.capture', `Player ${currentPlayerIndex} captured ${capturedCount} opponent pawn(s)`,
            { byPlayer: currentPlayerIndex, capturedCount, targetCoords });
    }

    // Toughening: a tollu pair arriving on a 2 hardens into a Gatti here.
    // (Home arrivals finish instead — the flag is never set for them, so a
    // pair finishing together does not announce a Gatti.)
    if (move.toughens === true && !reachesHome) {
        const cell = newToughened[currentPlayerIndex] || (newToughened[currentPlayerIndex] = []);
        if (cell.indexOf(targetPathIndex) === -1) cell.push(targetPathIndex);
        gattiFormed = true;
        T.info('engine.move', 'move.toughened', `Player ${currentPlayerIndex} toughened a Gatti at ${tr},${tc}`,
            { byPlayer: currentPlayerIndex, targetCoords, pawnIds: grpPawns.map(p => p.id) });
    }

    // A hardened pair carries its flag to its destination (finishing pairs
    // excepted — FINISHED pawns hold no cells). The cleanup below drops the
    // vacated cell and keeps the new one.
    if (move.isToughened === true && !reachesHome) {
        const carry = newToughened[currentPlayerIndex] || (newToughened[currentPlayerIndex] = []);
        if (carry.indexOf(targetPathIndex) === -1) carry.push(targetPathIndex);
    }

    // Toughened-flag cleanup: a flag survives only while 2+ same-player
    // ON_TRACK pawns actually share the cell (moves, captures and finishes
    // could otherwise strand it and blockade the board forever).
    Object.keys(newToughened).forEach(k => {
        const pi = Number(k);
        newToughened[k] = newToughened[k].filter(idx =>
            newPawns.filter(p => p.playerIndex === pi && p.state === 'ON_TRACK' && p.pathIndex === idx).length >= 2);
        if (newToughened[k].length === 0) delete newToughened[k];
    });

    // Victory check
    const allDone = newPawns
        .filter(p => p.playerIndex === currentPlayerIndex)
        .every(p => p.state === 'FINISHED');

    let winner = null;
    if (allDone) {
        winner = currentPlayerIndex;
        T.info('engine.game', 'game.victory', `Player ${currentPlayerIndex} won the game`,
            { winnerIndex: currentPlayerIndex, gridSize, gattiFormed });
    }

    const result = {
        pawns: newPawns,
        // See the newHasCaptured note at the top of executeMove: this is the
        // COPY that was captured into, never the caller's original object.
        // Same contract for the toughened map (see newToughened above).
        hasCapturedOpponent: newHasCaptured,
        toughened: newToughened,
        extraTurn,
        gattiFormed,
        capturedCount,
        winner,
        reachesHome
    };
    T.debug('engine.move', 'move.completed', `Move completed`, { extraTurn, gattiFormed, capturedCount, winner, reachesHome });
    if (spanId && T.endSpan) T.endSpan(spanId, { outcome: winner !== null ? 'victory' : 'applied', extraTurn, gattiFormed, capturedCount });
    return result;
}

// ---- Turn Management ----

function advanceTurn(playerNum, currentPlayerIndex) {
    const next = (currentPlayerIndex + 1) % playerNum;
    T.debug('engine.turn', 'turn.advanced', `Advancing turn from ${currentPlayerIndex} to ${next}`, { from: currentPlayerIndex, to: next, playerNum });
    return next;
}

// ---- Bot AI ----

function selectBotMove(validMoves, gridSize) {
    if (validMoves.length === 0) {
        T.debug('engine.bot', 'bot.no_moves', 'Bot had no valid moves to choose from', { candidateCount: 0 });
        return null;
    }

    const best =
        validMoves.find(m => m.isCapture && m.capturesGatti) ||
        validMoves.find(m => m.isCapture) ||
        validMoves.find(m => m.reachesHome) ||
        validMoves.find(m => m.toughens) ||
        validMoves.find(m => isSafeCell(gridSize, m.targetCoords[0], m.targetCoords[1])) ||
        validMoves.find(m => m.isGattiGroup) ||
        [...validMoves].sort((a, b) => b.grpPawns[0].pathIndex - a.grpPawns[0].pathIndex)[0];

    T.debug('engine.bot', 'bot.move_selected', `Bot selected move to ${best.targetCoords}`,
        { chosenMove: { pawnIds: best.grpPawns.map(p => p.id), targetCoords: best.targetCoords, isCapture: best.isCapture, reachesHome: best.reachesHome, isGattiGroup: best.isGattiGroup }, candidateCount: validMoves.length });
    return best;
}

// ---- Initial State ----

function createInitialState(gridSize, playerNum) {
    const pawns = [];
    const hasCapturedOpponent = {};
    const toughened = {};
    for (let p = 0; p < playerNum; p++) {
        hasCapturedOpponent[p] = false;
        for (let id = 0; id < 4; id++) {
            pawns.push({ id: p * 4 + id, playerIndex: p, state: 'HOME_BASE', pathIndex: -1 });
        }
    }
    const state = {
        pawns,
        hasCapturedOpponent,
        toughened,
        currentPlayerIndex: 0,
        currentRoll: null,
        validMoves: [],
        winner: null,
        gameActive: true
    };
    T.debug('engine.state', 'state.initialized', `Created initial state (${gridSize}x${gridSize}, ${playerNum} players)`, { gridSize, playerNum, pawnCount: pawns.length });
    return state;
}

// ---- Exports ----

// ---- Exports ----
// In Node (tests) expose via module.exports; in the browser expose a global
// (ChokaBarahEngine) so app.js consumes the SAME tested code paths.
const ENGINE_EXPORTS = {
        // Paths
        get5x5Path,
        get7x7Path,
        getPlayerPath,
        innerStartIndex,
        OUTER_5,
        INNER_5,
        OUTER_7,
        INNER_7,
        INNER_5_RING,
        INNER_5_ROT,
        MIDDLE_7_RING,
        MIDDLE_7_ROT,
        INNER_7_RING,
        INNER_7_ROT,
        CENTER_5,
        CENTER_7,
        // Safe cells
        isSafeCell,
        // Cowry
        numShells,
        scoreCowryRoll,
        // Pawn helpers
        getPawnCoords,
        getPawnsAtCoords,
        // Path cache (perf test hook)
        resetPathCache,
        // Move logic
        calculateValidMoves,
        executeMove,
        // Turn
        advanceTurn,
        // Bot
        selectBotMove,
        // Initial state
        createInitialState
    };

if (typeof module !== 'undefined' && module.exports) {
    module.exports = ENGINE_EXPORTS;
} else if (typeof window !== 'undefined') {
    window.ChokaBarahEngine = ENGINE_EXPORTS;
}
