# Plan: Fix the Temp App-Zip Cleanup Leak in `submitRun`

**Change**: 260726-rpx7-fix-submit-appzip-cleanup-leak
**Intake**: `intake.md`

## Requirements

### cloud-core: Temp App-Zip Release on Pre-Upload Failure

#### R1: The temp `.app.zip` MUST be released on every exit path after its acquisition
`submitRun` MUST release the temp `.app.zip` that `resolveAppMode` → `prepareAppForUpload` may acquire (`isTempZip: true`, produced when `--app` points at a `.app` directory) on **every** exit path after the acquisition — including a throw from `collectFilesToZip` or `writeSpecZip` that occurs before the upload `try` is entered. Each acquisition gets its own `finally` whose `try` opens immediately after that acquisition (nested scopes, per the existing Design Decision "`finally` scope follows the acquisition, not the phase split" in `docs/memory/ci/pr-quality-gate.md`).

- **GIVEN** `input.appPath` is a `.app` directory (so a temp `finalrun-app-*.zip` is created with `isTempZip: true`)
- **WHEN** `writeSpecZip` throws because a spec `sourcePath` does not exist (`AdmZip.addLocalFile` throws on a nonexistent path)
- **THEN** `submitRun` rejects with that error
- **AND** no `finalrun-app-*.zip` survives in `os.tmpdir()`

