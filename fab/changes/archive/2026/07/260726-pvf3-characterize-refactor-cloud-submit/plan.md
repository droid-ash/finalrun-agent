# Plan: Characterize and Refactor `cloud-core` — First Tests for a Zero-Coverage Package

**Change**: 260726-pvf3-characterize-refactor-cloud-submit
**Intake**: `intake.md`

## Requirements

### Testing: Characterization tests for `submitRun`

#### R1: Characterization tests pass against the unmodified implementation
A new `packages/cloud-core/src/test/submit.test.ts` SHALL pin `submitRun`'s current behavior and
MUST pass GREEN against the unmodified `submit.ts` before any refactoring begins. The tests
MUST stub `globalThis.fetch` as the only external-I/O stub (restored in `finally`) and use REAL temp workspaces. Narrow interception of a process-global *output* channel (`console.log`, restored in `finally`) is permitted where it is the only way to pin a user-visible string
(`fs.mkdtempSync`) for all filesystem behavior. No dependency-injection seam SHALL be added
to `submit.ts` (constitution Test Integrity principle).

- **GIVEN** the unmodified `submit.ts` at branch base
- **WHEN** the new characterization suite runs
- **THEN** every test passes, with no source change required

#### R2: The multipart request shape and secrets-exclusion contract are pinned
Tests MUST assert the request actually sent: URL (`{cloudUrl}/api/v1/execute`), method
(`POST`), `Authorization: Bearer {apiKey}` header, and the EXACT set of form fields present.
Tests MUST pin that only the documented non-secret `variables` map is forwarded (verbatim
JSON when non-empty, field absent when empty/undefined) and that the API key appears in no
form field value.

- **GIVEN** an input with `variables: { APP_ENV: 'staging' }` and an API key
- **WHEN** `submitRun` executes against a stubbed `fetch`
- **THEN** the captured `FormData` contains `variables` = `{"APP_ENV":"staging"}` as its only
  variable payload, the field set is exactly the expected enumeration, and no form value
  contains the API key
- **GIVEN** `variables` is `{}` or undefined
- **WHEN** `submitRun` executes
- **THEN** no `variables` field is present on the form

#### R3: Both app modes are pinned
Tests MUST cover `--app` supplied (the `prepareAppForUpload` path — both a pass-through
`.apk` file and a `.app` directory that is zipped to a temp file) and `--app` omitted
(`server-default`: no `appFile`/`appFilename` fields, `appFilename` undefined on the result).

- **GIVEN** `appPath` points at a real temp `.apk`
- **WHEN** `submitRun` executes
- **THEN** `appFile`/`appFilename` fields carry the file, the result's `appFilename` matches,
  and the original `.apk` is NOT deleted afterwards
- **GIVEN** no `appPath`
- **WHEN** `submitRun` executes
- **THEN** the form has no `appFile`/`appFilename` fields

#### R4: Config/env branches and spec-zip contents are pinned
Tests MUST inspect the uploaded `file` blob as a real zip and pin `filesToZip`: tests-only
vs tests + suite entries; `config.yaml` included only when present; only the RESOLVED env
file shipped (never sibling env files); the `.yml` fallback candidate.

- **GIVEN** a workspace with `.finalrun/config.yaml`, `.finalrun/env/dev.yaml`, and
  `.finalrun/env/prod.yaml`, submitted with `envName: 'dev'`
- **WHEN** the captured zip is opened
- **THEN** entries include the test spec, `config.yaml`, and `env/dev.yaml` — and NOT
  `env/prod.yaml`
- **GIVEN** a bare workspace with neither config nor env dir
- **WHEN** the captured zip is opened
- **THEN** it contains only the test spec entries

#### R5: Error paths are pinned
Tests MUST cover: non-201 HTTP response (throws `Cloud service returned {status}: {body}`),
`fetch` rejecting (the error propagates), a 201 body with `success: false` (throws
`Cloud submission failed: ...`), an unparseable 201 body (the JSON parse error propagates),
and the invalid `FINALRUN_SUBMIT_TIMEOUT_MS` module-load throw (via a fresh module instance
imported with the env var set, since the constant is evaluated at import time).

