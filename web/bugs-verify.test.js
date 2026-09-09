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
// opponents MUST be capturable. Capture-one: exactly ONE pawn (lowest id)
// is sent home per landing.
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
        expect(m.isCapture).toBe(true);            // and it captures...
        const res = executeMove(5, pawns, cap, 0, m, { isExtraRoll: false });
        expect(res.capturedCount).toBe(1);         // ...exactly ONE pawn (capture-one)
        expect(res.pawns.find(p => p.id === 6).state).toBe('HOME_BASE'); // lowest id
        expect(res.pawns.find(p => p.id === 10).state).toBe('ON_TRACK'); // other stays
    });

    test('a TRUE opponent Gatti (same-player 2-stack, TOUGHENED) correctly blocks the same move', () => {
        const { pawns, cap } = mk(2);
        cap[0] = true; // gate open: inner targets legal
        // (3,3) is inner for P0 (idx 22) and for P1 (idx 18): a real Gatti cell.
        set(pawns, 0, 20);
        set(pawns, 6, 18);
        set(pawns, 7, 18); // same player -> real Gatti pair
        const moves = calculateValidMoves(5, pawns, 0, cap, 2, { 1: [18] });
        expect(moves.some(m => m.isCapture)).toBe(false); // block remains
        // Same pair UNTOUGHENED (tollu): capturable, capture-one.
        const open = calculateValidMoves(5, pawns, 0, cap, 2, {});
        const m = open.find(x => x.targetPathIndex === 22);
        expect(m).toBeDefined();
        expect(m.isCapture).toBe(true);
        const res = executeMove(5, pawns, cap, 0, m, { isExtraRoll: false }, {});
        expect(res.capturedCount).toBe(1);
    });
});

// ============================================================
// BUG-02 (FIXED): Gatti "formed" no longer re-reported for a moved Gatti
// DOC: §5.1 – gattiFormed fires ONLY when a tollu pair hardens on an exact
// 2 (toughening). Moving a pre-existing (tollu or toughened) pair is not
// a formation event.
// ============================================================
describe('BUG-02 spurious Gatti re-formation on group move — FIXED', () => {
    test('moving an existing inner tollu pair (no hardening) does NOT report gattiFormed', () => {
        const { pawns, cap } = mk(2);
        cap[0] = true; // gate open: inner targets legal
        set(pawns, 0, 17); set(pawns, 1, 17);        // pre-existing tollu pair
        const moves = calculateValidMoves(5, pawns, 0, cap, 4, {});
        const tolluMove = moves.find(m => m.isGattiGroup);
        expect(tolluMove.targetPathIndex).toBe(19);  // half rate
        const res = executeMove(5, pawns, cap, 0, tolluMove, { isExtraRoll: false }, {});
        expect(res.gattiFormed).toBe(false);         // FIXED: no new formation
        expect(res.toughened).toEqual({});           // still tollu
    });

    // EC-16 guard: a tollu pair hardening onto our own SINGLE pawn grows to
    // a toughened 3-stack — this MUST announce (the toughen transition).
    test('EC-16: a tollu pair hardening onto our own single pawn reports a 3-stack (grow)', () => {
        const { pawns, cap } = mk(2);
        cap[0] = true; // gate open: inner targets legal
        set(pawns, 0, 17); set(pawns, 1, 17);        // tollu pair at 17
        set(pawns, 2, 18);                           // our single pawn at 18 (own)
        const moves = calculateValidMoves(5, pawns, 0, cap, 2, {}); // pair 17 -> 18
        const tolluMove = moves.find(m => m.isGattiGroup);
        expect(tolluMove.targetPathIndex).toBe(18);
        expect(tolluMove.toughens).toBe(true);
        const res = executeMove(5, pawns, cap, 0, tolluMove, { isExtraRoll: false }, {});
        expect(res.gattiFormed).toBe(true);          // EC-16: 3 own pawns share cell
        expect(res.toughened).toEqual({ 0: [18] });
    });
});

// ============================================================
// BUG-03 (FIXED + RULE CHANGE): a CAPTURE landing onto my OWN pawn forms a
// tollu pair — NOT a Gatti. Only hardening on an exact 2 toughens it.
// DOC: §5.1 - Gatti = toughened pair; tollu pairs need a 2 to harden.
// ============================================================
describe('BUG-03 capture-onto-own-stack forms tollu, not Gatti — FIXED', () => {
    test('capture onto a cell already holding my own pawn yields gattiFormed=false (tollu)', () => {
        const { pawns, cap } = mk(2);
        set(pawns, 0, 4);                      // mover -> lands at idx 6
        const tgt = getPlayerPath(5, 0)[6];
        set(pawns, 1, 6);                      // my own pawn already on target cell
        set(pawns, 4, idxOf(getPlayerPath(5, 1), tgt)); // opponent on target too
        const moves = calculateValidMoves(5, pawns, 0, cap, 2, {});
        const m = moves.find(x => x.targetPathIndex === 6);
        expect(m.isCapture).toBe(true);         // capture path confirmed
        const res = executeMove(5, pawns, cap, 0, m, { isExtraRoll: false }, {});
        expect(res.capturedCount).toBe(1);      // capture-one
        expect(res.gattiFormed).toBe(false);    // FIXED: tollu, not toughened
        expect(res.toughened).toEqual({});      // needs an exact 2 to harden
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
        expect(mv.every(m => m.targetPathIndex === 12)).toBe(true); // score 12
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
        const fn = body.slice(body.indexOf('function handleRoll'), body.indexOf('function renderCowryShells')).slice(0, 6000);
        // the non-extra no-valid path must disable the button and use the tracked timer
        expect(fn).toMatch(/btn-roll[\s\S]{0,120}disabled = true[\s\S]{0,300}scheduleTurnTimer\(1000\)/);
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
        // extra-roll grant keeps bot turns inert (cleanup + gating precede the
        // button disable, so the window spans the whole extra-turn branch)
        expect(body).toMatch(/Extra roll![\s\S]{0,400}disabled = isBotTurn\(\)/);
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