// ============================================================
// CHOKA BARAH – Playwright config (Web E2E + Accessibility)
// Phase 5. Runs against the online server (online-server.js),
// which also serves the static app on the same port (3111).
// Only e2e/**/*.spec.js are picked up; Jest keeps *.test.js.
// ============================================================
'use strict';

const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.js',
  timeout: 30_000,
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }]]
    : [['list']],
  use: {
    baseURL: 'http://localhost:3111',
    headless: true,
    viewport: { width: 1280, height: 720 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  webServer: {
    command: 'node online/online-server.js',
    url: 'http://localhost:3111/index.html',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' }
    }
  ]
});