- **GIVEN** the stubbed `fetch` returns HTTP 400 with body text
- **WHEN** `submitRun` is awaited
- **THEN** it rejects with an error naming the status and body
- **GIVEN** `FINALRUN_SUBMIT_TIMEOUT_MS=not-a-number`
- **WHEN** a fresh instance of the module is imported
- **THEN** the import rejects with the invalid-timeout error

#### R6: `finally` cleanup is pinned on success and failure
Tests MUST assert that the spec zip (`finalrun-cloud-*.zip`) and any prepared app temp zip
(`finalrun-app-*.zip`) are removed from `os.tmpdir()` after `submitRun` returns — on BOTH the
success path and a failure path — and that a non-temp app source (plain `.apk`) is never
deleted.

- **GIVEN** a `.app` directory input (which acquires a temp app zip) and a rejecting `fetch`
- **WHEN** `submitRun` rejects
- **THEN** no new `finalrun-cloud-*.zip` / `finalrun-app-*.zip` remains in the temp dir

### Refactor: `submitRun` phase extraction

#### R7: `submitRun` becomes a thin orchestrator with zero behavior change
Only after R1–R6 are green, `submitRun` (175 lines, complexity >12) SHALL be split into
module-private phase helpers — app resolution, config/env collection, spec zipping, request
building, response handling, success reporting — leaving `submitRun` a thin orchestrator.
Per the recorded DDs (`docs/memory/ci/pr-quality-gate.md`): accumulating state lives on a
per-call LOCAL context object (never module-level state); every extracted helper is itself
≤60 lines and complexity ≤12; the cleanup `finally` keeps its current scope — temp files are
acquired before the request, so the `try` continues to open immediately after acquisition and
enclose everything after it (the #155 rule; no helper may acquire a resource whose release
stays outside it). The characterization tests MUST pass unchanged.

- **GIVEN** the refactored `submit.ts`
- **WHEN** the characterization suite from R1–R6 runs without modification
- **THEN** every test still passes, and `npm run lint` no longer reports
  `max-lines-per-function`/`complexity` warnings for `submitRun` or any extracted helper

### Runner: strict-runner graduation

#### R8: `cloud-core` moves to the shared strict runner
`packages/cloud-core/package.json` `test` script SHALL become
`node ../../scripts/run-node-tests.mjs` (matching `common`/`device-node`), and
`packages/cloud-core/scripts/runTests.mjs` SHALL be deleted. `packages/report-web` keeps its
tolerant runner.

- **GIVEN** the swapped runner and a built package
- **WHEN** `npm run test:workspaces` runs
- **THEN** cloud-core reports a real test count (no "no tests yet" notice), and zero
  discovered test files would exit 1

### Memory: required update

#### R9: `ci/pr-quality-gate` reflects the graduation
`docs/memory/ci/pr-quality-gate.md` § "Tests run through explicit-discovery runner scripts"
SHALL move `cloud-core` to the strict list, drop the reference to the deleted
`packages/cloud-core/scripts/runTests.mjs`, and rewrite the zero-test scenario around
`report-web` (the only remaining tolerant case), in FKF present-truth style (no transition
narration). `fab memory-index` SHALL be run and `fab memory-index --check` MUST exit 0.

- **GIVEN** the updated memory file
- **WHEN** `fab memory-index --check` runs
- **THEN** it exits 0 and the section names `report-web` as the sole tolerant runner

#### R10: Verification gates
`npm run build --workspaces --if-present` MUST exit 0; `npm run test:workspaces` MUST exit 0
with total tests above the 350 baseline and a real cloud-core count; `npm run lint` MUST exit
0 with 131 warnings (133 − 2 for `submitRun`) and 0 errors, `max-depth` and `no-unused-vars`
still zero. The new test file itself MUST introduce no new lint warnings.

