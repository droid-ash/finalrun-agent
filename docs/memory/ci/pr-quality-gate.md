---
type: memory
description: "PR CI gate runs `npm ci` (committed lockfile) → build → test → lint via .github/workflows/ci.yml; four code-quality principles are ESLint warnings; tests run through explicit-discovery runner scripts because the pinned Node 20.19 has no `node --test` glob expansion."
---
# PR Quality Gate (ci)

**Domain**: ci

## Overview

The repo's pull-request quality gate is `.github/workflows/ci.yml`. It runs on `pull_request` targeting `main` (and on `push` to `main` as a post-merge safety net) and is the first automated gate the repo has. Its installs — and `release.yml`'s — are pinned to the committed root `package-lock.json`, so a run's outcome depends on what changed rather than on when it ran. The other non-obvious part is the test-runner contract: because CI pins Node 20.19 — the `engines.node >= 20.19.0` floor — and `node --test` gained glob expansion only in Node 21, tests cannot run via a glob and instead go through explicit file-discovery runner scripts.

## Requirements

### Requirement: PR CI gate stages
`.github/workflows/ci.yml` MUST run, in order, `npm ci` → `npm run build --workspaces --if-present` → `npm run test:workspaces` → `npm run lint`. The build MUST precede tests (package `test` scripts run against compiled `dist/` output). The **test step is the gate** — a failing test fails the run. The **lint step is non-blocking**: the code-quality rules are `warn`-severity, so eslint exits 0 on warnings-only output. The workflow declares a `concurrency` group keyed on `github.ref` with `cancel-in-progress: true`.

#### Scenario: PR with only lint warnings stays green
- **GIVEN** a PR whose code violates only the `warn`-severity code-quality rules
- **WHEN** the CI workflow runs
- **THEN** `npm run lint` exits 0 and the run passes; only a failing test fails the run

### Requirement: Committed lockfile — reproducible `npm ci` installs
`package-lock.json` is committed at the repo root (one lockfile covers every workspace; `lockfileVersion` 3, installable by the npm 10 bundled with the pinned Node 20.19). Both `.github/workflows/ci.yml` and `release.yml` MUST install with `npm ci` (never `npm install`, which re-resolves caret ranges afresh and makes red/green depend on registry state), and their setup-node steps MUST enable `cache: 'npm'` (keyed on the lockfile). Dependency changes MUST land the updated lockfile in the same commit — `npm ci` fails loudly when `package.json` and the lockfile disagree.

#### Scenario: upstream in-range release cannot break CI
- **GIVEN** an upstream dependency publishes a new version inside an existing caret range
- **WHEN** CI runs on an unchanged commit
- **THEN** `npm ci` installs the exact locked tree and the run's outcome is unchanged

### Requirement: Code-quality principles encoded as ESLint warnings
`eslint.config.mjs` encodes four code-quality principles at `warn` severity on the TS/TSX source block (`**/*.{ts,tsx,mts,cts}`): `max-lines-per-function` (`{ max: 60, skipBlankLines: true, skipComments: true, IIFEs: true }`), `max-depth` (`4`), `complexity` (`12`), plus re-enabled `@typescript-eslint/no-unused-vars` (`^_`-prefix ignore) and `prefer-const`. `@typescript-eslint/no-explicit-any` stays `off`. Severity is `warn` (not `error`) so the gate lands without breaking the pre-existing oversized functions; violations are visible in `npm run lint` output.

`@typescript-eslint/no-unused-vars`, `max-depth`, and `prefer-const` are clear tree-wide and MUST stay clear — a new violation of any of the three is a regression introduced by the PR, not inherited debt. The remaining warnings are all `max-lines-per-function` and `complexity`, concentrated in the pre-existing oversized functions; those two rules are what still blocks promoting the set from `warn` to `error`.

### Requirement: Tests run through explicit-discovery runner scripts
Every workspace `test` script MUST discover test files by explicit recursive walk (never a `node --test`/`tsx --test` glob), because the pinned Node 20.19 does not expand globs and a directory positional (`node --test dist/`) silently resolves to one bogus passing entry on Node ≥21. Two runner shapes exist:

- **Strict** — `scripts/run-node-tests.mjs`, shared by `packages/common`, `packages/device-node`, and `packages/goal-executor` (packages with real tests), invoked as `node ../../scripts/run-node-tests.mjs` (npm sets cwd to the workspace dir; it discovers `dist/**/*.test.js` under `process.cwd()`). Finding **zero** test files exits **1** — for these packages that is a build/packaging fault, never a silent pass. Missing `dist/` exits 1 with a build hint; signal deaths propagate as `128 + signo`.
- **Tolerant** — `packages/cloud-core/scripts/runTests.mjs` and `packages/report-web/scripts/runTests.mjs`, for packages with **zero** test files today. They exit **0** with a "no tests yet" notice when — and only when — no test files exist, and propagate the runner's real exit code once tests are present (no blanket `|| true`). `cloud-core` additionally exits 1 if test *sources* exist under `src/` but no compiled tests are found under `dist/` (an unbuilt tree must not masquerade as "no tests"). `report-web` discovers `src/**/*.test.ts` and runs them via `node --import tsx --test`.

