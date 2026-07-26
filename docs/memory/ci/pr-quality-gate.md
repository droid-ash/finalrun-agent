---
type: memory
description: "PR CI gate runs `npm ci` (committed lockfile) → build → test → lint via .github/workflows/ci.yml; four code-quality principles are ESLint warnings; tests run through explicit-discovery runner scripts because the pinned Node 20.19 has no `node --test` glob expansion; oversized functions are pinned by characterization tests, then cleared by extracting phases behind a phase-outcome union with per-call local state and `finally` blocks scoped to each resource's acquisition."
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
`eslint.config.mjs` encodes the four code-quality principles (readability, DRY, YAGNI, function size/nesting) as **five** rules at `warn` severity on the TS/TSX source block (`**/*.{ts,tsx,mts,cts}`): `max-lines-per-function` (`{ max: 60, skipBlankLines: true, skipComments: true, IIFEs: true }`), `max-depth` (`4`), `complexity` (`12`), plus re-enabled `@typescript-eslint/no-unused-vars` (`^_`-prefix ignore) and `prefer-const`. `@typescript-eslint/no-explicit-any` stays `off`. Severity is `warn` (not `error`) so the gate lands without breaking the pre-existing oversized functions; violations are visible in `npm run lint` output.

`@typescript-eslint/no-unused-vars`, `max-depth`, and `prefer-const` are clear tree-wide and MUST stay clear — a new violation of any of the three is a regression introduced by the PR, not inherited debt. The remaining warnings are all `max-lines-per-function` and `complexity`, concentrated in the pre-existing oversized functions; those two rules are what still blocks promoting the set from `warn` to `error`.

### Requirement: Tests run through explicit-discovery runner scripts
Every workspace `test` script MUST discover test files by explicit recursive walk (never a `node --test`/`tsx --test` glob), because the pinned Node 20.19 does not expand globs and a directory positional (`node --test dist/`) silently resolves to one bogus passing entry on Node ≥21. Two runner shapes exist:

- **Strict** — `scripts/run-node-tests.mjs`, shared by `packages/common`, `packages/cloud-core`, `packages/device-node`, and `packages/goal-executor` (packages with real tests), invoked as `node ../../scripts/run-node-tests.mjs` (npm sets cwd to the workspace dir; it discovers `dist/**/*.test.js` under `process.cwd()`). Finding **zero** test files exits **1** — for these packages that is a build/packaging fault, never a silent pass. Missing `dist/` exits 1 with a build hint; signal deaths propagate as `128 + signo`.
- **Tolerant** — `packages/report-web/scripts/runTests.mjs`, for the one package with **zero** test files today. It exits **0** with a "no tests yet" notice when — and only when — no test files exist, and propagates the runner's real exit code once tests are present (no blanket `|| true`). `report-web` discovers `src/**/*.test.ts` and runs them via `node --import tsx --test`.

`packages/cli/scripts/runTests.mjs` is the original strict runner (zero files → exit 1) this pattern is modeled on.

### Requirement: Test files live in a `test/` directory beside the code they cover
A `*.test.ts` file MUST sit in a `test/` subdirectory of the directory holding its subject, at every level of the tree — `src/apiKey.ts` is covered by `src/test/apiKey.test.ts`, and `src/device/android/AndroidDevice.ts` by `src/device/android/test/AndroidDevice.test.ts`. Tests are never co-located as siblings of their subject.

This costs nothing at the tooling layer and requires no runner change: every runner discovers by **recursive** walk (see above), so a nested `test/` directory is found wherever it appears; the `include: ["src/**/*"]` in each package `tsconfig.json` compiles it, so `dist/` mirrors the layout; and ESLint's `packages/*/src` glob still covers it. The one real cost is import depth — a test is one level deeper than its subject, so it reaches it as `../subject.js` rather than `./subject.js`, and any `__dirname`-relative path inside a test needs the extra level too.

#### Scenario: a test is added for a nested module
- **GIVEN** a new source file at `src/infra/android/Foo.ts`
- **WHEN** a test is written for it
- **THEN** it is placed at `src/infra/android/test/Foo.test.ts` and imports its subject as `../Foo.js`, with no runner or config change required

