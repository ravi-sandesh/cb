// ============================================================
// BUG VERIFICATION SUITE (web engine + web UI sources)
// ------------------------------------------------------------
// Purpose: PROVE each documented bug from the 30-bug report is
// present TODAY, by pinning the exact current (buggy) output of
// the engine / UI source. Every "describe" is tagged BUG-XX and
// states the DOCUMENTED correct behaviour in its first comment.
//
// IMPORTANT: These tests assert the BUGGY behaviour so they pass
// while the bug exists. If a test starts FAILING it means a fix
// landed — the test must then be flipped to assert the correct
// behaviour (that is the intended regression signal).
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');
const {
    createInitialState, calculateValidMoves, executeMove,
    getPlayerPath, scoreCowryRoll, selectBotMove, getPawnsAtCoords
} = require('./game-engine.js');

const src = (name) => fs.readFileSync(path.join(__dirname, name), 'utf8');
const appSrc = () => src('app.js');
const serverSrc = () => src('server.js');

function mk(nplayers) {
    const pawns = [];
    for (let p = 0; p < nplayers; p++)
        for (let id = 0; id < 4; id++)
            pawns.push({ id: p * 4 + id, playerIndex: p, state: 'HOME_BASE', pathIndex: -1 });
    const cap = {};
    for (let p = 0; p < nplayers; p++) cap[p] = false;
    return { pawns, cap };
}
const set = (ps, id, pi, st = 'ON_TRACK') => { ps[id].pathIndex = pi; ps[id].state = st; };
const idxOf = (path, cell) => path.findIndex(c => c[0] === cell[0] && c[1] === cell[1]);

// ============================================================
// BUG-01 (FIXED): "Opponent Gatti" false positive across DIFFERENT players
// DOC / EC-26: a landing cell holding single pawns of two DIFFERENT
// opponents MUST be capturable (ALL are sent home).
// FIX: Gatti immunity requires 2+ pawns of the SAME player.
// ============================================================
describe('BUG-01 opponent Gatti false positive (different players) — FIXED', () => {
    test('single mover CAN move to a cell shared by two different opponents', () => {
        const { pawns, cap } = mk(4);
        set(pawns, 0, 2);
        const tgt = getPlayerPath(5, 0)[5];       // P0 target cell
        // Two opponents – from TWO DIFFERENT players – sit on that cell
        set(pawns, 6,  idxOf(getPlayerPath(5, 1), tgt));
        set(pawns, 10, idxOf(getPlayerPath(5, 2), tgt));
        const moves = calculateValidMoves(5, pawns, 0, cap, 3);
        const m = moves.find(x => x.targetCoords[0] === tgt[0] && x.targetCoords[1] === tgt[1]);
        expect(m).toBeTruthy();                    // move IS offered now
        expect(m.isCapture).toBe(true);            // and it captures both
        const res = executeMove(5, pawns, cap, 0, m, { isExtraRoll: false });
        expect(res.capturedCount).toBe(2);         // both opponents sent home
    });

    test('a TRUE opponent Gatti (same-player 2-stack) correctly blocks the same move', () => {
        const { pawns, cap } = mk(2);
        set(pawns, 0, 2);
        const tgt = getPlayerPath(5, 0)[5];
        set(pawns, 6, idxOf(getPlayerPath(5, 1), tgt));
        set(pawns, 7, idxOf(getPlayerPath(5, 1), tgt)); // same player -> real Gatti
        const moves = calculateValidMoves(5, pawns, 0, cap, 3);
        expect(moves.some(m => m.isCapture)).toBe(false); // block remains
    });
});

// ============================================================
// BUG-02 (FIXED): Gatti "formed" no longer re-reported for a moved Gatti
// DOC: §5.1 – Gatti formation is announced when 2+ pawns NEWLY join a
//       cell. Moving a pre-existing Gatti is not a formation.
// ============================================================
describe('BUG-02 spurious Gatti re-formation on group move — FIXED', () => {
    test('moving an existing 2-pawn Gatti does NOT report gattiFormed', () => {
        const { pawns, cap } = mk(2);
        set(pawns, 0, 5); set(pawns, 1, 5);            // pre-existing Gatti
        const moves = calculateValidMoves(5, pawns, 0, cap, 2);
        const gattiMove = moves.find(m => m.isGattiGroup);
        const res = executeMove(5, pawns, cap, 0, gattiMove, { isExtraRoll: false });
        expect(res.gattiFormed).toBe(false);           // FIXED: no new formation
    });

    // EC-16 guard: a rebasing Gatti landing on our own SINGLE pawn still grows
    // to 3 — this must announce. Guards the "landed > mover" criterion.
    test('EC-16: a Gatti landing on our own single pawn reports a 3-stack (grow)', () => {
        const { pawns, cap } = mk(2);
        set(pawns, 0, 5); set(pawns, 1, 5);            // pre-existing Gatti at 5
        set(pawns, 2, 7);                              // our single pawn at 7 (own)
        const moves = calculateValidMoves(5, pawns, 0, cap, 2); // group 5 -> 7
        const gattiMove = moves.find(m => m.isGattiGroup);
        expect(gattiMove.targetPathIndex).toBe(7);
        const res = executeMove(5, pawns, cap, 0, gattiMove, { isExtraRoll: false });
        expect(res.gattiFormed).toBe(true);            // EC-16: 3 own pawns share cell
    });
});