#### R2: A regression test MUST exist and MUST fail against the unfixed code
`packages/cloud-core/src/test/submit.test.ts` MUST gain one test exercising a throw between app resolution and the cleanup `try`: real temp `.app` directory as `appPath`, a nonexistent `checked.tests[0].sourcePath`, asserting rejection AND a clean tmpdir snapshot (`/^finalrun-(cloud|app)-.*\.zip$/`). The test MUST be run against the unfixed source first and MUST FAIL there — the fail-then-pass ordering is the proof (inverse of #156's characterization tests).

- **GIVEN** the unfixed `submit.ts` (cleanup `try` opens after `writeSpecZip`)
- **WHEN** the new test runs
- **THEN** it FAILS (a `finalrun-app-*.zip` is orphaned in `os.tmpdir()`)
- **GIVEN** the fixed `submit.ts`
- **WHEN** the same test runs unmodified
- **THEN** it PASSES

#### R3: Existing error-path and cleanup semantics MUST NOT change
The fix MUST NOT alter: (a) error propagation — the `writeSpecZip`/`collectFilesToZip` error reaches the caller unchanged, never swallowed or replaced by cleanup; (b) cleanup-error swallowing — both `unlinkSync` calls keep their `try {} catch {}` wrappers; (c) unlink order — spec zip before app zip (nesting preserves this because the inner `finally` runs first — confirmed structurally, not assumed); (d) all 15 existing `submit.test.ts` tests pass byte-for-byte UNMODIFIED.

- **GIVEN** the fixed code and the pre-existing 15 tests
- **WHEN** the full suite runs
- **THEN** all 15 pass unmodified and total tests rise 365 → 366 (cloud-core 15 → 16)

#### R4: The misleading comment MUST be replaced with one that describes the real structure
The comment above the old `try` claims the `finally` "encloses everything after acquisition — its scope follows the acquisition, not the phase split", which is true of the spec zip and FALSE of the app zip. It MUST be replaced with a comment accurately describing the nested-scope structure (each `finally` paired with its own acquisition; inner runs first, preserving spec-zip-before-app-zip unlink order). No comment may assert an invariant the code breaks.

- **GIVEN** the fixed `submit.ts`
- **WHEN** a reader inspects the cleanup comment
- **THEN** every claim in it is true of the code as written

#### R5: Lint baseline MUST hold — no new `max-depth` (or any) violations
The added nesting MUST NOT breach `max-depth` (limit 4) or introduce any new lint warning/error. Expected: `npm run lint` exits 0 with 131 warnings / 0 errors, `max-depth` and `no-unused-vars` at ZERO, per-rule breakdown unchanged (83 `max-lines-per-function` + 48 `complexity`).

- **GIVEN** the fixed `submit.ts` with nested `try`/`finally`
- **WHEN** `npm run lint` runs
- **THEN** exit 0, 131 warnings / 0 errors, `max-depth` violations = 0

### Non-Goals

- The 131 pre-existing warnings; `upload.ts`; `sessionRunner.ts`; `reportWriter.ts` — out of scope
- The `FINALRUN_SUBMIT_TIMEOUT_MS` message/parser mismatch — deferred to its own change
- Promoting lint rules from `warn` to `error`
- Changes to `prepareAppForUpload` or to when a temp zip is created
- Reporting the leak to the user (silent cleanup matches the existing contract)

### Design Decisions

#### Nested `try`/`finally`, each opening immediately after its acquisition
**Decision**: The fix uses nested scopes — the outer `try` opens right after `resolveAppMode` and its `finally` releases the temp app zip; the inner `try` opens right after `writeSpecZip` and its `finally` releases the spec zip.
**Why**: Makes each scope's correspondence to its acquisition structural rather than conditional, per the existing "`finally` scope follows the acquisition" Design Decision (from #155); nesting also preserves the spec-zip-before-app-zip unlink order naturally (inner `finally` runs first).
**Rejected**: A single `try` opened after `resolveAppMode` with `let zipPath: string | undefined` and an `if (zipPath)` guard — acceptable per the intake, but the guard makes the spec-zip release conditional on runtime state rather than structural scope.
*Introduced by*: 260726-rpx7-fix-submit-appzip-cleanup-leak

## Tasks

### Phase 1: Regression Test (must FAIL pre-fix)

- [x] T001 Add the regression test to `packages/cloud-core/src/test/submit.test.ts`: temp `.app` directory as `appPath`, nonexistent `checked.tests[0].sourcePath`, assert `submitRun` rejects, no request is sent, and the tmpdir snapshot (`/^finalrun-(cloud|app)-.*\.zip$/`) is unchanged <!-- R2 -->
- [x] T002 Build and run the test against the UNFIXED source; confirm it FAILS and record the exact failure output <!-- R2 -->

### Phase 2: Fix

- [x] T003 Restructure `packages/cloud-core/src/submit.ts` `submitRun` into nested `try`/`finally` scopes: outer `try` opens after `resolveAppMode` (finally: temp app zip), inner `try` opens after `writeSpecZip` (finally: spec zip); both `unlinkSync` calls keep their `try {} catch {}` wrappers <!-- R1 -->
- [x] T004 Replace the misleading comment above the old `try` with one that accurately describes the nested structure and the preserved unlink order <!-- R4 -->

### Phase 3: Verification

- [x] T005 Confirm unlink order is preserved structurally (inner `finally` — spec zip — runs before outer `finally` — app zip) and that the new test now PASSES; all 15 existing tests pass unmodified <!-- R3 -->
- [x] T006 Run full verification: `npm run build --workspaces --if-present` (exit 0), `npm run test:workspaces` (exit 0, 366 total, 0 fail), `npm run lint` (exit 0, 131 warnings / 0 errors, `max-depth` and `no-unused-vars` at zero, per-rule breakdown) <!-- R3, R5 -->

## Acceptance

### Functional Completeness

- [x] A-001 R1: A throw from `collectFilesToZip` or `writeSpecZip` after `resolveAppMode` acquired a temp `.app.zip` no longer orphans that zip — the outer `finally` releases it. Verified by an instrumented `fs.unlinkSync` probe: on the `writeSpecZip`-throws path the recorded unlink sequence is exactly `[APP_ZIP]`, tmpdir snapshot unchanged, 0 requests sent
- [x] A-002 R2: `submit.test.ts` contains exactly one new test covering the pre-`try` throw path (diff: 26 insertions / 0 deletions), and it was independently confirmed to FAIL against the unfixed source — `submit.ts` reverted to `HEAD` with the test kept, cloud-core rebuilt: 16 tests / 15 pass / 1 fail, the failure being `AssertionError: a pre-upload failure must not orphan the temp app zip` with a single extra `finalrun-app-*.zip` in the actual set

### Behavioral Correctness

- [x] A-003 R3: The `writeSpecZip` error propagates to the caller unchanged (rejection observed by the test; probe confirms the rejection message is the AdmZip `File not found` error), and both `unlinkSync` calls remain wrapped in `try {} catch {}`. Additionally verified by forcing every `unlinkSync` to throw: the original AdmZip error still won, proving neither `finally` can replace the in-flight error
- [x] A-004 R3: Unlink order is spec zip before app zip (inner `finally` before outer `finally`) — confirmed structurally AND empirically (probe records `[SPEC_ZIP, APP_ZIP]` on success, fetch-rejection, and form-build-failure paths). Note: no test observes the order; the tmpdir-snapshot assertions compare final sets only

### Scenario Coverage

- [x] A-005 R2: The new test uses a real temp `.app` directory (so `isTempZip: true`) and a nonexistent spec `sourcePath`, and asserts via the existing tmpdir-snapshot technique that no `finalrun-(cloud|app)-*.zip` survives; it also pins `stub.requests.length === 0`
- [x] A-006 R3: All 15 pre-existing `submit.test.ts` tests are byte-for-byte unmodified (0 deletions in the test-file diff) and pass; totals rise 365 → 366 (cloud-core 15 → 16), full suite 75/16/91/67/117, 0 fail

### Edge Cases & Error Handling

- [x] A-007 R1: Server-default mode (no `appPath`) and non-temp app modes are unaffected — probe confirms server-default unlinks only the spec zip, and a supplied `.apk` unlinks only the spec zip with the user's `.apk` still on disk. (`.app.zip` passthrough shares the `isTempZip: false` code path; it has no dedicated test, pre-existing gap)

### Code Quality

- [x] A-008 Pattern consistency: The nested `try`/`finally` shape matches `testRunner.runTests` (`packages/cli/src/testRunner.ts:136-159`) established in #155 — each `finally` paired with its acquisition; every clause of the replacement comment is true of the code as written
- [x] A-009 No unnecessary duplication: The new test reuses `makeTempDir`, `makeInput`, `installFetchStub`, `okResponse`, and `tempZipArtifacts` rather than reimplementing them
- [x] A-010 R5: `npm run lint` exits 0 with 131 problems (0 errors, 131 warnings = 83 `max-lines-per-function` + 48 `complexity`); `max-depth` (configured `['warn', 4]`) and `no-unused-vars` at zero violations tree-wide; `submit.ts` itself is lint-clean

## Notes

### Follow-ups raised during review (not addressed here)

**1. Temp filenames can collide — potential cross-run data loss.**
`appBundle.ts:88` and `submit.ts` name temp files `finalrun-app-${Date.now()}.zip` and
`finalrun-cloud-${Date.now()}.zip`: millisecond resolution, no random component. The review stage
**hit a real same-millisecond collision** while instrumenting this change — one run's zip clobbered
an identically-named leftover and then unlinked it. Two concurrent `finalrun cloud test` invocations
on one machine could therefore have one delete the other's upload mid-flight.

This is more serious than the leak just fixed: a leak wastes disk, a collision corrupts a live
submission. It is untouched by this change (the names predate it) and out of scope, but it deserves
its own `fix:` change — `fs.mkdtempSync` or a random suffix, plus a test that two overlapping
submissions produce distinct paths.

**2. Acquisition-side orphan, one level shallower.**
The spec zip is still orphaned if `zip.writeZip(zipPath)` throws mid-write, and the app zip if
`fs.statSync` throws immediately after `writeZip` (`appBundle.ts:90`): in both cases the file exists
on disk before the path is returned to a caller that could scope a `finally` around it. The strictest
reading of the "`finally` scope follows the acquisition" Design Decision says the acquiring function
must release it itself. Identical to pre-change behaviour, so not a regression — but it is the same
rule applied one level deeper, and worth closing when the collision fix touches these functions.

**3. Unlink order is not pinned by any test.**
Spec-zip-before-app-zip is guaranteed by JS `finally` semantics (innermost first) and was confirmed
empirically by review's instrumentation, but all four tmpdir-snapshot assertions compare final
*sets*, not sequence. Recorded so nobody later assumes the order is test-enforced.


- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- None — this change is a scope restructuring plus one test; it makes no existing file, function, branch, or config redundant. Both `unlinkSync` blocks are still reachable and still needed (one per acquisition), the `isTempZip` guard is still load-bearing for `.apk`/`.app.zip` passthrough, and no helper was superseded. The only text removed is the misleading comment, which R4 required replacing rather than deleting.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Use nested `try`/`finally` (intake's preferred shape) rather than the single-`try` + `let zipPath` alternative | Intake explicitly prefers nesting; it makes scope-follows-acquisition structural and preserves unlink order without a guard | S:90 R:85 A:95 D:90 |
| 2 | Certain | The new test additionally asserts `stub.requests.length === 0` (no request sent) | The throw occurs before the upload phase; pinning that the request is never dispatched strengthens the test without changing its subject, and the fetch stub is installed anyway as a network guard | S:80 R:90 A:90 D:85 |
| 3 | Confident | Place the new test after the existing fetch-failure cleanup test, matching its style (tmpdir snapshot before, `assert.rejects`, `stub.restore()` in `finally`) | Keeps cleanup tests adjacent and reuses the established pattern; placement is presentational | S:75 R:95 A:90 D:85 |
| 4 | Certain | Do not add cleanup of the pre-fix orphaned zip inside the test | Once fixed, nothing leaks; existing cleanup tests use the same snapshot-comparison style without self-cleanup, and each test snapshots its own `before` so a stale artifact cannot cross-contaminate | S:80 R:85 A:90 D:85 |
| 5 | Certain | The nesting stays within `max-depth 4` without extracting a helper | Deepest block is the inner `finally`'s `try {} catch {}` at depth 3 (outer try=1, inner try=2, cleanup try=3); verified by lint in T006 | S:85 R:95 A:95 D:90 |

5 assumptions (4 certain, 1 confident, 0 tentative).