#### Scenario: zero-test package under the pinned Node
- **GIVEN** `packages/report-web` has no `src/**/*.test.ts`
- **WHEN** its `test` script runs
- **THEN** it prints a "no tests yet" notice and exits 0, keeping the gate green
- **GIVEN** a failing test file exists under `src/`
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
**Decision**: One shared **strict** runner (`scripts/run-node-tests.mjs`, zero files → exit 1) for packages with real tests; a per-package **tolerant** runner (zero files → exit 0) for a package with no tests yet — today only `report-web`. A package graduates to the shared strict runner (and its tolerant script is deleted) as soon as it gains real tests, making "zero test files" a hard error again.
**Why**: The gate must be green *and honest* — green for a package that legitimately has no tests yet, red for a package whose real tests failed or failed to compile. A single policy cannot express both; the exit-code inversion is the distinguishing signal. One shared strict copy avoids duplicating the script into its consuming packages.
**Rejected**: (a) a blanket `|| true` — swallows genuine test failures too; (b) copying the strict runner into each consuming package — repeated duplication of a ~70-line script in a change that exists to enforce DRY.
*Introduced by*: 260724-gl51-ci-gate-lint-enforcement

### Phase helpers return a phase-outcome union; the loop stays in the orchestrator
**Decision**: Clearing a `max-lines-per-function`/`complexity` warning on a long function means extracting each phase into a named helper that returns a discriminated `PhaseOutcome` union — `proceed` carrying the phase's value, `continue`, or `return` carrying the final result — while the loop and every `continue`/`return` decision stay in the orchestrating function, which then reads as its phase sequence. `TestExecutor.executeGoal` (`_`-prefixed private methods) and `testRunner.runTests` (module-private functions) are the worked examples.
**Why**: All control flow stays visible at one level, so the reader never has to open a helper to learn whether it can end the run, and the union narrows in TypeScript without casts. The split only counts when every extracted helper itself lands under the ceilings (≤60 lines, complexity ≤12) — a coarse split relocates warnings instead of clearing them, and can raise the total.
**Rejected**: (a) sentinel exceptions thrown from phase helpers — hides loop control and collides with the genuine error paths those functions already catch (a planner error is a caught condition, not control flow); (b) boolean out-parameters or flags — each one re-adds a branch to the caller, moving complexity rather than reducing it.
*Introduced by*: 260726-vzi3-split-testexecutor-runtests

### Accumulating state lives on a per-call local context object, never on instance fields
**Decision**: State that accumulates across a split function's phases lives on a plain context object constructed as a local at the top of the call and passed to the helpers — `GoalRunState` (history, remember, consecutive transient capture failures) in `executeGoal`, `TestRunContext` (test results, failure flag, lazily created report writer, run dir, abort state, log sinks) in `runTests`. Fields that never change are `readonly`.
**Why**: The object's lifetime is identical to the locals it replaces, which is what makes the split behavior-preserving; mutation sites stay explicit and greppable through the `ctx.`/`run.` prefix.
**Rejected**: (a) promoting the locals to instance fields — changes their lifetime so state survives across calls on the same instance, a real behavior change that a passing test suite does not rule out; (b) threading the values as parameter/return tuples through every helper — unreadable past about three pieces of state, and every added phase perturbs every signature.
*Introduced by*: 260726-vzi3-split-testexecutor-runtests

### `finally` scope follows the acquisition, not the phase split
**Decision**: A resource is released by a `finally` whose `try` opens immediately after the acquisition, and any guard that can throw between acquisition and use sits *inside* that `try`, never above it. The rule binds **every** acquisition in a function independently, not only the most recent: N resources means N `try`/`finally` scopes nested in acquisition order. A single `finally` placed at the latest acquisition cannot release the earlier ones — it is reachable only from its own `try`, so every throw between an earlier acquisition and that `try` orphans what the earlier one took. Registrations on process-global state — `Logger` sinks, signal listeners — are torn down in the function's outermost `finally`. `testRunner.runTests` and `submitRun` (`packages/cloud-core/src/submit.ts`) are the worked examples: `runTests` releases the device session in an inner `finally` that the post-preparation abort check sits inside, while sink removal and SIGINT-listener removal sit in the outer `finally` covering every exit path; `submitRun` opens its outer `try` right after `resolveAppMode` for the temp `.app.zip` and its inner `try` right after `writeSpecZip` for the spec zip, which also makes release order structural — innermost first — instead of a property of statement order (260726-rpx7-fix-submit-appzip-cleanup-leak).
**Why**: A guard above the releasing `try` strands whatever was already acquired — for `runTests`, a prepared device session, meaning emulator/simulator state, driver processes and ports, on the SIGINT-during-preparation path users actually hit. A leaked global registration is worse than a per-call leak because it accumulates across calls in one process: a sink left on the module-level `Logger` by an early exit keeps receiving every later run's entries, including across tests in a single suite run. The multi-acquisition case is stated per-acquisition because it is the variant that reads as correct: a lone `finally` enumerating every release names all the right resources, so a reader checks *what* it releases and never *from where it is reachable*. Neither leak is visible to a green suite, so a phase split MUST come with explicit error- and abort-path tests — happy-path coverage alone lets a stranded resource survive a full-file restructuring unnoticed.
**Rejected**: (a) a single `finally` covering several acquisitions — whether it inlines the releases or delegates to one combined cleanup helper — every resource then shares that one scope's reachability, so anything acquired before the scope opens goes unreleased on every exit that precedes it; (b) repeating the release in a `catch`-and-rethrow at each guard — restates cleanup at every throw site and drifts as throw sites are added.
*Introduced by*: 260726-gohy-fix-runtests-session-cleanup-leak