- **GIVEN** the completed change
- **WHEN** the three verification commands run
- **THEN** exit codes are 0/0/0 with the counts above

### Non-Goals

- `cli/src/sessionRunner.ts`, `cli/src/reportWriter.ts` — separate changes
- Tests for `upload.ts` / `appBundle.ts` beyond what falls out naturally
- `report-web` test backfill or runner change
- Promoting lint rules from `warn` to `error`
- Any DI seam in `cloud-core`; any behavior change to `submitRun`

### Design Decisions

#### Temp-artifact cleanup pinned by tmpdir snapshot diff
**Decision**: Cleanup assertions snapshot `os.tmpdir()` entries matching
`finalrun-(cloud|app)-*.zip` before each run and assert the set is unchanged afterwards,
rather than trying to learn the internal temp paths.
**Why**: `submitRun` never exposes its temp paths; the name prefixes are stable and
`node:test` runs tests in a file sequentially, so the diff is race-free and pins exactly the
`finally` contract (both artifacts removed on success and failure).
**Rejected**: Exposing the temp paths from `submit.ts` for tests — that is the prohibited
reshaping of implementation for test infrastructure.
*Introduced by*: 260726-pvf3-characterize-refactor-cloud-submit

#### Invalid-timeout throw tested via require-cache fresh module reload
**Decision**: The `FINALRUN_SUBMIT_TIMEOUT_MS` validation throw is exercised by deleting the
module's require-cache entry and re-`require`ing it with the env var set, asserting the load
throws (and that a valid override is accepted).
**Why**: The constant is evaluated at module load (`const SUBMIT_TIMEOUT_MS = parse...` at
top level), so a normal call can never reach the throw once the module is cached. The package
compiles to CommonJS (no `"type": "module"`), so a query-suffixed dynamic import resolves to
the already-cached CJS module and never re-evaluates — the require cache is the only
in-process fresh-instance seam, verified empirically during Step A.
**Rejected**: (a) exporting `parseSubmitTimeoutMs` for tests — reshapes implementation for
test infrastructure; (b) a query-suffixed ESM import — tried first, does not bust the CJS
cache; (c) a child-process probe — slower and format-coupled via `__dirname` anyway.
*Introduced by*: 260726-pvf3-characterize-refactor-cloud-submit

## Tasks

### Phase 1: Setup

- [x] T001 Record the pre-change baseline: `npm run build --workspaces --if-present`,
  `npm run test:workspaces` (expect 350: 75 common, 91 device-node, 67 goal-executor,
  117 cli, 0 cloud-core), `npm run lint` (expect 133 warnings / 0 errors) <!-- R10 -->

### Phase 2: Characterization tests (against UNMODIFIED submit.ts)

- [x] T002 Create `packages/cloud-core/src/test/submit.test.ts` with shared harness helpers:
  fetch stub capture (restore in `finally`), temp workspace builder, spec-file builder,
  input builder, 201-success `Response` builder, tmpdir zip-artifact snapshot <!-- R1 -->
- [x] T003 Request-shape + secrets tests: URL/method/Authorization header, exact form-field
  set for server-default mode, `variables` forwarded verbatim when non-empty / absent when
  empty or undefined, API key in no form value, result `{runId, statusUrl, appFilename}` <!-- R2 -->
- [x] T004 App-mode tests: `.apk` pass-through (fields, result, source file NOT deleted),
  `.app` directory (zipped upload named `{basename}.zip`, temp app zip cleaned up),
  server-default (no app fields) <!-- R3 -->
- [x] T005 Config/env + spec-zip tests: open the captured `file` blob with AdmZip and pin
  entries for tests-only vs tests + suite; config present/absent; resolved env file only
  (sibling env excluded); `.yml` fallback; run name/type classification (single/multi/suite) <!-- R4 -->
