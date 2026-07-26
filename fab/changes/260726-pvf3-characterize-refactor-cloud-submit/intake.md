# Intake: Characterize and Refactor `cloud-core` — First Tests for a Zero-Coverage Package

**Change**: 260726-pvf3-characterize-refactor-cloud-submit
**Created**: 2026-07-26

## Origin

Sixth change in the code-quality initiative, following PR #151 (CI gate + lint rules), #152
(lockfile + `npm ci`), #153 (dead code + nesting), #154 (split the two largest functions), and #155
(fix the `runTests` cleanup leaks).

> User direction: "merged, rebased and start next".

Remaining after #155: **133 warnings** (84 `max-lines-per-function` + 49 `complexity`). The three
largest remaining offenders are all **untested**, which is exactly why previous changes excluded
them — restructuring code with no tests is unsafe. This change takes the first of them.

**Why `cloud-core/submit.ts` first**, chosen from the three by measurement rather than preference:

| Candidate | File size | Oversized fns | Package coverage |
|-----------|-----------|---------------|------------------|
| **`cloud-core/src/submit.ts`** | 304 lines | **1** (`submitRun:70`) | **0 tests** (4 src files) |
| `cli/src/sessionRunner.ts` | 847 lines | 2 (`:138`, `:286`) | cli has 117 tests |
| `cli/src/reportWriter.ts` | 945 lines | **6+** | no direct tests |

It is the smallest and most self-contained, and it is the only one where characterization tests also
**close a zero-coverage package** — which in turn lets `cloud-core` graduate from the *tolerant* test
runner to the *strict* shared one. That collapses two separate queue items (test backfill + refactor)
into one contained change.

## Why

**Problem.** `cloud-core` has **zero tests** across its 4 source files, yet it performs the
highest-consequence operation in the product: uploading a user's app binary and test specs to the
cloud and creating a billable run. `submitRun` (175 lines, complexity over the 12 ceiling) does app
resolution, config/env reading, spec zipping, multipart upload, HTTP submission, and temp-file
cleanup in one function — entirely unverified.

**Consequence if not fixed.** Two compounding risks. First, a regression here fails at the worst
moment — mid-submission, after a user has waited through device prep, possibly leaving temp files or
a half-created run. Second, the package is *structurally* protected from improvement: it cannot be
refactored safely without tests, so its warnings are permanently stuck. It is also the package where
`upload.ts` (89 lines, complexity 5 at last measure) will need the same treatment later.

**Why characterization tests specifically.** The goal is not to specify what `submitRun` *should*
do — it is to **pin what it currently does** so the refactor provably preserves it. This is the
inverse of the previous change: there, the new tests had to **fail** before the fix (they proved a
bug); here they must **pass before and after** (they prove equivalence). That distinction must be
verified explicitly, not assumed.

## What Changes

### 1. Characterization tests for `submitRun` (new `packages/cloud-core/src/submit.test.ts`)

**The testability challenge, and the constraint it imposes.** Unlike `packages/cli/src/testRunner.ts`
— which exposes a `testRunnerDependencies` object tests override — `cloud-core` has **no
dependency-injection seam**. `submitRun`'s side effects are reached directly:

| Line | Seam | Test approach |
|------|------|---------------|
| `:221` | `fetch(url, …)` (global) | Stub `globalThis.fetch`, restore in `finally` |
| `:110`, `:130` | `fs.existsSync` on config/env paths | Real temp workspace with real files |
| `:141-174` | `new AdmZip()`, `zip.writeZip`, `fs.readFileSync` | Real temp dirs — let it genuinely zip |
| `:204` | `openAsBlob(uploadPath)` | Real temp file |
| `:83` | `prepareAppForUpload(input.appPath)` | Real temp `.app` dir / file |
| `:285`, `:291` | `fs.unlinkSync` cleanup in `finally` | Assert temp files are gone afterwards |
| `:59` | `process.env['FINALRUN_SUBMIT_TIMEOUT_MS']` | Set/restore around the test |