### Characterization tests pin an untested function before it is restructured
**Decision**: An untested oversized function is made safe to split by first writing tests that pass GREEN against the **unmodified** source, then refactoring and re-running them byte-for-byte unchanged. The "green before" claim is verified explicitly — restore the pre-refactor source with the new test file kept, rebuild, watch it pass — and the suite is then mutation-checked, corrupting one pinned behavior at a time so that each corruption fails exactly the test that pins it. `submitRun` (`packages/cloud-core/src/submit.ts`) is the worked example — `submit.test.ts` goes green against the pre-split function and survives its extraction into module-private phase helpers unmodified. This is the route for the remaining untested oversized functions: `cli/src/sessionRunner.ts`, `cli/src/reportWriter.ts`, and `uploadApp` in `packages/cloud-core/src/upload.ts`.
**Why**: This is the inverse sequence from a bug fix, whose regression test MUST fail before the fix and pass after. A characterization test that fails before the refactor is describing behavior that does not exist, and one that only passes afterwards has stopped pinning anything — so the before-run is the whole proof, not a formality. Because such a suite is green on both sides by construction, "still green after the refactor" is also exactly the signal a suite that constrains nothing produces; mutation is what separates the two, and it matters most on the contracts a reader cannot re-derive from the result — request shape, secrets exclusion, temp-file cleanup on both the success and failure paths.
**Rejected**: (a) refactoring first and writing tests against the result — they then pin whatever the refactor produced, including anything it silently dropped; (b) treating a passing test count as the coverage bar — a number invites padding with tests that assert nothing load-bearing.
*Introduced by*: 260726-pvf3-characterize-refactor-cloud-submit

### Characterize around the absent seam, and record what it cannot reach
**Decision**: A package with no dependency-injection seam is characterized by stubbing only the process globals it genuinely crosses — `globalThis.fetch`, `console.log`, each restored in a `finally` — and using real temp workspaces (`fs.mkdtempSync`) for every filesystem effect, so the actual zip, upload-blob and cleanup paths execute. No seam is added to make the code reachable. Behavior that stays unreachable under that constraint is recorded as an open gap rather than forced: in `cloud-core` the spinner strings behind `submitRun`'s dynamic `await import('ora')` are unpinned for exactly this reason, and so is temp-artifact uniqueness — `submit.ts` and `appBundle.ts` name their temp files `finalrun-cloud-${Date.now()}.zip` and `finalrun-app-${Date.now()}.zip`, millisecond resolution with no random component, so two submissions landing in the same millisecond share one path and either can unlink the other's in-flight upload. The test workspaces avoid that with `fs.mkdtempSync`; the tmpdir-diff technique keys on the stable prefix, never on per-run uniqueness.
**Why**: The constitution's Test Integrity principle forbids reshaping implementation to suit test infrastructure, and a seam introduced during a characterization pass additionally destroys the equivalence proof — the tests would be pinning a function that no longer has the shape they were written against. The rule is not "no seams": `packages/cli/src/testRunner.ts` carries a deliberate `testRunnerDependencies` object. It is that a seam is a design change, so it belongs to a change that argues for it, never to one whose claim is that nothing changed.
**Rejected**: (a) exporting internals — a timeout parser, the temp-artifact paths — so tests can reach them: the same reshaping in a thinner disguise. The module-load `FINALRUN_SUBMIT_TIMEOUT_MS` throw is reached instead by dropping the require-cache entry and re-requiring (the package compiles to CommonJS, so a query-suffixed dynamic import resolves to the cached module and never re-evaluates), and the temp artifacts by diffing `os.tmpdir()` on their stable `finalrun-(cloud|app)-*.zip` prefixes. (b) Leaving an unreachable behavior silently uncovered — an unrecorded gap reads as coverage.
*Introduced by*: 260726-pvf3-characterize-refactor-cloud-submit
