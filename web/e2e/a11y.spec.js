// ============================================================
// CHOKA BARAH – Accessibility audit (Phase 5)
// Runs axe-core on the home + in-game screens and fails on any
// CRITICAL or SERIOUS violations. Full log printed for triage.
// ============================================================
'use strict';
const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;

test.describe('Accessibility (axe-core)', () => {
  test('home screen has no critical/serious violations', async ({ page }) => {
    await page.goto('/');
    const results = await new AxeBuilder({ page }).analyze();
    const serious = results.violations.filter(v => v.impact === 'critical' || v.impact === 'serious');
    if (serious.length) {
      console.log('Axe violations (home screen):', JSON.stringify(
        serious.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help })),
        null, 2
      ));
    }
    expect(results.violations.filter(v => v.impact === 'critical')).toEqual([]);
    expect(serious).toEqual([]);
  });

  test('in-game screen has no critical/serious violations', async ({ page }) => {
    await page.goto('/');
    await page.click('#btn-start');
    await page.waitForSelector('#board-canvas');
    const results = await new AxeBuilder({ page }).analyze();
    const serious = results.violations.filter(v => v.impact === 'critical' || v.impact === 'serious');
    if (serious.length) {
      console.log('A11 violations (in-game):', JSON.stringify(
        serious.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length })), null, 2
      ));
    }
    expect(results.violations.filter(v => v.impact === 'critical')).toEqual([]);
    expect(serious).toEqual([]);
  });
});