**Prefer real filesystem behavior over mocks** — temp workspaces via `fs.mkdtempSync`, as the `cli`
tests already do. Stub only `globalThis.fetch`, the one boundary that must not be crossed. Do **not**
introduce a DI seam into `submit.ts` to make testing easier: that is a design change, and the
constitution's Test Integrity principle forbids reshaping implementation to suit test infrastructure.

**Behaviors worth pinning** (not exhaustive — the implementer should read the function and cover what
matters):

- Both app modes: `--app` supplied (`prepareAppForUpload` path) and omitted (`server-default`).
- The multipart request actually sent: URL, method, headers, and which form fields are present.
- **Secrets are NOT forwarded** — `SubmitRunInput.variables` is documented as non-secret-only. This
  is a security-relevant contract and MUST be pinned.
- Config and env file presence/absence branches (`:110`, `:130`).
- Spec zipping: the `filesToZip` set for tests-only vs tests + suite.
- Error paths: non-OK HTTP response, `fetch` rejecting, and the invalid-timeout throw at `:59-65`.
- **Cleanup**: the `finally` removes the spec zip and any prepared app zip on both success and
  failure paths.

### 2. Refactor `submitRun` (`packages/cloud-core/src/submit.ts:70`)

Only **after** the characterization tests are green against the unmodified function. Extract phases
into module-private helpers — app resolution, config/env collection, spec zipping, request building,
response handling — leaving `submitRun` as a thin orchestrator.

Follow the conventions established in PR #154 and recorded in
`docs/memory/ci/pr-quality-gate.md` § Design Decisions:
- Accumulating state on a **per-call local context object**, never new module-level or instance state.
- Every extracted helper itself **≤60 lines and complexity ≤12** — otherwise warnings relocate rather
  than clear.
- The `try`/`finally` cleanup boundary must keep its current scope. Per the DD added in #155
  (`finally` scope follows the acquisition): the temp files are acquired before the request, so their
  cleanup `finally` must continue to enclose everything after acquisition. **Do not repeat the
  #155 bug** by extracting a helper that acquires a resource whose release stays outside it.

### 3. Swap `cloud-core` from the tolerant runner to the strict shared runner

Once real tests exist, the tolerant runner is wrong for this package — "zero test files" should again
be a hard error.

- `packages/cloud-core/package.json`: `"test": "node ./scripts/runTests.mjs"` →
  `"test": "node ../../scripts/run-node-tests.mjs"` (matching `common` and `device-node`).
- Delete `packages/cloud-core/scripts/runTests.mjs`.
- `packages/report-web` keeps its tolerant runner — it still has zero tests. This change graduates
  `cloud-core` only.

### 4. Required memory update

`docs/memory/ci/pr-quality-gate.md` § "Tests run through explicit-discovery runner scripts"
explicitly names `packages/cloud-core/scripts/runTests.mjs` as a tolerant runner and lists
`cloud-core` among the zero-test packages, including a scenario keyed on it. **This change makes
those statements false** — unlike the last three changes, a memory update here is *required*, not
merely to be verified. `cloud-core` moves to the strict list; `report-web` remains the sole tolerant
case.

### Out of scope

- `cli/src/sessionRunner.ts` and `cli/src/reportWriter.ts` — the other two untested giants, each its
  own change.
- `cloud-core/src/upload.ts`, `appBundle.ts`, `index.ts` — tests for those are welcome only if they
  fall out naturally; the target is `submit.ts`.
- Test backfill for `report-web` (25 src files, 0 tests) — separate change; it keeps its tolerant runner.
- Promoting lint rules from `warn` to `error`.
- Introducing a dependency-injection seam into `cloud-core`.
- Any behavior change to `submitRun`. The refactor is behavior-preserving; the tests exist to prove it.

## Affected Memory

- `ci/pr-quality-gate`: **(modify — required)** The "Tests run through explicit-discovery runner
  scripts" requirement must move `cloud-core` from the tolerant list to the strict list, drop the
  reference to its deleted `scripts/runTests.mjs`, and update the zero-test-package scenario (which
  currently uses `cloud-core` as its example) to `report-web`, now the only such package.