- [x] T006 Error-path + cleanup tests: non-201 throw with status+body; fetch rejection
  propagates; `success:false` throw; unparseable 201 body rejects; invalid
  `FINALRUN_SUBMIT_TIMEOUT_MS` import throw (fresh module instance, env restored in
  `finally`); tmpdir snapshot unchanged on success AND failure paths <!-- R5, R6 -->
- [x] T007 Build and run the suite against the UNMODIFIED `submit.ts`; all tests GREEN
  pre-refactor (fix tests, never source, if any fail); confirm the new file adds zero lint
  warnings <!-- R1 -->

### Phase 3: Refactor (only after Phase 2 is green)

- [x] T008 Refactor `packages/cloud-core/src/submit.ts`: extract module-private helpers
  (app resolution, files-to-zip collection, spec zip write, form building, run name/type
  derivation, spinner message, request send, response parsing, success reporting) with a
  per-call local context object; keep the `try`/`finally` cleanup scope in `submitRun`
  exactly as acquired; each helper ≤60 lines / complexity ≤12 <!-- R7 -->
- [x] T009 Rebuild and re-run the characterization suite UNCHANGED (must pass); run
  `npm run lint` and confirm `submitRun`'s two warnings cleared with no new ones
  (133 → 131) <!-- R7, R10 -->

### Phase 4: Runner swap, memory, verification

- [x] T010 Swap `packages/cloud-core/package.json` `test` to
  `node ../../scripts/run-node-tests.mjs`; delete `packages/cloud-core/scripts/runTests.mjs`;
  confirm cloud-core reports a real test count via the strict runner <!-- R8 -->
- [x] T011 Update `docs/memory/ci/pr-quality-gate.md` § runner-scripts requirement: cloud-core
  to the strict list, drop the deleted script, rewrite the zero-test scenario around
  `report-web`; FKF present-truth style; run `fab memory-index` and confirm
  `fab memory-index --check` exits 0 <!-- R9 -->
- [x] T012 Final verification: build exit 0; `npm run test:workspaces` exit 0 with per-package
  counts (total > 350, cloud-core real count); `npm run lint` exit 0, 131 warnings, 0 errors,
  `max-depth`/`no-unused-vars` zero; tolerant script confirmed deleted <!-- R10 -->

## Execution Order

- T001 → T002–T006 → T007 (green gate) → T008 → T009 → T010 → T011 → T012
- T003–T006 build on T002's harness; they may be authored together but T007 gates Phase 3

## Acceptance

### Functional Completeness

- [x] A-001 R1: `packages/cloud-core/src/test/submit.test.ts` exists, stubs only `globalThis.fetch`
  (restored in `finally`), uses real `fs.mkdtempSync` workspaces, and passed GREEN against the
  unmodified `submit.ts` before any refactor commit touched it
  *(review-verified: `submit.ts` reverted to `origin/main` with the test file kept → rebuild →
  14/14 pass, exit 0. Precise scope of that run: the suite was 14 tests when the baseline was
  taken. The 15th — the `console.log` server-default notice pin — was added later in the same PR,
  during the review response, so it was never itself run against the unmodified `submit.ts`. It is
  a characterization test over a string that predates the refactor and is byte-identical across it,
  so it would pass on both sides; that was reasoned, not measured, and is recorded as such rather
  than restated as a 15-test baseline that never ran.)*
- [x] A-002 R7: `submitRun` is a thin orchestrator over module-private phase helpers with a
  per-call local context object and an unchanged `try`/`finally` cleanup scope
- [x] A-003 R8: cloud-core's `test` script is `node ../../scripts/run-node-tests.mjs` and
  `packages/cloud-core/scripts/runTests.mjs` is deleted
- [x] A-004 R9: `docs/memory/ci/pr-quality-gate.md` lists cloud-core among strict-runner
  packages, no longer references its deleted script, and its zero-test scenario is keyed on
  `report-web`; `fab memory-index --check` exits 0

