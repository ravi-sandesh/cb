// ============================================================
// CHOKA BARAH – Web E2E smoke + Phase 3 UI acceptance (US-04/24/06)
// Covers app boot, start game, visible board, player color legend,
// turn/roll interaction. Kept deterministic (no fixed die outcome).
// ============================================================
'use strict';
const { test, expect } = require('@playwright/test');

test.describe('App boot & navigation', () => {
  test('home screen renders titles and config controls', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/Choka Barah/i);
    await expect(page.locator('#btn-start')).toBeVisible();
    await expect(page.locator('#home-screen h1')).toContainText('CHOKA BARAH');
    await expect(page.locator('#btn-grid-5')).toBeVisible();
    await expect(page.locator('#btn-mode-bot')).toBeVisible();
  });

  test('starting a game shows the board and a player color legend', async ({ page }) => {
    await page.goto('/');
    await page.click('#btn-start');
    await expect(page.locator('#game-screen')).toHaveClass(/active/);
    await expect(page.locator('#board-canvas')).toBeVisible();

    // US-04/US-24: player names/colors legend populated for default 2 players.
    const chips = page.locator('#player-strip .player-chip');
    await expect(chips).toHaveCount(2);
    await expect(page.locator('#player-strip .player-chip.active')).toHaveCount(1);

    // US-24: Roll button colored for the current player (inline background set).
    const rollBtn = page.locator('#btn-roll');
    await expect(rollBtn).toBeEnabled();
    const bg = await rollBtn.evaluate(el => el.style.backgroundColor);
    expect(bg).not.toBe('');
  });
});

test.describe('Gameplay interaction', () => {
  test('rolling cowries produces a score display', async ({ page }) => {
    await page.goto('/');
    await page.click('#btn-start');
    await page.click('#btn-roll');
    // The score line is populated with any deterministic outcome.
    await expect(page.locator('#roll-score-display')).not.toHaveText('');
  });

  test('rules modal opens and closes', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#rules-modal')).toHaveClass(/hidden/);
    await page.click('#btn-rules');
    await expect(page.locator('#rules-modal .modal-content')).toBeVisible();
    await page.click('#rules-modal .btn-primary');
    await expect(page.locator('#rules-modal')).toHaveClass(/hidden/);
  });

  test('board scales and fits viewport', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    await page.goto('/');
    await page.click('#btn-start');
    const canvas = page.locator('#board-canvas');
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    expect(box.width).toBeGreaterThan(0);
    expect(box.x).toBeGreaterThanOrEqual(0);
  });
});