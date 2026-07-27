#!/usr/bin/env node
// Run the Node test runner (through the tsx loader) against every
// src/**/*.test.ts and src/**/*.test.tsx, portably across Node 20.x.
//
// We can't rely on `tsx --test src/**/*.test.ts` because glob expansion is
// left to the shell / node's test runner (native glob support arrived in
// Node 21) and we declare engines.node >= 20.19.
//
// Semantics are STRICT, matching scripts/run-node-tests.mjs: this package has
// real tests now, so finding zero test files is a discovery/packaging fault —
// exit 1, never a silent pass. The runner stays package-local (rather than
// the shared dist-discovering scripts/run-node-tests.mjs) because report-web
// builds with tsup + vite, neither of which emits test files to dist/ — tests
// run from src/ through the tsx loader instead.

import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const pkgDir = resolve(here, '..');

function findTestFiles(dir) {
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
      out.push(...findTestFiles(full));
    } else if (entry.endsWith('.test.ts') || entry.endsWith('.test.tsx')) {
      out.push(full);
    }
  }
  return out;
}

const testFiles = findTestFiles(resolve(pkgDir, 'src'));

if (testFiles.length === 0) {
  console.error('[runTests] No src/**/*.test.ts(x) files found — this package has tests, so zero discovered files is a fault.');
  process.exit(1);
}

// `node --import tsx --test` is tsx's documented Node >= 20.6 invocation and
// is what `tsx --test` wraps; spawning process.execPath avoids per-OS binary
// resolution (tsx vs tsx.cmd).
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...testFiles], {
  stdio: 'inherit',
  cwd: pkgDir,
});

// Surface spawn errors instead of dropping them as a bare exit 1.
if (result.error) {
  console.error(`[runTests] Failed to spawn ${process.execPath}: ${result.error.message}`);
  process.exit(1);
}

// If the test runner was killed by a signal (e.g. SIGINT, SIGKILL, OOM),
// status is null and signal carries the name. Propagate the conventional
// 128 + signo exit code so CI logs surface the real cause.
if (result.signal) {
  // The constants module exposes named signals; fall back to "1" if missing.
  const signo = (await import('node:os')).constants.signals[result.signal] ?? 1;
  process.exit(128 + signo);
}

process.exit(result.status ?? 1);
