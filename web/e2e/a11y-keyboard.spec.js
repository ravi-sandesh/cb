// ============================================================
// CHOKA BARAH – Keyboard play + dialog a11y (E2E)
// Verifies the board is fully playable without a mouse: the canvas
// cursor responds to arrow keys, Enter executes the same move path
// as a tap, Escape closes the rules modal, and the game log is a
// live region for assistive tech.
// ============================================================
'use strict';
const { test, expect } = require('@playwright/test');

async function rollUntilMoves(page, attempts = 8) {
  // Roll with the KEYBOARD only. A dead roll auto-passes the turn; with two
  // human seats the other player simply rolls again until moves exist.
  for (let i = 0; i < attempts; i++) {
    await page.focus('#btn-roll');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    const log = await page.textContent('#game-log');
    if (/Select a pawn|select/i.test(log) && !(await noMovesLogged(page))) return true;
  }
  return false;
}

async function noMovesLogged(page) {
  const log = await page.textContent('#game-log');
  return /No valid moves/i.test((log || '').slice(-200));
}

test.describe('keyboard play', () => {
  test('board is focusable and advertised to assistive tech', async ({ page }) => {
    await page.goto('/');
    await page.click('#btn-start');
    const canvas = page.locator('#board-canvas');
    await expect(canvas).toBeVisible();
    expect(await canvas.getAttribute('tabindex')).toBe('0');
    expect(await canvas.getAttribute('aria-label')).toContain('arrow keys');
    // The game log must announce updates to screen readers.
    const log = page.locator('#game-log');
    expect(await log.getAttribute('role')).toBe('status');
    expect(await log.getAttribute('aria-live')).toBe('polite');
  });

  test('a full roll + move can be played with the keyboard alone', async ({ page }) => {
    await page.goto('/');
    await page.click('#btn-start');
    await page.waitForSelector('#board-canvas');

    expect(await rollUntilMoves(page)).toBe(true);

    // Sweep the cursor row-major across the grid until Enter lands on a
    // highlighted target — exactly what a keyboard-only player does.
    await page.focus('#board-canvas');
    const turnBefore = await page.textContent('#turn-text');
    let moved = false;
    for (let r = 0; r < 5 && !moved; r++) {
      for (let c = 0; c < 5 && !moved; c++) {
        await page.keyboard.press('Enter');
        await page.waitForTimeout(150);
        const turnNow = await page.textContent('#turn-text');
        if (turnNow !== turnBefore || /VICTORY/i.test(turnNow)) moved = true;
        if (!moved && c < 4) await page.keyboard.press('ArrowRight');
      }
      if (!moved) {
        for (let c = 0; c < 4; c++) await page.keyboard.press('ArrowLeft');
        await page.keyboard.press('ArrowDown');
      }
    }
    expect(moved).toBe(true);
  });
});

test.describe('rules modal accessibility', () => {
  test('Escape closes the modal and focus returns to the opener', async ({ page }) => {
    await page.goto('/');
    await page.click('#btn-rules');
    const modal = page.locator('#rules-modal');
    await expect(modal).toBeVisible();
    expect(await modal.getAttribute('role')).toBe('dialog');
    expect(await modal.getAttribute('aria-modal')).toBe('true');
    // Focus moved into the dialog.
    const insideDialog = await page.evaluate(() =>
      document.getElementById('rules-modal').contains(document.activeElement));
    expect(insideDialog).toBe(true);

    await page.keyboard.press('Escape');
    await expect(modal).toHaveClass(/hidden/);
    // Focus restored to the button that opened it.
    const focusedId = await page.evaluate(() => document.activeElement.id);
    expect(focusedId).toBe('btn-rules');
  });

  test('Tab cycles inside the open modal', async ({ page }) => {
    await page.goto('/');
    await page.click('#btn-rules');
    const modal = page.locator('#rules-modal');
    await expect(modal).toBeVisible();
    // Only one focusable (GOT IT! button): Tab must keep focus trapped on it.
    await page.keyboard.press('Tab');
    const focusedInModal = await page.evaluate(() =>
      document.getElementById('rules-modal').contains(document.activeElement));
    expect(focusedInModal).toBe(true);
    await page.click('#rules-modal .btn-primary');
    await expect(modal).toHaveClass(/hidden/);
  });
});
