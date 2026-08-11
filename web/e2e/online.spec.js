// ============================================================
// CHOKA BARAH – Online mode E2E (register → room → 2-tab match)
// Spins two browser contexts (host + guest), creates a room,
// joins with the 6-letter code, and verifies the server-
// authoritative board reaches both tabs in turn.
// Requires the online server (playwright webServer).
// ============================================================
'use strict';
const { test, expect } = require('@playwright/test');

const unique = (tag) => `${tag}_${(Date.now() % 100000000)}${Math.floor(Math.random() * 100000)}`.slice(0, 24);

async function openOnlinePanel(page) {
  await page.goto('/');
  await page.click('#btn-mode-online');
  await expect(page.locator('#online-card')).toBeVisible();
}

async function register(page, username, password) {
  await page.fill('#online-username', username);
  await page.fill('#online-password', password);
  await page.click('#btn-register');
  await expect(page.locator('#online-authed')).toBeVisible();
  await expect(page.locator('#online-status')).toContainText(/Registered/i);
}

test.describe('Online mode (two-tab match)', () => {
  test('host creates a room, guest joins, both receive the board in turn', async ({ browser }) => {
    const hostCtx = await browser.newContext();
    const guestCtx = await browser.newContext();
    const host = await hostCtx.newPage();
    const guest = await guestCtx.newPage();
    const hostUser = unique('host');
    const guestUser = unique('guest');
    const password = 's3cret-pass';

    // ---- Host: sign up + create a room ----
    await openOnlinePanel(host);
    await register(host, hostUser, password);
    await host.click('#btn-create-room');
    await expect(host.locator('#online-waiting')).toBeVisible();
    await expect(host.locator('#online-room-code-display')).toHaveText(/[A-Z2-9]{6}/);

    const roomCode = (await host.locator('#online-room-code-display').innerText()).trim();
    expect(roomCode).toMatch(/^[A-Z2-9]{6}$/);

    // Host stays on the lobby (only 1 member) — board not started yet.
    await expect(host.locator('#game-screen')).not.toHaveClass(/active/);

    // ---- Guest: sign up + join with the code ----
    await openOnlinePanel(guest);
    await register(guest, guestUser, password);
    await guest.fill('#online-room-code', roomCode);
    await guest.click('#btn-join-room');

    // Both tabs flip to the game screen once the second seat is taken.
    await expect(host.locator('#game-screen')).toHaveClass(/active/);
    await expect(guest.locator('#game-screen')).toHaveClass(/active/);
    await expect(host.locator('#board-title')).toContainText('ONLINE');
    await expect(guest.locator('#board-title')).toContainText('ONLINE');

    // Host (player 0) moves first; only their Roll button is live.
    await expect(host.locator('#btn-roll')).toBeEnabled();
    await expect(guest.locator('#btn-roll')).toBeDisabled();

    // Host rolls; the server broadcasts the result board to both tabs.
    await host.click('#btn-roll');
    await expect(host.locator('#roll-score-display')).not.toHaveText('');
    await expect(guest.locator('#roll-score-display')).not.toHaveText('');
    // Both tabs agree on whose turn it is, and the guest still cannot roll.
    const hostTurn = (await host.locator('#turn-text').innerText()).trim();
    expect(hostTurn).toMatch(/^TURN:/);
    await expect(host.locator('#turn-text')).toHaveText(await guest.locator('#turn-text').innerText());
    await expect(guest.locator('#btn-roll')).toBeDisabled();

    await hostCtx.close();
    await guestCtx.close();
  });
});