`packages/cli/scripts/runTests.mjs` is the original strict runner (zero files → exit 1) this pattern is modeled on.

#### Scenario: zero-test package under the pinned Node
- **GIVEN** `packages/cloud-core` is built and has no `dist/**/*.test.js`
- **WHEN** its `test` script runs
- **THEN** it prints a "no tests yet" notice and exits 0, keeping the gate green
- **GIVEN** a failing compiled test exists under `dist/`
- **WHEN** the script runs
- **THEN** it propagates the runner's real non-zero exit code

## Design Decisions

### The lockfile freezes the resolution CI proved green
**Decision**: `package-lock.json` pins the dependency tree that was already verified green end-to-end (build, 348 tests, lint 0 errors) — including `@ai-sdk/anthropic` 3.0.101 — rather than a fresh re-resolution of the declared caret ranges.
**Why**: Re-resolving at lock time re-floats every caret range, which is the exact drift a lockfile exists to eliminate; freezing a known-green tree makes the lockfile a pure reproducibility guarantee with no behavioral delta to review. 3.0.101 is also the version whose `AnthropicLanguageModelOptions` shape forced the provider-options widening at the `generateText` boundary in `packages/goal-executor/src/ai/AIAgent.ts` — that widening is version-agnostic and still guards deliberate upgrades.
**Rejected**: (a) deleting the lockfile and re-resolving from the registry — discards a verified resolution and re-floats every range for no benefit; (b) pinning back to a pre-3.0.101 `@ai-sdk/anthropic` — changing a locked version *is* a dependency change, which belongs in its own reviewable commit, not in the commit that introduces the lock.
*Introduced by*: 260725-358i-lockfile-reproducible-installs

### `lockfileVersion` 3 is the npm-compatibility contract
**Decision**: The committed lockfile declares `lockfileVersion: 3`, and that field is verified on the generated file rather than the lockfile being regenerated under CI's npm.
**Why**: Lockfiles are generated locally on npm 11 (Node 24) but installed by the npm 10 bundled with the pinned Node 20.19 — the `engines.node >= 20.19.0` floor. npm 11 still emits `lockfileVersion` 3, the same format npm 10 reads and writes, so one file serves both; a lockfile demanding a newer npm would break the very gate it protects. The clean-tree `npm ci` proof and CI itself re-verify this on every dependency change.
**Rejected**: Regenerating under npm 10 defensively — unnecessary once the emitted version is checked, and it would re-resolve the tree the lockfile deliberately freezes.
*Introduced by*: 260725-358i-lockfile-reproducible-installs

### Lint rules land as warnings, not errors
**Decision**: The four code-quality rules land at `warn` severity, not `error`.
**Why**: A hard gate would break the pre-existing oversized/deeply-nested functions on day one. `warn` makes violations visible in CI output without failing the build, so the foundation lands non-breaking; promotion to `error` is a deliberate follow-up, gated on clearing the remaining `max-lines-per-function`/`complexity` offenders.
**Rejected**: `error` severity — would fail every PR against the existing offenders before any refactor could land.
*Introduced by*: 260724-gl51-ci-gate-lint-enforcement

### Explicit file-discovery runners over `node --test` globs
**Decision**: Tests run through explicit recursive file-discovery runner scripts, not `node --test`/`tsx --test` globs.
**Why**: CI pins Node 20.19 to keep validating the `engines.node >= 20.19.0` floor, and glob expansion in `node --test` arrived only in Node 21 — the glob form fails on 20.19 even when test files exist. Explicit discovery is the only form verified deterministic on both Node 20.19 (CI) and Node ≥21 (dev machines).
**Rejected**: (a) `node --test "dist/**/*.test.js"` — fails on 20.19 with "Could not find"; (b) `node --test dist/` — on Node ≥21 the directory positional resolves to a single bogus passing entry, a silently-green suite; (c) bumping CI to Node ≥21 — would stop validating the declared 20.19 floor.
*Introduced by*: 260724-gl51-ci-gate-lint-enforcement

### Separate strict and tolerant runners
**Decision**: One shared **strict** runner (`scripts/run-node-tests.mjs`, zero files → exit 1) for packages with real tests; per-package **tolerant** runners (zero files → exit 0) for the two packages that have no tests yet.
**Why**: The gate must be green *and honest* — green for a package that legitimately has no tests yet, red for a package whose real tests failed or failed to compile. A single policy cannot express both; the exit-code inversion is the distinguishing signal. One shared strict copy avoids duplicating the script into three packages.
**Rejected**: (a) a blanket `|| true` — swallows genuine test failures too; (b) copying the runner into each package — 3× duplication of a ~70-line script in a change that exists to enforce DRY.
*Introduced by*: 260724-gl51-ci-gate-lint-enforcement
