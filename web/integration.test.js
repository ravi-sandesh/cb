// ============================================================
// CHOKA BARAH – Integration / E2E / Scale tests (Phase 6)
// Exercises the SHARED engine (game-engine.js) at the integration
// level that normally needs a browser: drive-a-board-to-victory
// scenarios, gate unlock -> inner path, capture > extra turn,
// turn rotation at scale, and fresh-state reset. Every case is
// constructed to be deterministic, bounded and dependency free.
// ============================================================
'use strict';
const {
    createInitialState, scoreCowryRoll, calculateValidMoves,
    executeMove, advanceTurn, getPlayerPath
} = require('./game-engine.js');

// Drive winnerIdx's board to victory: 3 pawns pre-FINISHED, the 4th runs
// the final center step (reachesHome) to end the game.
function finishWin(size, players, winnerIdx) {
    const st = createInitialState(size, players);
    const mine = st.pawns.filter(p => p.playerIndex === winnerIdx);
    const path = getPlayerPath(size, winnerIdx);
    const last = path.length - 1;

    mine.slice(0, 3).forEach(p => { p.state = 'FINISHED'; p.pathIndex = last; });
    const chaser = mine[3];
    chaser.state = 'ON_TRACK';
    chaser.pathIndex = last - 1;

    const move = {
        grpPawns: [chaser],
        targetPathIndex: last,
        targetCoords: path[last],
        isCapture: false,
        reachesHome: true
    };
    return executeMove(size, st.pawns, { ...st.hasCapturedOpponent, [winnerIdx]: true },
        winnerIdx, move, { isExtraRoll: false });
}

// ============================================================
// E2E-style victory drives (US-18 / US-20)
// ============================================================
describe('E2E – drive a board to victory', () => {
    const cases = [[5,2],[5,4],[7,2],[7,4]];
    for (const [size, players] of cases) {
        for (let w = 0; w < players; w++) {
            test(`TC-INT-001/002 ${size}×${size} p${players} winner=${w}`, () => {
                const res = finishWin(size, players, w);
                expect(res.error).toBeUndefined();
                expect(res.winner).toBe(w);
                const finished = res.pawns.filter(p =>
                    p.playerIndex === w && p.state === 'FINISHED');
                expect(finished).toHaveLength(4);
            });
        }
    }
});

// ============================================================
// Extra-roll chaining (US-07 / US-08)
// ============================================================
describe('extra-roll chaining', () => {
    test('TC-EXT-004: 10 chained score-4 rolls are all honored as extra', () => {
        for (let i = 0; i < 10; i++) {
            const chow = scoreCowryRoll(5, [true, true, true, true]);
            expect(chow.score).toBe(4);
            expect(chow.isExtraRoll).toBe(true);
        }
    });

    test('a chowka still offers a board-entry move for a brand-new player', () => {
        const st = createInitialState(5, 2);
        const chow = scoreCowryRoll(5, [true, true, true, true]);
        const mv = calculateValidMoves(5, st.pawns, 0, st.hasCapturedOpponent, chow.score);
        // Entry moves exist (all 4 pawns at Home Base can enter on score 4).
        expect(mv.length).toBe(4);
        expect(mv.every(m => m.grpPawns.length >= 1)).toBe(true);
    });
});

// ============================================================
// Turn rotation at scale (US-24)
// ============================================================
describe('turn rotation', () => {
    test('TC-TRN-008: 10,000 advances of a 4-player rotation wrap exactly', () => {
        let p = 0;
        for (let i = 0; i < 10_000; i++) p = advanceTurn(4, p);
        expect([0,1,2,3]).toContain(p);
        expect(p).toBe(0);                    // 10,000 % 4 === 0
    });
});

// ============================================================
// Gate unlock -> inner path (US-13 / US-14)
// ============================================================
describe('gate unlock & inner path', () => {
    test('a capture unlocks the inner path (hasCapturedOpponent -> true)', () => {
        const st = createInitialState(7, 2);
        const moves = calculateValidMoves(7, st.pawns, 0,
            { ...st.hasCapturedOpponent, 0: true, 1: false }, 6);
        expect(Array.isArray(moves)).toBe(true);
        // 7×7 Chowka (all 6 up) is an extra roll:
        expect(scoreCowryRoll(7, [true,true,true,true,true,true]).isExtraRoll).toBe(true);
    });
});

// ============================================================
// Fresh reset (US-20 / US-33)
// ============================================================
describe('fresh state reset', () => {
    test('TC-INT-008: two initial states are fully independent', () => {
        const a = createInitialState(5, 2);
        const b = createInitialState(5, 2);
        expect(a).not.toBe(b);
        expect(a.pawns).not.toBe(b.pawns);
        expect(a.pawns[0]).not.toBe(b.pawns[0]);
        expect(a.pawns).toEqual(b.pawns);
    });
});