### Behavioral Correctness

- [x] A-005 R7: The characterization suite passes byte-for-byte unchanged after the refactor
  (zero behavior change to `submitRun`)
- [x] A-006 R2: The pinned form-field enumeration proves no secret material is forwarded —
  only the documented `variables` map, and the API key only in the Authorization header
  *(review-verified by mutation: appending `xDebugAuth: apiKey` fails both the enumeration
  assertion and the secret-scan loop)*

### Scenario Coverage

- [x] A-007 R3: Both app modes are exercised: `.apk` pass-through, `.app` directory temp zip,
  and server-default (no app fields, `appFilename` undefined)
- [x] A-008 R4: Zip-content assertions cover tests-only, tests + suite, config present/absent,
  resolved-env-only (sibling excluded), and `.yml` fallback
  *(review-verified by mutation: dropping `config.yaml` and shipping sibling env files each
  fail the zip-entry assertion)*

### Edge Cases & Error Handling

- [x] A-009 R5: Non-201 response, fetch rejection, `success:false` body, unparseable body, and
  invalid `FINALRUN_SUBMIT_TIMEOUT_MS` (module-load throw) are each pinned by a test
- [x] A-010 R6: Temp-artifact cleanup (spec zip + prepared app zip) is asserted on both a
  success path and a failure path; a non-temp `.apk` source is asserted NOT deleted
  *(review-verified by mutation: disabling the temp-app-zip unlink fails both the success and
  the failure cleanup test)*

### Code Quality

- [x] A-011 Pattern consistency: tests follow the existing `node:test` + `assert/strict` +
  `mkdtempSync` style of the cli package's tests; helpers are module-private per PR #154
  conventions
- [x] A-012 No unnecessary duplication: the shared strict runner is reused (not copied);
  test harness helpers are shared across tests within the file
- [x] A-013 God-function anti-pattern cleared: every function in `submit.ts` (orchestrator and
  helpers) is ≤60 lines and complexity ≤12; `npm run lint` reports 131 warnings / 0 errors
  with `max-depth` and `no-unused-vars` still zero

### Security

- [x] A-014 R2: A test asserts the API key value appears in no multipart form field and
  secrets beyond the documented non-secret `variables` map are not forwarded

## Notes

### Deferred to follow-up changes (raised in CodeRabbit review of PR #156)

**1. Temp app-zip cleanup window in `submitRun` — pre-existing, needs its own `fix:` change.**
`resolveAppMode` acquires a temp `.app.zip` (via `prepareAppForUpload`), but the `try` whose
`finally` deletes it opens two statements later, after `collectFilesToZip` and `writeSpecZip`. If
either throws, that zip leaks. Both CodeRabbit and the pipeline review flagged it, and both agreed
it is **pre-existing, not introduced here**: on `origin/main` the same acquisition sits at `:83`
while the cleanup `try` opens at `:151`. Closing it changes cleanup semantics on an error path,
which this change cannot do while claiming the refactor is behaviour-preserving.

This is the identical situation to PR #154 → #155: a latent leak found during a
zero-behaviour-change refactor, deferred, then fixed properly in its own change with a regression
test. Follow the same route. The fix: open the `try` immediately after `resolveAppMode` returns, so
every subsequent statement is inside cleanup coverage — and add a regression test for
"`writeSpecZip` throws after an app zip was prepared", which has no coverage today.

**2. `FINALRUN_SUBMIT_TIMEOUT_MS` message/parser mismatch.**
The guard is `!Number.isFinite(parsed) || parsed <= 0`, so `1.5` is **accepted**, yet the error text
promises "a positive integer (milliseconds)". `submit.test.ts` now pins the actual behaviour
(fractional accepted) with a comment marking it as characterization rather than endorsement, so the
mismatch is visible and cannot drift unnoticed. Reconciling the two — either rejecting non-integers
or rewording the message — is a behaviour/contract change and belongs in its own change.


