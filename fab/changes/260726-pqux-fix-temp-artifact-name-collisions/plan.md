# Plan: Make Temp Artifact Names Collision-Resistant

**Change**: 260726-pqux-fix-temp-artifact-name-collisions
**Intake**: `intake.md`

## Requirements

### cloud-core: Temp Artifact Naming

#### R1: Spec-zip temp name MUST be collision-resistant
`writeSpecZip` (`packages/cloud-core/src/submit.ts`) MUST name its temp file with a random component inserted between the timestamp and the `.zip` extension, using `randomUUID` from the built-in `node:crypto`: `finalrun-cloud-${Date.now()}-${randomUUID()}.zip`. The `finalrun-cloud-` prefix, the timestamp, and the `.zip` suffix MUST all be preserved (the prefix is load-bearing for `submit.test.ts`'s `tempZipArtifacts()` filter `/^finalrun-(cloud|app)-.*\.zip$/`; the timestamp keeps an orphaned temp file diagnosable).

- **GIVEN** two `submitRun` calls whose `writeSpecZip` executions land in the same millisecond (identical `Date.now()`)
- **WHEN** each writes its spec zip into the shared `os.tmpdir()`
- **THEN** the two zips resolve to two distinct paths, and neither submission can overwrite or unlink the other's in-flight archive

#### R2: App-zip temp name MUST be collision-resistant
`zipAppBundle` (`packages/cloud-core/src/appBundle.ts`) MUST name its temp file `finalrun-app-${Date.now()}-${randomUUID()}.zip`, under the same prefix/timestamp/suffix preservation constraints as R1.

- **GIVEN** two `submitRun` calls each submitting a `.app` directory, with `zipAppBundle` landing in the same millisecond
- **WHEN** each writes its temp `.app.zip` into `os.tmpdir()`
- **THEN** the two app zips resolve to two distinct paths

#### R3: Regression tests MUST make the collision deterministic and fail pre-fix
`packages/cloud-core/src/test/submit.test.ts` MUST gain two tests (16 → 18) that drive the module-private naming sites through `submitRun` and observe `os.tmpdir()` while the artifacts exist (inside the `fetch` stub, before cleanup runs). Both tests MUST stub `Date.now` to a constant (restored in a `finally`) so both submissions receive an identical timestamp — the collision is certain, not probabilistic. Both tests MUST have been confirmed to FAIL against the unfixed source. Both tests MUST also assert cleanup removes all temp zips afterwards.

- **GIVEN** `Date.now` stubbed to a constant and two concurrent `submitRun` calls (`Promise.all`) with distinct spec fixtures
- **WHEN** both submissions are simultaneously in flight (observed inside the `fetch` stub)
- **THEN** two distinct `finalrun-cloud-*` temp names coexist in `os.tmpdir()` (spec-zip test), and two distinct `finalrun-app-*` temp names coexist for two concurrent `.app`-directory submissions (app-zip test)
- **AND** after both submissions complete, `tempZipArtifacts()` equals its pre-test snapshot (no leak reintroduced)
- **AND** against the pre-fix source, each test fails (only one shared name exists in-flight)

#### R4: Existing behaviour MUST NOT change
The fix is additive to two filenames only. #157's cleanup structure MUST be untouched: nested `try`/`finally` each scoped to its own acquisition, both `unlinkSync` calls keep their `try {} catch {}`, spec zip unlinked before app zip, original errors propagate. `PreparedApp`'s shape and `isTempZip` semantics MUST be unchanged; a user-supplied `.apk`/`.app.zip` is never copied, renamed, or deleted. The uploaded `filename` stays `${basename}.zip` derived from the bundle name, not the temp path. All 16 existing `submit.test.ts` tests MUST pass unmodified — in particular the four cleanup assertions that depend on the `finalrun-(cloud|app)-` prefix.

- **GIVEN** the existing 16 `submit.test.ts` tests, byte-for-byte unmodified
- **WHEN** the suite runs against the fixed source
- **THEN** all 16 pass, including the `appFilename`/`MyApp.app.zip` assertions and the four `tempZipArtifacts()` cleanup assertions

#### R5: Memory MUST state the collision-resistant naming as present truth
`docs/memory/ci/pr-quality-gate.md` § Design Decisions ("Characterize around the absent seam…") MUST be rewritten to current truth: the temp names carry a random component and temp-artifact uniqueness is test-covered — it is no longer an unreachable gap. The `tempZipArtifacts()` prefix-keying note MUST be kept (still accurate). `fab memory-index` MUST be run and `fab memory-index --check` MUST exit 0.

- **GIVEN** the memory file documents the same-millisecond collision as present behaviour and lists uniqueness as an unreachable gap
- **WHEN** this change lands
- **THEN** the Design Decisions entry describes the `Date.now()`-plus-`randomUUID()` naming and the concurrent-submission coverage, with no transition narration, and `fab memory-index --check` exits 0

### Non-Goals

- The 131 lint warnings (`max-lines-per-function` + `complexity`), including `upload.ts`, `sessionRunner.ts`, `reportWriter.ts`
- The acquisition-side orphan (`writeZip`/`statSync` throwing mid-write) — separate follow-up
- The `FINALRUN_SUBMIT_TIMEOUT_MS` message/parser mismatch
- Promoting lint rules to `error`

### Design Decisions

#### Random filename suffix, not `fs.mkdtempSync`
**Decision**: Insert `-${randomUUID()}` before `.zip` in both temp names, keeping the prefix and timestamp; do NOT switch to `fs.mkdtempSync`.
**Why**: `mkdtempSync` would force cleanup from `fs.unlinkSync(path)` to recursive directory removal, reworking the exact `try`/`finally` scopes PR #157 restructured and verified across seven exit paths by instrumenting `unlinkSync`. A ~2⁻¹²⁸ residual collision risk does not justify re-opening verified cleanup code. `randomUUID` comes from built-in `node:crypto` — no new dependency.
**Rejected**: `fs.mkdtempSync` (atomic, collision-impossible, but reworks #157's verified cleanup); a shorter `randomBytes(6)` slug (equally acceptable per intake, but `randomUUID` is the intake's zero-thought default).
*Introduced by*: 260726-pqux-fix-temp-artifact-name-collisions

#### Barrier in the fetch stub holds both submissions in flight
**Decision**: The regression tests' `fetch` stub captures `tempZipArtifacts()` on each call and makes the first call wait until the second arrives before either resolves, so both submissions are provably in flight when the coexistence assertion's snapshot is taken.
**Why**: Without a barrier, the first submission could complete (and its `finally` unlink the shared path) before the second's fetch observes the tmpdir, making the pre-fix failure mode depend on microtask ordering rather than being structural. The barrier needs no timers and no seam — it lives entirely in the already-stubbed `fetch` global.
**Rejected**: Snapshotting once after `Promise.all` resolves — cleanup has already run by then, so nothing coexists to observe; timer-based sleeps — flaky and slower.
*Introduced by*: 260726-pqux-fix-temp-artifact-name-collisions

## Tasks

### Phase 1: Regression Tests (test FIRST)

- [x] T001 Add two concurrency regression tests to `packages/cloud-core/src/test/submit.test.ts`: (a) two concurrent `submitRun` calls with distinct spec fixtures and `Date.now` stubbed to a constant assert two distinct `finalrun-cloud-*` temp names coexist in-flight; (b) two concurrent `.app`-directory submissions assert two distinct `finalrun-app-*` temp names coexist in-flight; both assert `tempZipArtifacts()` returns to its pre-test snapshot afterwards. `Date.now` restored in a `finally`. <!-- R3 -->
- [x] T002 Build and run the cloud-core suite against the UNFIXED source; confirm both new tests FAIL (one shared name in-flight) and record the exact failure output. <!-- R3 -->

### Phase 2: Fix

- [x] T003 In `packages/cloud-core/src/submit.ts` (`writeSpecZip`, ~line 225): change the temp name to `finalrun-cloud-${Date.now()}-${randomUUID()}.zip`; add the `node:crypto` import. Touch nothing else in the file. <!-- R1 -->
- [x] T004 [P] In `packages/cloud-core/src/appBundle.ts` (`zipAppBundle`, ~line 88): change the temp name to `finalrun-app-${Date.now()}-${randomUUID()}.zip`; add the `node:crypto` import. Touch nothing else in the file. <!-- R2 -->

### Phase 3: Verification

- [x] T005 Full verification: `npm run build --workspaces --if-present` exit 0; `npm run test:workspaces` exit 0 with 368 tests (75 common, 18 cloud-core, 91 device-node, 67 goal-executor, 117 cli), 0 failures; `npm run lint` exit 0 with 131 warnings / 0 errors, `max-depth` and `no-unused-vars` at zero; confirm all 16 pre-existing `submit.test.ts` tests pass byte-for-byte unmodified (including the four prefix-dependent cleanup assertions and the `appFilename` assertion). <!-- R4 -->

### Phase 4: Memory

- [x] T006 Update `docs/memory/ci/pr-quality-gate.md` § Design Decisions ("Characterize around the absent seam…"): rewrite to present truth — collision-resistant naming, uniqueness test-covered, spinner strings remain the recorded gap; keep the `tempZipArtifacts()` prefix-keying note. Run `fab memory-index` and verify `fab memory-index --check` exits 0. <!-- R5 -->

## Acceptance

### Functional Completeness

- [x] A-001 R1: `writeSpecZip` names its temp file `finalrun-cloud-${Date.now()}-${randomUUID()}.zip`, with `randomUUID` imported from `node:crypto`
- [x] A-002 R2: `zipAppBundle` names its temp file `finalrun-app-${Date.now()}-${randomUUID()}.zip`, with `randomUUID` imported from `node:crypto`
- [x] A-003 R3: Two new tests exist in `submit.test.ts` driving both naming sites through concurrent `submitRun` calls with `Date.now` stubbed to a constant (restored in `finally`)

### Behavioral Correctness

- [x] A-004 R1: With identical timestamps, two concurrent spec submissions produce two distinct in-flight `finalrun-cloud-*` names (asserted inside the fetch stub, before cleanup)
- [x] A-005 R2: With identical timestamps, two concurrent `.app` submissions produce two distinct in-flight `finalrun-app-*` names
- [x] A-006 R3: Both new tests were confirmed to FAIL against the unfixed source, with the failure output recorded

### Scenario Coverage

- [x] A-007 R3: Both new tests assert `tempZipArtifacts()` returns to its pre-test snapshot after both submissions complete (cleanup preserved, no leak reintroduced)
- [x] A-008 R4: All 16 pre-existing `submit.test.ts` tests pass unmodified — including the four `tempZipArtifacts()` cleanup assertions that key on the `finalrun-(cloud|app)-` prefix and the `appFilename`/`MyApp.app.zip` assertion

### Edge Cases & Error Handling

- [x] A-009 R4: #157's cleanup structure is untouched: nested `try`/`finally` scoped per acquisition, both `unlinkSync` calls keep `try {} catch {}`, spec zip unlinked before app zip, original errors propagate; `PreparedApp` shape and `isTempZip` semantics unchanged; user-supplied `.apk`/`.app.zip` never copied, renamed, or deleted

### Code Quality

- [x] A-010 Pattern consistency: The naming change follows the existing style (template literal, `path.join(os.tmpdir(), ...)`); the new tests follow the existing `submit.test.ts` conventions (stub-and-restore-in-`finally`, `tempZipArtifacts()` diffing, `installFetchStub`)
- [x] A-011 No unnecessary duplication: The tests reuse the existing `makeInput`/`makeTempDir`/`installFetchStub`/`okResponse`/`tempZipArtifacts` helpers rather than reimplementing them
- [x] A-012 No new dependency: randomness comes from built-in `node:crypto`; `npm run lint` stays at 131 warnings / 0 errors with `max-depth` and `no-unused-vars` at zero

### Memory

- [x] A-013 R5: `docs/memory/ci/pr-quality-gate.md` states the collision-resistant naming and test coverage as present truth (no "unreachable gap" claim for temp-artifact uniqueness, no transition narration), keeps the prefix-keying note, and `fab memory-index --check` exits 0

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)

## Deletion Candidates

- `None` — this change is additive to two filename expressions and adds two tests; it makes no existing code, branch, or config redundant. The prior memory sentence describing temp-artifact uniqueness as an unreachable gap was not deleted but rewritten in place, since the surrounding Design Decision entry (the spinner-string gap, the no-seam rule) remains present truth.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Use `randomUUID()` (not a shorter `randomBytes` slug) | Intake's stated zero-thought default; both acceptable; no new dependency either way | S:90 R:95 A:95 D:85 |
| 2 | Certain | Keep the timestamp before the random component | Intake Assumption #4: keeps orphaned temp files sortable and diagnosable; costs nothing | S:85 R:95 A:90 D:90 |
| 3 | Certain | Two separate tests (spec-zip, app-zip), not one combined | Intake's test shape lists them separately; separate failures localize the broken naming site | S:85 R:90 A:90 D:85 |
| 4 | Confident | Hold both submissions in flight via a barrier inside the fetch stub (first call awaits the second) | The intake requires observing artifacts "while in flight"; a barrier makes the overlap structural rather than dependent on microtask ordering, with no timers and no new seam. Both zips are written synchronously before the first `await`, so the barrier only guards against early cleanup | S:75 R:90 A:85 D:75 |
| 5 | Confident | Assert coexistence as "exactly 2 new names with the expected prefix" via a diff against a pre-test snapshot | Directory listings cannot repeat a name, so 2 new prefix-matching names ⇔ two distinct paths; the snapshot diff isolates the assertion from unrelated tmpdir leftovers, matching the suite's existing tmpdir-diff technique | S:80 R:90 A:90 D:80 |
| 6 | Confident | Stubbing `Date.now` is consistent with the recorded stub-only-crossed-globals convention | `Date.now` is a process global `submitRun`/`zipAppBundle` genuinely cross; restored in `finally` like `fetch`/`console.log`; the memory update adds it to the crossed-globals list | S:80 R:85 A:85 D:80 |

6 assumptions (3 certain, 3 confident, 0 tentative).