// ============================================================
// BUG-03 (FIXED): a CAPTURE that lands onto my OWN pawn now forms a Gatti
// DOC: §5.1 - if two OWN pawns share any cell, a Gatti exists / is announced.
// ============================================================
describe('BUG-03 capture-onto-own-stack forms Gatti — FIXED', () => {
    test('capture onto a cell already holding my own pawn yields gattiFormed=true', () => {
        const { pawns, cap } = mk(2);
        set(pawns, 0, 4);                      // mover -> lands at idx 6
        const tgt = getPlayerPath(5, 0)[6];
        set(pawns, 1, 6);                      // my own pawn already on target cell
        set(pawns, 4, idxOf(getPlayerPath(5, 1), tgt)); // opponent on target too
        const moves = calculateValidMoves(5, pawns, 0, cap, 2);
        const m = moves.find(x => x.targetPathIndex === 6);
        expect(m.isCapture).toBe(true);         // capture path confirmed
        const res = executeMove(5, pawns, cap, 0, m, { isExtraRoll: false });
        expect(res.gattiFormed).toBe(true);     // FIXED: 2 own pawns share the cell
    });
});

// ============================================================
// BUG-04 (gate logic is dead code for HOME-BASE entry)
// DOC: §7.2 EC-09 requires blocking an entry roll that would land at/past
// the gate. Because entry is score-1 (max 8-1=7 on 5x5, 12-1=11 on 7x7)
// the gate branch can never fire for home pawns - EC-09 is unimplementable.
// In fact the engine lets it slide by never evaluating it.
// ============================================================
describe('BUG-04 (informational) HOME entry can never hit the inner gate', () => {
    test('on 7x7 a fresh player has HOME-entry moves even past the gate-equivalent (score 12)', () => {
        const st = createInitialState(7, 2);
        const mv = calculateValidMoves(7, st.pawns, 0, st.hasCapturedOpponent, 12);
        expect(mv.every(m => m.targetPathIndex === 11)).toBe(true); // 12-1
        expect(mv.length).toBe(4);
    });
});

// ============================================================
// BUG-06 (web UI) — FIXED: initGameState re-enables #btn-roll
// ============================================================
describe('BUG-06 btn-roll re-enabled by initGameState — FIXED', () => {
    test('initGameState re-enables btn-roll, so a new game is playable', () => {
        const body = appSrc();
        // victory path still disables the roll button
        expect(body).toMatch(/showVictoryBanner[\s\S]*disabled = true/);
        // initGameState (defined before any roll handler) must re-enable it
        const init = body.slice(0, body.indexOf('function handleRoll'));
        expect(init).toMatch(/btn-roll[\s\S]{0,80}disabled = false/);
    });
});

// ============================================================
// BUG-07 (web UI) — FIXED: restartGame cancels a pending bot timer
// ============================================================
describe('BUG-07 restartGame cancels scheduled bot timer — FIXED', () => {
    test('restartGame body clears a pending bot timer', () => {
        const body = appSrc();
        const fn = body.match(/function restartGame[\s\S]{0,300}/);
        expect(fn).toBeTruthy();
        // FIXED: cleanup now centrally clears bot/turn/victory timers.
        expect(fn[0].includes('clearScheduledTimers')).toBe(true);
    });
});

// ============================================================
// BUG-10 (web UI) — FIXED: finished pawns are NOT drawn on the board
// ============================================================
describe('BUG-10 finished pawns removed from board render — FIXED', () => {
    test('renderBoard excludes FINISHED pawns from the board cell map', () => {
        const body = appSrc();
        // FIXED: finished pawns are skipped before grouping into cells
        expect(body).toMatch(/if \(pawn\.state === 'FINISHED'\) return;/);
        // no longer shares the ON_TRACK branch for drawing
        expect(body).not.toMatch(/pawn\.state === 'ON_TRACK' \|\| pawn\.state === 'FINISHED'/);
    });
});

// ============================================================
// BUG-01 (UI) — FIXED: engine + showVictoryBanner tolerate missing roll / null winner
// ============================================================
describe('BUG-01 null-guards (engine undefined currentRoll + stale banner) — FIXED', () => {
    test('executeMove tolerates undefined currentRoll (no throw, no extra turn)', () => {
        const E = require('./game-engine.js');
        const st = createInitialState(5, 2);
        const moves = E.calculateValidMoves(5, st.pawns, 0, st.hasCapturedOpponent, 3);
        const res = E.executeMove(5, st.pawns, st.hasCapturedOpponent, 0, moves[0], undefined);
        expect(res.error).toBeUndefined();
        expect(res.extraTurn).toBe(false);
        expect(res.winner).toBeNull();
    });

    test('showVictoryBanner is defensively guarded when winner was cleared by a reset', () => {
        const body = appSrc();
        expect(body).toMatch(/showVictoryBanner[\s\S]*if \(!winner \|\| !winner\.name\) return;/);
    });
});