## Impact

- **Added**: `packages/cloud-core/src/submit.test.ts`.
- **Modified**: `packages/cloud-core/src/submit.ts`, `packages/cloud-core/package.json`,
  `docs/memory/ci/pr-quality-gate.md`.
- **Deleted**: `packages/cloud-core/scripts/runTests.mjs`.
- **Risk**: moderate. The refactor target is unverified *today*, which is the whole problem — but by
  the time it is restructured it will be covered by tests written specifically to pin it. The
  sharpest risk is **weak characterization tests**: tests that pass both before and after while not
  actually constraining the behavior that changed. Coverage of the request shape, the
  secrets-exclusion contract, and the cleanup paths is what makes them meaningful.
- **Expected outcome**: tests **350 → 350 + N** (N ≥ 6 or so); warnings **133 → 131** (clearing
  `submitRun`'s `max-lines-per-function` + `complexity`); 0 errors; `max-depth` and `no-unused-vars`
  still zero.

## Open Questions

- How many characterization tests are enough? (No fixed number — coverage of the behaviors listed in
  §1 is the bar, judged at review. See Assumptions #5.)
- Should `upload.ts` get tests in the same pass, since `cloud-core` will then be on the strict runner?
  (Assumed no — out of scope unless trivially free; see Assumptions #9.)

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Target `cloud-core/submit.ts` before `sessionRunner.ts` / `reportWriter.ts` | Smallest (304 lines, 1 oversized fn), self-contained, and the only one that also closes a zero-coverage package and enables the strict-runner swap | S:85 R:85 A:90 D:85 |
| 2 | Certain | Characterization tests are written and passing BEFORE any refactoring | The function is currently unverified; restructuring first would leave nothing to prove equivalence against | S:95 R:80 A:95 D:95 |
| 3 | Certain | These tests must PASS both before and after — unlike #155's regression tests, which had to FAIL first | They pin existing behavior rather than prove a bug; verify this explicitly rather than assuming | S:90 R:85 A:95 D:95 |
| 4 | Certain | Stub only `globalThis.fetch`; use real temp dirs for all filesystem behavior | The network is the one boundary that must not be crossed; real fs exercises the genuine zip/cleanup logic and matches existing `cli` test style | S:85 R:80 A:90 D:85 |
| 5 | Confident | No fixed test count; the bar is covering app modes, request shape, secrets exclusion, config/env branches, error paths, and cleanup | A number would invite gaming; the listed behaviors are what make the tests load-bearing for the refactor | S:70 R:80 A:85 D:75 |
| 6 | Certain | Do NOT add a DI seam to `cloud-core` to ease testing | Reshaping implementation to suit test infrastructure is prohibited by the constitution's Test Integrity principle; the fetch stub + temp dirs suffice | S:85 R:75 A:95 D:90 |
| 7 | Certain | Swap `cloud-core` to the strict runner and delete its tolerant script; `report-web` keeps its own | Once real tests exist, "zero test files" should be a hard error again; report-web still has none | S:90 R:85 A:95 D:95 |
| 8 | Certain | The memory update is REQUIRED, not merely to be verified | `pr-quality-gate.md` names cloud-core's tolerant runner and uses it as the zero-test scenario; this change falsifies both | S:90 R:85 A:95 D:95 |
| 9 | Confident | `upload.ts` / `appBundle.ts` tests only if they fall out naturally | Scope discipline; the strict runner requires ≥1 test file in the package, which `submit.test.ts` satisfies | S:70 R:85 A:85 D:80 |
| 10 | Certain | Follow #154's extraction conventions and #155's `finally`-scope rule during the refactor | Both are recorded Design Decisions; #155's rule exists precisely because a resource was acquired outside the block that released it | S:85 R:80 A:90 D:90 |

10 assumptions (8 certain, 2 confident, 0 tentative, 0 unresolved).
