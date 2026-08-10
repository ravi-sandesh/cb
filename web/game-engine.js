// ============================================================
// CHOKA BARAH – Pure Game Engine (No DOM Dependencies)
// Extracted from app.js for unit testing
// Instrumented with structured telemetry (see telemetry.js).
// T is a no-op logger when telemetry is disabled / absent.
// ============================================================

// ---- Telemetry (zero-cost when disabled) ----
const T = (typeof window !== 'undefined' && window.Telemetry) || { info(){}, debug(){}, warn(){}, error(){}, trace(){}, startSpan(){}, endSpan(){} };

// ---- Board Paths ----

// 5x5 outer ring (anti-clockwise, 16 cells). Player 0 (South) starts at (4,2).
const OUTER_5 = [
    [4,2],[4,3],[4,4],[3,4],[2,4],[1,4],[0,4],[0,3],
    [0,2],[0,1],[0,0],[1,0],[2,0],[3,0],[4,0],[4,1]
];
// Inner ring + center (9 cells). Entry gate: (3,1)
const INNER_5 = [
    [3,1],[3,2],[3,3],[2,3],[1,3],[1,2],[1,1],[2,1],[2,2]
];

// 7x7 outer ring (anti-clockwise, 24 cells). Player 0 (South) starts at (6,3).
const OUTER_7 = [
    [6,3],[6,4],[6,5],[6,6],[5,6],[4,6],[3,6],[2,6],[1,6],[0,6],
    [0,5],[0,4],[0,3],[0,2],[0,1],[0,0],[1,0],[2,0],[3,0],[4,0],
    [5,0],[6,0],[6,1],[6,2]
];
// Inner two rings + center (25 cells). Entry gate: (5,2)
const INNER_7 = [
    [5,2],[5,3],[5,4],[5,5],[4,5],[3,5],[2,5],[1,5],
    [1,4],[1,3],[1,2],[1,1],[2,1],[3,1],[4,1],[5,1],
    [4,2],[4,3],[4,4],[3,4],[2,4],[2,3],[2,2],[3,2],
    [3,3]
];

function get5x5Path(pIndex) {
    const offsets = [0, 8, 4, 12]; // South, North, East, West
    const off = offsets[pIndex] || 0;
    const outer = [];
    for (let i = 0; i < 16; i++) outer.push(OUTER_5[(off + i) % 16]);
    return outer.concat(INNER_5);
}

