#!/usr/bin/env node
// Shared workspace test runner: run node --test against every
// dist/**/*.test.js of the INVOKING workspace (npm sets cwd to the package
// dir), portably across Node versions.
//
// Why not `node --test "dist/**/*.test.js"`? Native glob expansion in
// `node --test` arrived in Node 21 and we declare engines.node >= 20.19 —
// on 20.19 (the CI-pinned version) that form fails with "Could not find"
// even when test files exist.
// Why not `node --test dist/`? On Node >= 21 a directory positional is no
// longer recursively searched — observed on Node 24 resolving to a single
// bogus passing entry, i.e. a silently-green suite that ran nothing.
//
// Explicit find-then-run (the packages/cli/scripts/runTests.mjs pattern) is
// deterministic on every supported Node version. This shared copy keeps the
// consuming packages (common, cloud-core, device-node, goal-executor) from
// each duplicating the script. Semantics are STRICT: these packages have real
// tests, so finding zero test files is a build/packaging problem — exit 1,
// never a silent pass. (report-web keeps an equally strict package-local
// runner — packages/report-web/scripts/runTests.mjs — because its tsup+vite
// build emits no test files to dist/, so it runs src/**/*.test.ts(x) through
// the tsx loader instead.)

import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const pkgDir = process.cwd();
const distDir = resolve(pkgDir, 'dist');

function findTestFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      out.push(...findTestFiles(full));
    } else if (entry.endsWith('.test.js')) {
      out.push(full);
    }
  }
  return out;
}

let testFiles;
try {
  testFiles = findTestFiles(distDir);
} catch (e) {
  if (e.code === 'ENOENT') {
    console.error(
      `[run-node-tests] dist/ not found at ${distDir} — did you forget \`npm run build\`?`,
    );
    process.exit(1);
  }
  throw e;
}

if (testFiles.length === 0) {
  console.error(`[run-node-tests] No *.test.js files found under ${distDir}.`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...testFiles], {
  stdio: 'inherit',
  cwd: pkgDir,
});

// Surface spawn errors instead of dropping them as a bare exit 1.
if (result.error) {
  console.error(`[run-node-tests] Failed to spawn ${process.execPath}: ${result.error.message}`);
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