### Partially closed at review: user-visible output strings

Review found that the refactor moved four user-visible strings into new helpers with no test
constraining them — all four could be corrupted with the suite still green. Review also confirmed by
byte-diff against `origin/main` that none of them actually changed, so this was a missing safety net
rather than a regression.

**Closed here:** the `console.log` notice in `resolveAppMode` ("No --app provided; server will use
the latest app uploaded for …") is now pinned by a dedicated test that stubs `console.log` and
restores it in a `finally`. Verified load-bearing by mutation: replacing the string with a sentinel
fails exactly one test; restoring it returns 15/15.

**Still open (deliberate):** the three spinner strings — `buildSpinnerMessage`'s two branches and
`reportSubmitSuccess`'s `succeed` text. Pinning them requires intercepting the dynamic
`await import('ora')` inside `submitRun`, which in this CJS-compiled package means either a module
seam or exporting internals purely for tests. Both are the implementation-reshaping the intake and
the constitution's Test Integrity principle rule out, so the gap is recorded rather than forced. A
future change that needs spinner coverage should introduce a deliberate, reviewed spinner seam
instead of bending the tests around the dynamic import.


- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)

## Deletion Candidates

- `packages/cloud-core/scripts/runTests.mjs` — already deleted by this change; the package's
  graduation to `scripts/run-node-tests.mjs` made the tolerant copy redundant
- `packages/report-web/scripts/runTests.mjs` — not redundant yet (report-web still has zero
  tests), but it is now the *sole* consumer of the tolerant-runner shape; the whole
  strict/tolerant split collapses to one runner the moment report-web is backfilled
- Nothing else — the refactor is a pure extraction; every new helper in `submit.ts` has exactly
  one call site and no prior implementation of the same logic was left behind

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Pin cleanup via tmpdir snapshot diff on the stable `finalrun-(cloud\|app)-*.zip` prefixes rather than exposing temp paths | The prefixes are hardcoded in `submit.ts`/`appBundle.ts`; `node:test` runs a file's tests sequentially so the diff is race-free; exposing paths would reshape implementation for tests (prohibited) | S:80 R:90 A:90 D:85 |
| 2 | Certain | Test the invalid-timeout throw via require-cache deletion + re-require (the package compiles to CJS) | `SUBMIT_TIMEOUT_MS` is a module-level const evaluated at load; the cached instance can never re-throw; the ESM query-suffix seam was tried first and does not bust the CJS cache, so the require cache is the verified in-process seam; no source change | S:85 R:90 A:90 D:85 |
| 3 | Certain | Inspect the uploaded spec zip by reading the captured `file` Blob into AdmZip | Pins the genuine zip contents (the intake's "let it genuinely zip") instead of mocking; AdmZip accepts a Buffer and is already a package dependency | S:85 R:90 A:95 D:90 |
| 4 | Confident | Keep the `try`/`finally` and its inline cleanup body in `submitRun` itself; helpers acquire-and-return immediately (zip write is the last statement before the `try`) | The #155 DD requires the releasing `try` to open immediately after acquisition; keeping release inline in the orchestrator preserves the exact current scope and avoids the rejected combined-cleanup-helper shape | S:80 R:75 A:85 D:80 |
| 5 | Confident | Type the context's spinner via `import type { Ora } from 'ora'` (type-only, erased at compile) | `submit.ts` already depends on `ora` at runtime via dynamic import (hoisted from the CLI workspace); a type-only import adds no runtime dependency; fallback is a minimal structural type if the build complains | S:70 R:85 A:80 D:70 |
| 6 | Certain | New test callbacks each stay ≤60 lines / complexity ≤12 so the lint count lands exactly at 131 | `npm run lint` covers `packages/*/src`, so the new test file is linted under the same rules; the 131 target permits zero new warnings | S:85 R:85 A:95 D:90 |

6 assumptions (4 certain, 2 confident, 0 tentative).
