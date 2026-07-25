#!/usr/bin/env node
// Run node --test against every dist/**/*.test.js, portably across Node 20.x.
//
// We can't rely on `node --test "dist/**/*.test.js"` because native glob
// expansion in `node --test` arrived in Node 21 and we declare
// engines.node >= 20.19.
//
// Modeled on packages/cli/scripts/runTests.mjs with one deliberate inversion:
// this package has ZERO test files today, so "no test files found" prints a
// notice and exits 0 instead of 1 — otherwise the CI gate
// (.github/workflows/ci.yml) would go red on every PR for a package that
// simply has nothing to run yet. A genuine test failure still propagates its
// real exit code. Guard: if test *sources* exist under src/ but no compiled
// tests are found under dist/, that's a build problem — exit 1, never 0.

import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const pkgDir = resolve(here, '..');

function findFiles(dir, suffix) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...findFiles(full, suffix));
    } else if (entry.endsWith(suffix)) {
      out.push(full);
    }
  }
  return out;
}

const testFiles = findFiles(resolve(pkgDir, 'dist'), '.test.js');

if (testFiles.length === 0) {
  const testSources = findFiles(resolve(pkgDir, 'src'), '.test.ts');
  if (testSources.length > 0) {
    console.error(
      `[runTests] Found ${testSources.length} test source(s) under src/ but no compiled dist/**/*.test.js — did you forget \`npm run build\`?`,
    );
    process.exit(1);
  }
  console.log('[runTests] No test files in this package yet — nothing to run.');
  process.exit(0);
}

const result = spawnSync(process.execPath, ['--test', ...testFiles], {
  stdio: 'inherit',
  cwd: pkgDir,
});

// Surface spawn errors instead of dropping them as a bare exit 1.
if (result.error) {
  console.error(`[runTests] Failed to spawn ${process.execPath}: ${result.error.message}`);
  process.exit(1);
}

// If node --test was killed by a signal (e.g. SIGINT, SIGKILL, OOM),
// status is null and signal carries the name. Propagate the conventional
// 128 + signo exit code so CI logs surface the real cause.
if (result.signal) {
  // The constants module exposes named signals; fall back to "1" if missing.
  const signo = (await import('node:os')).constants.signals[result.signal] ?? 1;
  process.exit(128 + signo);
}

process.exit(result.status ?? 1);
