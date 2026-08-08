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
// BUG-01: "Opponent Gatti" false positive across DIFFERENT players
// DOC: EC-26 / §5.2 – a landing cell holding single pawns of two
// DIFFERENT opponents must be capturable (ALL are sent home).
// ACTUAL: engine treats any 2+ opponents as an un-capturable Gatti
//         and omits the move entirely.
// ============================================================
describe('BUG-01 opponent Gatti false positive (different players)', () => {
    test('single mover has NO move to a cell shared by two different opponents', () => {
        const { pawns, cap } = mk(4);
        set(pawns, 0, 2);
        const tgt = getPlayerPath(5, 0)[5];       // P0 target cell
        // Two opponents – from TWO DIFFERENT players – sit on that cell
        set(pawns, 6,  idxOf(getPlayerPath(5, 1), tgt));
        set(pawns, 10, idxOf(getPlayerPath(5, 2), tgt));
        const moves = calculateValidMoves(5, pawns, 0, cap, 3);
        const hasTarget = moves.some(m => m.targetCoords[0] === tgt[0] && m.targetCoords[1] === tgt[1]);
        // BUGGY actual: move is missing (correct rules behaviour: move offered, capture all)
        expect(hasTarget).toBe(false);
    });

    test('a TRUE opponent Gatti (same-player 2-stack) correctly blocks the same move', () => {
        const { pawns, cap } = mk(2);
        set(pawns, 0, 2);
        const tgt = getPlayerPath(5, 0)[5];
        set(pawns, 6, idxOf(getPlayerPath(5, 1), tgt));
        set(pawns, 7, idxOf(getPlayerPath(5, 1), tgt)); // same player -> real Gatti
        const moves = calculateValidMoves(5, pawns, 0, cap, 3);
        expect(moves.some(m => m.isCapture)).toBe(false); // block is correct here
    });
});

// ============================================================
// BUG-02 (Gatti "formed" re-reported each time an existing Gatti moves)
// DOC: §5.1 – Gatti formation is announced when 2+ pawns NEWLY join a
//       cell. Moving a pre-existing Gatti is not a formation.
// ACTUAL: executeMove recomputes from post-move state -> gattiFormed=true.
// ============================================================
describe('BUG-02 spurious Gatti re-formation on group move', () => {
    test('moving an existing 2-pawn Gatti reports gattiFormed=true', () => {
        const { pawns, cap } = mk(2);
        set(pawns, 0, 5); set(pawns, 1, 5);            // pre-existing Gatti
        const moves = calculateValidMoves(5, pawns, 0, cap, 2);
        const gattiMove = moves.find(m => m.isGattiGroup);
        const res = executeMove(5, pawns, cap, 0, gattiMove, { isExtraRoll: false });
        // BUGGY actual (documented): a moved Gatti must NOT be announced as new
        expect(res.gattiFormed).toBe(true);
    });
});

// ============================================================
// BUG-03 (Gatti flag suppressed when a CAPTURE also forms a 2-pawn stack)
// DOC: §5.1 - if two OWN pawns share any cell, a Gatti exists / is announced.
// ============================================================
describe('BUG-03 capture-onto-own-stack suppresses gattiFormed', () => {
    test('capture onto a cell already holding my own pawn yields gattiFormed=false', () => {
        const { pawns, cap } = mk(2);
        set(pawns, 0, 4);                      // mover -> lands at idx 6
        const tgt = getPlayerPath(5, 0)[6];
        set(pawns, 1, 6);                      // my own pawn already on target cell
        set(pawns, 4, idxOf(getPlayerPath(5, 1), tgt)); // opponent on target too
        const moves = calculateValidMoves(5, pawns, 0, cap, 2);
        const m = moves.find(x => x.targetPathIndex === 6);
        expect(m.isCapture).toBe(true);         // capture path confirmed
        const res = executeMove(5, pawns, cap, 0, m, { isExtraRoll: false });
        // BUGGY: 2 own pawns now share the cell, but flag is suppressed
        expect(res.gattiFormed).toBe(false);
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
// BUG-06 (web UI) Restart/new-game leaves #btn-roll permanently DISABLED
// ============================================================
describe('BUG-06 btn-roll never re-enabled by initGameState', () => {
    test('showVictoryBanner disables btn-roll, initGameState never re-enables it', () => {
        const body = appSrc();
        // victory path disables the roll button
        expect(body).toMatch(/showVictoryBanner[\s\S]*disabled = true/);
        // "disabled = true" appears only once (the victory banner) ...
        const disables = (body.match(/disabled = true/g) || []).length;
        expect(disables).toBeGreaterThanOrEqual(1);
        // ... and the game-init path (before any roll handler) never clears it.
        const beforeRoll = body.slice(0, body.indexOf('function handleRoll'));
        expect(beforeRoll).not.toMatch(/disabled = false/);
        // The only re-enable sites live inside handleRoll/executeMove/advanceTurn
        // (roll/turn flows), none of which run during reset.
        const reEnables = (body.match(/disabled = false/g) || []).length;
        expect(reEnables).toBe(3);
    });
});

// ============================================================
// BUG-07 (web UI): restartGame does not cancel a pending bot timer
// ============================================================
describe('BUG-07 restartGame leaks scheduled bot timer', () => {
    test('restartGame body does not clearTimeout(botTimer)', () => {
        const body = appSrc();
        const fn = body.match(/function restartGame[\s\S]{0,200}/);
        expect(fn).toBeTruthy();
        expect(fn[0].includes('clearTimeout')).toBe(false); // BUGGY: no cleanup
    });
});

// ============================================================
// BUG-10 (web UI): finished pawns render as a GATTI 'G' bundle on center
// ============================================================
describe('BUG-10 finished pawns rendered with GATTI highlight', () => {
    test('renderBoard draws FINISHED pawns into a cell map shared with ON_TRACK', () => {
        const body = appSrc();
        expect(body).toMatch(/pawn\.state === 'ON_TRACK' \|\| pawn\.state === 'FINISHED'/);
        // So 2 finished pawns at center draw the gold 'G' Gatti tag.
        expect(body).toMatch(/if \(isGattiCell\)[\s\S]*?\('G',/);
    });
});

// ============================================================
// BUG-24 (server): path guard uses naive string prefix, not a boundary
// ============================================================
describe('BUG-24 server.js prefix-match lets sibling dir pass', () => {
    test('server guard accepts a sibling whose name starts with ROOT', () => {
        const ROOT = path.resolve(__dirname);          // ...\web
        const SIB = path.join(path.dirname(ROOT), 'web2'); // sibling prefix dir
        const evil = path.resolve(ROOT, '.' + '/../web2/secret.txt');
        // Buggy guard: string.indexOf(ROOT) === 0 passes for sibling dir
        const passesGuard = String(evil).toLowerCase().indexOf(String(ROOT).toLowerCase()) === 0;
        expect(passesGuard).toBe(true);
        // Correct guard (boundary) would reject:
        const boundary = String(evil).toLowerCase().startsWith(String(ROOT).toLowerCase() + path.sep)
            || String(evil) === String(ROOT);
        expect(boundary).toBe(false);
    });
    test('server.js shipped source confirmed to use prefix comparison', () => {
        expect(serverSrc()).toMatch(/filePath\.indexOf\(ROOT\) !== 0/);
    });
});