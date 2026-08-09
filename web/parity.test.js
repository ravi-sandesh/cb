// ============================================================
// Parity corpus guard (JS side)
// ------------------------------------------------------------
// Re-derives every frozen entry in web/parity/parity-corpus.json
// from the LIVE web/game-engine.js module and asserts it still
// equals the committed corpus. Also asserts the engine copy used by
// the Kotlin test is byte-identical, so the two never drift.
//
// Regenerating the corpus (writes BOTH copies in one run):
//   node web/scripts/gen-parity-corpus.js
// ============================================================
const fs = require('fs');
const path = require('path');
const E = require('./game-engine.js');

const corpus = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'parity', 'parity-corpus.json'), 'utf8')
);

describe('engine parity corpus (web)', () => {
    test('JS and Kotlin corpus copies are byte-identical', () => {
        // Guard against drift: the generator writes BOTH copies in one run, but
        // this assertion fails CI loudly if the committed copies ever differ.
        const webCopy = fs.readFileSync(path.join(__dirname, 'parity', 'parity-corpus.json'), 'utf8');
        const kotlinCopy = fs.readFileSync(
            path.join(__dirname, '..', 'engine', 'src', 'test', 'resources', 'parity', 'parity-corpus.json'),
            'utf8'
        );
        expect(kotlinCopy).toBe(webCopy);
    });

    test('paths match the corpus', () => {
        for (const entry of corpus.paths) {
            expect(E.getPlayerPath(entry.gridSize, entry.playerIndex))
                .toEqual(entry.cells.map(c => [c[0], c[1]]));
        }
    });

    test('safe-cell maps match the corpus', () => {
        for (const gridSize of [5, 7]) {
            const cells = [];
            for (let r = 0; r < gridSize; r++) {
                for (let c = 0; c < gridSize; c++) {
                    if (E.isSafeCell(gridSize, r, c)) cells.push([r, c]);
                }
            }
            expect(cells).toEqual(corpus.safeCells[String(gridSize)]);
        }
    });

    test('cowry scoring matches the corpus', () => {
        for (const { size, shells, score, isExtraRoll } of corpus.cowryRolls) {
            const r = E.scoreCowryRoll(size, shells);
            expect(r.score).toBe(score);
            expect(r.isExtraRoll).toBe(isExtraRoll);
        }
    });

    test('valid-move calculation matches the corpus', () => {
        for (const s of corpus.validMoves) {
            const derived = E.calculateValidMoves(s.gridSize, s.pawns, s.player, s.hasCaptured, s.score)
                .map(m => ({
                    pawnIds: m.grpPawns.map(p => p.id),
                    targetPathIndex: m.targetPathIndex,
                    targetCoords: m.targetCoords,
                    isCapture: m.isCapture,
                    reachesHome: m.reachesHome,
                    isGattiGroup: m.isGattiGroup
                }));
            expect(derived).toEqual(s.expected);
        }
    });
});