// ============================================================
// BUG-02 (web UI) — FIXED: no-move auto-advance timer is tracked/cleared
// ============================================================
describe('BUG-02 no-move auto-advance uses tracked, cancellable timer — FIXED', () => {
    test('handleRoll schedules the advance through scheduleTurnTimer', () => {
        const body = appSrc();
        expect(body).toMatch(/scheduleTurnTimer\(1000\)/);
        expect(body).not.toMatch(/setTimeout\(advanceTurn, 1000\)/);
    });

    test('restartGame and showHomeScreen invoke clearScheduledTimers', () => {
        const body = appSrc();
        const restart = body.match(/function restartGame[\s\S]{0,400}/);
        const home = body.match(/function showHomeScreen[\s\S]{0,400}/);
        expect(restart[0]).toMatch(/clearScheduledTimers\(\)/);
        expect(home[0]).toMatch(/clearScheduledTimers\(\)/);
    });
});

// ============================================================
// BUG-03 (web UI) — FIXED: victory banner uses a tracked/cancellable timer
// ============================================================
describe('BUG-03 victory banner deferred via scheduleVictoryBanner — FIXED', () => {
    test('victory path schedules the banner through the shared helper', () => {
        const body = appSrc();
        expect(body).toMatch(/scheduleVictoryBanner\(200\)/);
        expect(body).not.toMatch(/setTimeout\(showVictoryBanner, 200\)/);
    });

    test('scheduleVictoryBanner and clearScheduledTimers exist', () => {
        const body = appSrc();
        expect(body).toMatch(/function scheduleVictoryBanner[\s\S]*clearTimeout\(victoryTimer\)/);
        expect(body).toMatch(/if \(victoryTimer\)\s*\{\s*clearTimeout\(victoryTimer\);/);
    });
});

// ============================================================
// BUG-04 (web UI) — FIXED: every victory path disables btn-roll
// ============================================================
describe('BUG-04 victory disables the roll button — FIXED', () => {
    test('victory branch sets btn-roll.disabled = true before banner scheduling', () => {
        const body = appSrc();
        const vic = body.slice(body.indexOf('if (winnerIdx !== null)'), body.indexOf('function showVictoryBanner'));
        // the unconditional victory path must disable the roll button
        expect(vic).toMatch(/btn-roll[\s\S]{0,40}disabled = true[\s\S]{0,60}scheduleVictoryBanner\(200\)/);
    });
});

// ============================================================
// BUG-05 (web UI) — FIXED: dead roll button disabled during no-valid wait
// ============================================================
describe('BUG-05 no-valid-moves roll leaves — FIXED', () => {
    test('non-extra no-valid branch disables btn-roll before the auto-advance', () => {
        const body = appSrc();
        const fn = body.slice(body.indexOf('function handleRoll'), body.indexOf('function renderCowryShells')).slice(0, 3000);
        // the non-extra no-valid path must disable the button and use the tracked timer
        expect(fn).toMatch(/btn-roll[\s\S]{0,120}disabled = true[\s\S]{0,120}scheduleTurnTimer\(1000\)/);
    });
});

// ============================================================
// BUG-06 (web UI binary revisit) — FIXED: advanceTurn keeps bot turns inert
// ============================================================
describe('BUG-06 bot turns keep btn-roll disabled (isBotTurn helper)', () => {
    test('advanceTurn does NOT unconditionally re-enable the roll button', () => {
        const body = appSrc();
        const adv = body.match(/function advanceTurn[\s\S]{0,600}/);
        expect(adv).toBeTruthy();
        expect(adv[0]).toMatch(/disabled = isBotTurn\(\)/);
        expect(adv[0]).not.toMatch(/disabled = false/);
    });

    test('extra-roll grant and extra-no-moves reset gate on isBotTurn()', () => {
        const body = appSrc();
        // extra-roll grant keeps bot turns inert
        expect(body).toMatch(/Extra roll![\s\S]{0,200}disabled = isBotTurn\(\)/);
        // bot re-rolls are scheduled, not via a re-enabled button (roll-helper
        // assignment lands just before the no_moves_reset telemetry log)
        expect(body).toMatch(/disabled = isBotTurn\(\)[\s\S]{0,300}roll.extra_no_moves_reset/);
    });
});

// ============================================================
// BUG-24 (server) — FIXED: boundary-safe containment
// ============================================================
describe('BUG-24 server.js boundary-safe guard — FIXED', () => {
    test('server.js shipped source rejects a sibling whose name starts with ROOT', () => {
        const srv = serverSrc();
        expect(srv).toMatch(/path\.relative\(ROOT, filePath\)/);
        expect(srv).not.toMatch(/filePath\.indexOf\(ROOT\) !== 0/);
    });
});