function get7x7Path(pIndex) {
    const offsets = [0, 12, 6, 18]; // South, North, East, West
    const off = offsets[pIndex] || 0;
    const outer = [];
    for (let i = 0; i < 24; i++) outer.push(OUTER_7[(off + i) % 24]);
    return outer.concat(INNER_7);
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

function innerStartIndex(gridSize) {
    return gridSize === 5 ? 16 : 24;
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
    T.trace('engine.track', 'track.safe_cell_check', `Checked safe status of (${r},${c})`, { gridSize, row: r, col: c, isSafe: safe });
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
        // Label text is the SINGLE source of truth shared with the Kotlin engine
        // (scoreShells) and the rules doc: "—" em-dash and "Score: N" casing (parity).
        scoreText = mouthUp === 4 ? 'CHOWKA (4) — EXTRA ROLL!' :
                    mouthUp === 0 ? 'BAARA (8) — EXTRA ROLL!' : `Score: ${score}`;
        isExtraRoll = (score === 4 || score === 8);
    } else {
        score = mouthUp === 6 ? 6 : mouthUp === 0 ? 12 : mouthUp;
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
    T.trace('engine.move', 'move.pawns_at_coords', `Found ${found.length} pawns at (${r},${c})`, { row: r, col: c, count: found.length, ids: found.map(p => p.id) });
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

function calculateValidMoves(gridSize, pawns, currentPlayerIndex, hasCapturedOpponent, score) {
    const scoreValidation = validateScore(gridSize, score);
    if (!scoreValidation.ok) {
        T.warn('engine.move', 'move.invalid_score', `calculateValidMoves rejected: ${scoreValidation.reason}`, { score, gridSize });
        return [];
    }
    const spanId = T.startSpan ? T.startSpan('calculateMoves', { player: currentPlayerIndex, score }) : null;
    const path = getPlayerPath(gridSize, currentPlayerIndex);
    const innerGate = innerStartIndex(gridSize);
    const hasInner = hasCapturedOpponent[currentPlayerIndex];

    const validMoves = [];
    const myPawns = pawns.filter(p => p.playerIndex === currentPlayerIndex && p.state !== 'FINISHED');

    // Group by cell position
    const groups = {};
    myPawns.forEach(pawn => {
        const key = pawn.state === 'HOME_BASE' ? `HOME_${pawn.id}` : `${pawn.pathIndex}`;
        if (!groups[key]) groups[key] = { pawns: [], pathIndex: pawn.state === 'HOME_BASE' ? -1 : pawn.pathIndex };
        groups[key].pawns.push(pawn);
    });

    // Telemetry: log grouping decision (each HOME pawn is its own unit; ON_TRACK pawns grouped by Gatti).
    T.debug('engine.move', 'move.groups_computed', `Computed ${Object.keys(groups).length} movable group(s)`,
        { player: currentPlayerIndex, groups: Object.keys(groups).map(k => ({ key: k, count: groups[k].pawns.length })) });

    Object.values(groups).forEach(group => {
        const { pawns: grpPawns, pathIndex: curIdx } = group;
        const isHome = curIdx === -1;

        let nextIdx = isHome ? (score - 1) : (curIdx + score);

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

        const targetCoords = path[nextIdx];
        const [tr, tc] = targetCoords;
        const safe = isSafeCell(gridSize, tr, tc);
        const reachesHome = (nextIdx === path.length - 1);

        const pawnsAtTarget = getPawnsAtCoords(gridSize, pawns, tr, tc, null);
        const opponentsAtTarget = pawnsAtTarget.filter(p => p.playerIndex !== currentPlayerIndex);
        // A Gatti is 2+ pawns of the SAME player. Opponents from two DIFFERENT
        // players each holding a single pawn are all individually capturable.
        const perPlayerCounts = {};
        opponentsAtTarget.forEach(p => { perPlayerCounts[p.playerIndex] = (perPlayerCounts[p.playerIndex] || 0) + 1; });
        const opponentGatti = Object.values(perPlayerCounts).some(c => c >= 2);
        const myGroupIsGatti = grpPawns.length >= 2;

        let isCapture = false;
        let blocked = false;

        if (opponentsAtTarget.length > 0) {
            if (safe) {
                isCapture = false;
                blocked = false;
            } else if (opponentGatti) {
                blocked = true; // Opponent Gatti cannot be captured by ANYONE
                T.trace('engine.move', 'move.gatti_blocked', `Target is an opponent Gatti; cannot capture`,
                    { pawnIds: grpPawns.map(p => p.id), targetCoords, opponentCount: opponentsAtTarget.length, reason: 'opponent_gatti' });
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
            isGattiGroup: myGroupIsGatti
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
    return { ok: true };
}

function executeMove(gridSize, pawns, hasCapturedOpponent, currentPlayerIndex, move, currentRoll) {
    const validation = validateMove(move);
    if (!validation.ok) {
        T.warn('engine.move', 'move.invalid_input', `executeMove rejected: ${validation.reason}`, { move });
        return {
            pawns,
            hasCapturedOpponent,
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
    const newHasCaptured = { ...hasCapturedOpponent }; // never mutate the caller's object
    const grpPawnIds = new Set(grpPawns.map(p => p.id));

    grpPawns.forEach(pawn => {
        const idx = newPawns.findIndex(p => p.id === pawn.id);
        if (idx !== -1) {
            newPawns[idx].state = reachesHome ? 'FINISHED' : 'ON_TRACK';
            newPawns[idx].pathIndex = targetPathIndex;
        }
    });

    // BUG-01-FIX: safe when a caller omits currentRoll (undefined). A plain
    // move must not grant an extra roll; capture still sets it explicitly below.
    let extraTurn = !!(currentRoll && currentRoll.isExtraRoll);
    let gattiFormed = false;
    let capturedCount = 0;

    // Handle capture
    if (isCapture && !safe) {
        newPawns.forEach(p => {
            if (p.playerIndex !== currentPlayerIndex && p.state === 'ON_TRACK') {
                const coord = getPawnCoords(gridSize, p);
                if (coord && coord[0] === tr && coord[1] === tc) {
                    p.state = 'HOME_BASE';
                    p.pathIndex = -1;
                    capturedCount++;
                }
            }
        });
        newHasCaptured[currentPlayerIndex] = true;
        extraTurn = true;
        T.info('engine.move', 'move.capture', `Player ${currentPlayerIndex} captured ${capturedCount} opponent pawn(s)`,
            { byPlayer: currentPlayerIndex, capturedCount, targetCoords });
    }

    // Check for Gatti formation at destination after move.
    // Announce only when this move SURPASSES the moving group: the destination
    // must already house 2+ of our pawns AND the landed pawns must exceed the
    // mover count. That correctly handles:
    //   - BUG-02: a pre-existing Gatti repositioning alone does NOT re-announce.
    //   - BUG-03: a capture onto a cell holding our own pawn still forms a Gatti.
    //   - EC-16 : a moving Gatti landing on our own single pawn grows to a Gatti of 3.
    const nowAtDest = newPawns.filter(p =>
        p.playerIndex === currentPlayerIndex &&
        p.state === 'ON_TRACK' &&
        p.pathIndex === targetPathIndex
    );
    if (nowAtDest.length >= 2 && nowAtDest.length > grpPawns.length) {
        gattiFormed = true;
        T.info('engine.move', 'move.gatti_formed', `Player ${currentPlayerIndex} formed a Gatti at ${tr},${tc}`,
            { byPlayer: currentPlayerIndex, targetCoords, count: nowAtDest.length, pawnIds: nowAtDest.map(p => p.id) });
    }

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
        hasCapturedOpponent: newHasCaptured,
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
        validMoves.find(m => m.isCapture) ||
        validMoves.find(m => m.reachesHome) ||
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
    for (let p = 0; p < playerNum; p++) {
        hasCapturedOpponent[p] = false;
        for (let id = 0; id < 4; id++) {
            pawns.push({ id: p * 4 + id, playerIndex: p, state: 'HOME_BASE', pathIndex: -1 });
        }
    }
    const state = {
        pawns,
        hasCapturedOpponent,
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
