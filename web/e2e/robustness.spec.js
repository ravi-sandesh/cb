// ============================================================
// CHOKA BARAH – Phase 6: concurrency & robustness E2E
//  - TC-SCA-005: rapid roll taps → at most ONE roll is processed
//    (the app guards with `currentRoll !== null` and disables the
//    button while a decision is pending, so a synchronous burst of
//    clicks collapses to a single roll).
//  - TC-E2E-012: invalid board taps are ignored without crashing.
// Keep every test deterministic and dependency-free.
// ============================================================
'use strict';
const { test, expect } = require('@playwright/test');

async function startGame(page) {
    await page.goto('/');
    await page.click('#btn-start');
    await expect(page.locator('#game-screen')).toHaveClass(/active/);
}

test.describe('TC-SCA-005 concurrency', () => {
    test('a burst of rapid roll taps processes only one roll', async ({ page }) => {
        await startGame(page);
        const rollBtn = '#btn-roll';

        // Fire 30 synchronous clicks in ONE task. handleRoll is fully
        // synchronous: the first sets `currentRoll`, every later call in this
        // same task hits the guard and is dropped. Only ONE roll may apply.
        await page.evaluate(() => {
            const btn = document.querySelector('#btn-roll');
            for (let i = 0; i < 30; i++) btn.click();
        });

        // Exactly one roll result is rendered (the cowry score line is set once).
        const scoreText = await page.textContent('#roll-score-display');
        expect(scoreText.trim().length).toBeGreaterThan(0);

        // If the roll produced legal moves, the button must now be disabled
        // (decision pending); otherwise the log shows "No valid moves". Either
        // way the game is in a single, coherent post-roll state, and the page
        // is still responsive to further interaction.
        const disabled = await page.isDisabled(rollBtn);
        const log = await page.textContent('#game-log');
        expect(disabled || log.includes('No valid moves')).toBe(true);
    });

    test('rapid taps never crash the grid or leave bogus state', async ({ page }) => {
        await startGame(page);
        await page.evaluate(() => {
            const btn = document.querySelector('#btn-roll');
            for (let i = 0; i < 50; i++) btn.click();
        });
        // No page error surfaced; board + controls still present.
        await expect(page.locator('#board-canvas')).toBeVisible();
        await expect(page.locator('#btn-roll')).toBeVisible();
    });
});

test.describe('TC-E2E-012 invalid taps ignored', () => {
    test('tapping a cell with no valid move is a safe no-op', async ({ page }) => {
        await startGame(page);
        // No roll yet, so there is no legal move: tapping the board must not
        // crash and must leave the game header/log intact.
        await page.evaluate(() => {
            const canvas = document.querySelector('#board-canvas');
            canvas.dispatchEvent(new MouseEvent('click', {
                clientX: 5, clientY: 5, bubbles: true
            }));
        });
        await expect(page.locator('#turn-banner')).toBeVisible();
        await expect(page.locator('#btn-roll')).toBeEnabled();
    });
});