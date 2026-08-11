#!/usr/bin/env node
// ============================================================
// CHOKA BARAH – Diff-based coverage gate (CI / local)
// Enforces per-file BRANCH coverage >= threshold on the source
// files touched by the current changeset, not just the global
// rollup. This is the "changed code must stay covered" rule:
//
//   1. Find source files changed vs a base ref (git diff).
//   2. A changed `X.test.js` implies gating its module `X.js`.
//   3. Run the full Jest suite collecting coverage ONLY for the
//      gated files, then assert each meets the branch threshold.
//
// Base ref precedence:
//   CB_GATE_BASE env           (explicit override)
//   GITHUB_BASE_REF            (PR base, e.g. `main`)
//   CB_GATE_DEFAULT_BRANCH env (or origin/master / origin/main)
//   HEAD~1                     (fallback for local runs)
// Threshold: CB_GATE_BRANCH env (default 90) and CB_GATE_STMTS (default 90).
// ============================================================
'use strict';
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');          // web/
const REPO = path.resolve(__dirname, '..', '..');    // repo root
const BRANCH_MIN = Number(process.env.CB_GATE_BRANCH || 90);
const STMT_MIN = Number(process.env.CB_GATE_STMTS || 90);
const GATED_SOURCES = ['app.js', 'game-engine.js', 'server.js', 'sound.js', 'telemetry.js',
  'online/auth.js', 'online/game-server.js', 'online/online-db.js', 'online/online-server.js',
  'online/relay.js', 'online/ws.js'];

function sh(cmd) {
  return execSync(cmd, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function resolveBase() {
  if (process.env.CB_BASE) return process.env.CB_BASE;
  if (process.env.GITHUB_BASE_REF) {
    const ref = process.env.GITHUB_BASE_REF.trim();
    if (ref) return `origin/${ref}`;
  }
  const def = process.env.CB_GATE_DEFAULT_BRANCH || 'master';
  try { sh(`git rev-parse --verify ${def}`); return def; } catch (e) {}
  try { sh('git rev-parse --verify origin/master'); return 'origin/master'; } catch (e) {}
  try { sh('git rev-parse --verify origin/main'); return 'origin/main'; } catch (e) {}
  return 'HEAD~1';
}

function changedSourceFiles(base) {
  const out = sh(`git diff --name-only ${base} -- "web/*.js" "web/**/*.js"`);
  if (!out) return [];
  const gated = new Set();
  for (const raw of out.split(/\r?\n/)) {
    const rel = raw.replace(/\//g, path.sep);
    if (!rel.startsWith('web' + path.sep)) continue;          // only web sources
    const file = rel.slice('web' + path.sep.length);            // e.g. app.js
    if (file.includes(path.sep + 'node_modules') || file.startsWith('coverage' + path.sep)) continue;
    const baseName = path.basename(file);
    // A source is gated if its repo-relative name (web/online/auth.js ->
    // online/auth.js) OR its basename appears in GATED_SOURCES.
    const isGated = (name) => GATED_SOURCES.includes(name.replace(/\\/g, '/'));
    if (baseName.endsWith('.test.js')) {
      // A changed test gates its module-under-test.
      const mod = baseName.slice(0, -'.test.js'.length) + '.js';
      if (['app.js', 'game-engine.js', 'server.js', 'sound.js', 'telemetry.js'].includes(mod) ||
          isGated(`online/${mod}`)) gated.add(mod);
    } else if (GATED_SOURCES.includes(baseName) || isGated(file)) {
      gated.add(file);
    }
    // scripts/ and other non-unit modules (e.g. gen-parity-corpus.js) are out of scope.
  }
  return [...gated];
}

function runCoverage(files) {
  void files;
  // In CI the full-suite coverage run already happened (npm test); with
  // CB_GATE_REUSE=1 we consume that summary instead of re-running Jest.
  if (process.env.CB_GATE_REUSE === '1') {
    const sum = path.join(ROOT, 'coverage', 'coverage-summary.json');
    if (fs.existsSync(sum)) {
      console.log('[gate] reusing existing coverage/coverage-summary.json (CB_GATE_REUSE=1)');
      return;
    }
    console.warn('[gate] CB_GATE_REUSE=1 but coverage-summary.json missing; running Jest');
  }
  const cmd = `npx jest --coverage --coverageReporters=json-summary --coverageReporters=json`;
  try {
    execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const msg = (e.stdout || '').trim();
    console.log(msg || e.message);
    throw new Error('Jest run failed (see above)');
  }
}

function summarize(files) {
  const summary = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'coverage', 'coverage-summary.json'), 'utf8')
  );
  const rows = [];
  let failed = false;
  for (const file of files) {
    const entry = summary[file] || summary[summaryKeys(summary).find((k) => k.endsWith(file)) || ''];
    if (!entry) {
      rows.push({ file, branch: 0, stmt: 0, fail: true, missing: true });
      failed = true;
      continue;
    }
    const branch = entry.branches.pct;
    const stmt = entry.statements.pct;
    const fail = branch < BRANCH_MIN || stmt < STMT_MIN;
    rows.push({ file, branch, stmt, fail });
    if (fail) failed = true;
  }
  return { rows, failed };
}

function summaryKeys(summary) {
  return Object.keys(summary);
}

function main() {
  const base = resolveBase();
  const changed = changedSourceFiles(base);
  if (changed.length === 0) {
    console.log(`[gate] No gated web source/tests changed vs base '${base}' — PASS (no-op).`);
    return 0;
  }

  console.log(`[gate] Diff base: ${base}`);
  console.log(`[gate] Gated files (${changed.length}): ${changed.join(', ')}`);
  console.log(`[gate] Thresholds — branches >= ${BRANCH_MIN}%, statements >= ${STMT_MIN}%`);

  runCoverage(changed);
  const { rows, failed } = summarize(changed);

  console.log('\n  file                  branches   statements   status');
  for (const r of rows) {
    const miss = r.missing ? '  (no coverage entry)' : '';
    console.log(
      `  ${r.file.padEnd(22)} ${(r.branch || 0).toFixed(2).padStart(7)}%   ${(r.stmt || 0).toFixed(2).padStart(9)}%` +
        `   ${r.fail ? 'FAIL' : 'ok'}${miss}`
    );
  }

  if (failed) {
    console.error(
      `\n[gate] FAIL: one or more changed files did not meet per-file coverage ` +
        `(branches ${BRANCH_MIN}%, statements ${STMT_MIN}%).`
    );
    return 1;
  }
  console.log(`\n[gate] PASS: all changed files meet per-file coverage thresholds.`);
  return 0;
}

process.exit(main());