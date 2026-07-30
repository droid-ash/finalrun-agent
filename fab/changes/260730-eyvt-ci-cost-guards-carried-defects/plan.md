# Plan: CI Cost Guards and Carried-Forward Defects

**Change**: 260730-eyvt-ci-cost-guards-carried-defects
**Intake**: `intake.md`

## Requirements

### CI: Drivers workflow cost guards

#### R1: Both `drivers.yml` jobs MUST carry a measured job-level timeout
`.github/workflows/drivers.yml` MUST declare a **job-level** `timeout-minutes` on each job —
`15` on `android` (`ubuntu-latest`) and `25` on `ios` (`macos-latest`) — so checkout and toolchain
setup are inside the bound, not only the build step. Each value MUST be preceded by a comment
recording the measured worst-case run it derives from (`android` worst observed 2m36s; `ios` worst
observed 9m20s across five recorded runs), so a future reader can tell a measured bound from a
guessed one. The values SHALL NOT be raised to a cap so generous it defeats its own purpose: a
spurious timeout is a red job a re-run clears, which is the failure direction to prefer.

- **GIVEN** a wedged `xcodebuild` (an SPM resolve stuck on a network stall, a simulator that never
  boots) on the `ios` job
- **WHEN** the run exceeds 25 minutes
- **THEN** GitHub cancels the job at 25 minutes rather than at its 360-minute default
- **AND** worst-case exposure for that job drops from ~3,600 billable minutes (360 × 10× macOS) to
  250

- **GIVEN** the `android` job on its slowest recorded profile (2m36s)
- **WHEN** the job runs with a cold gradle cache on a slow runner image
- **THEN** it completes well inside the 15-minute bound (~5.8× headroom) and does not time out
  spuriously

#### R2: Both triggers MUST be filtered to driver-relevant paths
Both the `pull_request` and the `push` trigger in `.github/workflows/drivers.yml` MUST carry a
`paths:` filter listing exactly:

```
drivers/**
proto/**
scripts/build-drivers-android.sh
scripts/build-drivers-ios.sh
.github/workflows/drivers.yml
```

`proto/**` MUST be present: `drivers/android/app/build.gradle.kts:104` adds the repo-root `proto`
directory as a protobuf source dir, so the Android driver compiles `proto/finalrun/driver.proto`
from source and a proto edit can break the Kotlin compile with no file under `drivers/` changing.
`resources/android/` and `resources/ios/` MUST NOT be listed — they are the build scripts' output
staging directories, not build inputs. The two lists MUST be duplicated **verbatim** — a
*deliberate* choice, not a forced one: GitHub Actions **has** supported YAML anchors/aliases since
2025-09-18, so an anchor would parse; two literal adjacent lists are kept because they are trivially
eyeball- and diff-verifiable and because anchor support specifically inside the `on:` trigger block
is not verified by this change. The lists MUST carry a comment requiring they stay in sync.

- **GIVEN** a pull request whose diff touches only `docs/`, `fab/`, or `packages/report-web`
- **WHEN** the workflow's trigger is evaluated
- **THEN** neither the `android` nor the `ios` job runs, and no `drivers` check is reported
- **AND** no merge is blocked, because ruleset `14531661` requires only `ci.yml`'s `test` context

- **GIVEN** a pull request that edits `proto/finalrun/driver.proto` and no file under `drivers/`
- **WHEN** the trigger is evaluated
- **THEN** the workflow runs, because `proto/**` is in the filter and the Android compile consumes
  that file

- **GIVEN** a merge to `main` whose diff touches a driver-relevant path
- **WHEN** the `push` trigger is evaluated
- **THEN** the post-merge safety-net run still fires

#### R3: A PR-scoped `concurrency` block MUST supersede in-flight PR runs without ever queueing or evicting a `main` run
`.github/workflows/drivers.yml` MUST carry a workflow-level `concurrency` block whose `group` is
`drivers-${{ github.event_name == 'pull_request' && github.ref || github.run_id }}` and whose
`cancel-in-progress` is `${{ github.event_name == 'pull_request' }}`. A bare
`group: drivers-${{ github.ref }}` MUST NOT be used: on the default `queue: single` GitHub cancels
an existing **pending** run whenever a newer run queues into the same group, so a bare group
reintroduces cancellation on `main` even with `cancel-in-progress` false. The header comment at
lines 24-27 asserting "There is deliberately NO `concurrency:` block" MUST be replaced in the same
change — the file MUST NOT be left contradicting itself — and the replacement MUST keep the
pending-eviction reasoning, which is precisely why the group key is run-id-scoped on `main`.
`.github/workflows/ci.yml` MUST NOT be modified: its no-`concurrency` rule is unchanged and still
correct for the required check.

- **GIVEN** an in-flight `drivers` run on a pull request
- **WHEN** a newer push to the same PR starts another run
- **THEN** the group key resolves to the PR ref for both, `cancel-in-progress` evaluates true, and
  the earlier run is cancelled
- **AND** no merge gate is affected, because no context from this workflow is required

- **GIVEN** two merges to `main` in rapid succession
- **WHEN** the second run queues
- **THEN** each run's group key is its own unique `github.run_id`, so neither run is queued behind,
  evicted by, or cancelled because of the other — `main` behaves exactly as it does today

### device-node: Log write-stream error handling

#### R4: `open()` MUST attach a persistent `error` listener and record the first error
`LogWriteStreamRegistry` in `packages/device-node/src/device/logWriteStream.ts` MUST track a small
entry object (`{ readonly stream: fs.WriteStream; error?: Error }`) per output file path instead of
the bare stream, and `open()` MUST attach an `error` listener to the stream **before returning** —
before anything can pipe into it — and keep it for the stream's whole life. The listener MUST
record the **first** error on the entry (later errors MUST NOT overwrite it) and MUST log it via
`Logger.e`. Recording, not merely logging, is required because `_endAndFlush` early-returns on an
errored (hence auto-destroyed) stream, so without the record `finalize` would resolve and report a
successful stop over a log file that was never written.

- **GIVEN** a freshly returned stream from `open()`
- **WHEN** its `error` listener count is read synchronously on return
- **THEN** it is greater than zero, so no `error` event can ever be unhandled

- **GIVEN** a write stream whose asynchronous `open(2)` fails (a path inside a non-existent
  directory, `EACCES`, `EMFILE`) or whose later write fails (`ENOSPC`)
- **WHEN** the stream emits `error`
- **THEN** the error is recorded on the registry entry and logged, and Node does not throw it as an
  uncaught exception that would take the CLI down mid-run

- **GIVEN** a stream that emits `error` twice
- **WHEN** both events are handled
- **THEN** the entry retains the first error

#### R5: `finalize` MUST fail the stop on a recorded error, after its existing `try`/`finally`
`finalize` MUST read the entry, resolve immediately for an untracked path (unchanged idempotency),
and — **after** its existing `try`/`finally` completes without throwing — re-throw a recorded
error. A drain rejection or a flush error MUST take precedence: it is already the failure being
reported and MUST NOT be masked or replaced by a redundant one. Untracking and
`_endAndFlush` MUST still run on every path inside the `finally`; the pre-`end()` `unpipe` on the
drain-timeout path MUST stay; `finalizeQuietly` MUST still catch, log, and resolve.

- **GIVEN** a tracked path whose stream recorded an error and nothing else threw
- **WHEN** `finalize` is awaited
- **THEN** it rejects with the recorded error, and the stream has still been ended and untracked

- **GIVEN** a tracked path whose source `stdout` emitted `error` so `_drain` rejects
- **WHEN** `finalize` is awaited
- **THEN** it rejects with the drain's error — not with a recorded write error — and the stream is
  still ended and untracked

- **GIVEN** a path that was never opened, or one an earlier stop already finalized
- **WHEN** `finalize` is awaited
- **THEN** it resolves immediately (idempotent, unchanged)

- **GIVEN** a path whose stream recorded an error
- **WHEN** `finalizeQuietly` is awaited
- **THEN** it logs the error and resolves, because its callers are already returning a failure

#### R6: The registry's new behavior MUST be covered by regression tests in the existing file
`packages/device-node/src/device/test/logCaptureProviders.test.ts` — which already unit-tests
`LogWriteStreamRegistry` directly — MUST gain four cases rather than a second registry test file:
(1) `open()` attaches an `error` listener synchronously; (2) a stream whose open fails raises no
uncaught `error` and its subsequent `finalize` rejects with that error; (3) `finalizeQuietly` on
such a stream logs and resolves; (4) a normal open → write → `finalize` still resolves and
untracks.

- **GIVEN** the four new cases run against the pre-fix source
- **WHEN** the suite executes
- **THEN** case 1 fails on a zero listener count and case 2 fails on a resolved (not rejected)
  `finalize` — the regression guards bite

- **GIVEN** the four new cases run against the fixed source
- **WHEN** `npm run build` then the `packages/device-node` test script executes the compiled output
- **THEN** all cases pass and the pre-existing provider and registry cases still pass

### Non-Goals

- `.github/workflows/ci.yml` — its no-`concurrency` rule is unchanged and still correct for the
  required check; a paths filter or a cancelling group there would break the required `test` context.
- `~/.fab-kit/**` and `.claude/skills/git-pr/SKILL.md` — hard out-of-scope constraints from the
  intake's scope correction. The `/git-pr` expected-write-area fix is backlog `ax7i`, to be done
  upstream in fab-kit.
- `fab/project/config.yaml` — not touched; `.github/` is deliberately not added to `source_paths`.
- Repo ruleset `14531661` — no required-check change. If `android`/`ios` are ever made required, the
  paths filter becomes a merge-blocking hazard and needs the always-runs sentinel-job pattern.
- `scripts/build-drivers-android.sh`, `scripts/build-drivers-ios.sh` — filter inputs, not edit targets.
- `AndroidLogcatProvider` / `IOSLogProvider` — they call `open()`/`finalize()`/`finalizeQuietly()`
  and need no change; the fix is entirely inside the registry.
- `docs/memory/**` — hydrate's job, not apply's.

### Design Decisions

#### A non-required additive gate may cancel where the required check may not
**Decision**: `drivers.yml` carries a `pull_request`-scoped `concurrency` block whose group key is
`github.ref` on a PR and the per-run-unique `github.run_id` on a push to `main`, with
`cancel-in-progress` expression-gated to `pull_request`. `ci.yml` keeps no `concurrency` key at all.
**Why**: The recorded no-cancellation rule is load-bearing *because `test` is the required check* —
a cancelled run at a mergeable PR tip is an unverified commit that reads exactly like a clean one,
and the merge gate consults it. Ruleset `14531661` requires only `ci.yml`'s `test` context, so a
cancelled `drivers` run is visibly `cancelled`, gates no merge, and the commit it skipped is
superseded by the push that cancelled it. What is traded is native-compile coverage of commits that
are no longer the tip — measured waste closed: PR #167's three pushes, ~200 billable minutes for one
informative verdict.
**Rejected**: (a) an unconditional `group: drivers-${{ github.ref }}` with
`cancel-in-progress: true` — simpler, but on the default `queue: single` GitHub cancels an existing
**pending** run whenever a newer run queues into the same group, so two rapid merges would silently
cost the middle one its verdict; (b) no group at all — drops half the requested lever; (c) copying
the block to `ci.yml` — breaks the guarantee the required check exists to provide.
*Introduced by*: 260730-eyvt-ci-cost-guards-carried-defects

#### A recorded stream error is re-thrown after `finalize`'s `try`/`finally`, not inside it
**Decision**: `open()` records the first `error` on the registry entry; `finalize` re-throws it only
after its existing `try`/`finally` has completed without throwing.
**Why**: A drain rejection and a recorded write error both mean "the log is not known to be
complete", so either satisfies the existing "a write error rejects" contract — but throwing after
the `finally` gets correct precedence for free and cannot mask the original failure. Recording
rather than only logging is what closes the second face of the defect: `_endAndFlush` early-returns
on an errored (hence auto-destroyed) stream, so a log-only fix would leave `finalize` resolving and
reporting a successful stop over an unwritten file.
**Rejected**: (a) throwing inside the `finally` — masks a drain rejection with a redundant error;
(b) logging only — leaves half the defect (a silently successful stop) in place; (c) attaching the
listener in each provider — the providers' versions would diff empty modulo a log prefix, and the
registry already owns this bookkeeping.
*Introduced by*: 260730-eyvt-ci-cost-guards-carried-defects

## Tasks

### Phase 1: Workflow cost guards (`.github/workflows/drivers.yml`)

<!-- Single file — all three edits are sequential, not [P]. -->

- [x] T001 Add job-level `timeout-minutes: 15` to the `android` job and `timeout-minutes: 25` to the `ios` job in `.github/workflows/drivers.yml`, each preceded by a comment recording the measured worst-case run it derives from (android 2m36s / ~5.8× headroom; ios 9m20s / ~2.7× headroom, tighter because macOS bills at 10×) <!-- R1 -->
- [x] T002 Add the five-entry `paths:` filter to BOTH the `pull_request` and `push` triggers in `.github/workflows/drivers.yml`, duplicated verbatim, with a comment explaining why each entry earns its place (especially `proto/**` via `drivers/android/app/build.gradle.kts:104`), why `resources/*` is absent, and that the two lists must stay byte-identical because GitHub Actions supports no YAML anchors <!-- R2 -->
- [x] T003 Add the workflow-level `concurrency:` block to `.github/workflows/drivers.yml` with the PR-scoped `group`/`cancel-in-progress` expressions and its rationale comment, and REPLACE the contradicted header comment at lines 24-27 ("There is deliberately NO `concurrency:` block") with a pointer to the new block that keeps the pending-eviction reasoning <!-- R3 -->
- [x] T004 Verify `.github/workflows/drivers.yml` parses as YAML and that the parsed tree carries both `paths` lists (byte-identical), both `timeout-minutes` values, and the two `concurrency` expressions; confirm `.github/workflows/ci.yml` is untouched <!-- R2 -->

### Phase 2: Log write-stream error handling (`packages/device-node`)

- [x] T005 In `packages/device-node/src/device/logWriteStream.ts` introduce the module-private `LogStreamEntry` interface, change `_streams` to `Map<string, LogStreamEntry>`, and make `open()` create the entry, track it, and attach the persistent first-error-recording `error` listener (logging via `Logger.e`) before returning the stream <!-- R4 --> <!-- rework: MUST-FIX — logWriteStream.ts:84. The `Logger.e` call inside the new `error` listener is itself fallible and unguarded, so it defeats the requirement it implements. `Logger._emit`'s sink loop (packages/common/src/logger.ts:103-105) has no try/catch, and the CLI installs `ReportWriter.createLoggerSink()` (packages/cli/src/reportWriter.ts:132) — a bare `fs.appendFileSync` to the runner log in the SAME run directory. On ENOSPC (the trigger R4's third scenario names) the device log's stream emits `error`, the listener records it, then `Logger.e` throws ENOSPC too; the throw escapes the listener out of `emit('error')` and becomes an uncaughtException that kills the CLI mid-run — exactly the failure R4 exists to close. Remedy: wrap ONLY the log call in try/catch, keeping `entry.error ??= error` first so `finalize` still fails the stop. The `Rejected (a)` against a log-call try/catch in docs/memory/cli/session-runner.md:37 is scoped to the acquisition-ordering problem where reordering is the better structural fix; an error-listener of last resort has nothing to reorder and MUST NOT throw. -->
- [x] T006 In `packages/device-node/src/device/logWriteStream.ts` update `finalize` to read the entry, destructure its `stream`, keep the existing `try`/`finally` unchanged, and re-throw `entry.error` after the `finally`; update the class/method doc comments to state the new contract <!-- R5 -->
- [x] T007 Extend `packages/device-node/src/device/test/logCaptureProviders.test.ts` with the four registry cases: synchronous `error`-listener attachment; a failed-open stream raising no uncaught error and its `finalize` rejecting; `finalizeQuietly` on a failed-open stream resolving; and a normal open → write → `finalize` resolving and untracking <!-- R6 --> <!-- rework: SHOULD-FIX — test file :269-271. The comment claims "this test process reaching the assertions at all is what proves it no longer [throws]", but the test attaches its own `error` handler via `await once(stream, 'error')` before the async open can fail, so the error is handled with or without the fix; against pre-fix code the test still reaches the assertions and fails only on `assert.rejects`. Correct the comment — the real structural guard for attachment is the sibling test's `stream.listenerCount('error') > 0` at :256 — and fix plan Assumption 2, whose "proven implicitly" reasoning rests on the same mistake. ALSO add coverage for the new guard: an `error` listener whose `Logger.e` throws must not escape, and `finalize` must still reject with the recorded error. NICE-TO-HAVE, include while here: a two-line case pinning `??=` first-error-wins (R4's third scenario and A-010 are otherwise inspection-only). -->

### Phase 3: Verification

- [x] T008 Run `npm run build` (tests execute compiled output), `npm run typecheck --workspace=packages/device-node`, and the `packages/device-node` test suite; fix any failure <!-- R6 --> <!-- rework: re-verify after the T005 guard and T007 test changes; also confirm the new guard test fails against unguarded code. -->

## Execution Order

- T001 → T002 → T003 → T004 all edit the same file and must run in sequence; T004 gates Phase 2 only
  in the sense that a broken workflow should be caught before moving on.
- T005 blocks T006 (same file, `finalize` consumes the entry shape T005 introduces).
- T006 blocks T007 (the tests assert the new `finalize` behavior).
- T008 runs last.

## Acceptance

### Functional Completeness

- [x] A-001 R1: `.github/workflows/drivers.yml` declares `timeout-minutes: 15` at job level on `android` and `timeout-minutes: 25` at job level on `ios`, each with a comment naming the measured worst-case run (2m36s / 9m20s) it derives from
- [x] A-002 R2: Both the `pull_request` and `push` triggers carry a `paths:` list containing exactly `drivers/**`, `proto/**`, `scripts/build-drivers-android.sh`, `scripts/build-drivers-ios.sh`, `.github/workflows/drivers.yml`, byte-identical to each other, with `resources/*` absent
- [x] A-003 R3: The workflow carries `concurrency.group: drivers-${{ github.event_name == 'pull_request' && github.ref || github.run_id }}` and `concurrency.cancel-in-progress: ${{ github.event_name == 'pull_request' }}`
- [x] A-004 R4: `LogWriteStreamRegistry._streams` is a `Map<string, LogStreamEntry>` and `open()` attaches a first-error-recording `error` listener before returning
- [x] A-005 R5: `finalize` re-throws a recorded error after its existing `try`/`finally`, and `finalizeQuietly` still catches, logs, and resolves
- [x] A-006 R6: `packages/device-node/src/device/test/logCaptureProviders.test.ts` contains the four new registry cases and the whole suite passes against compiled output

### Behavioral Correctness

- [x] A-007 R3: The header comment formerly asserting "There is deliberately NO `concurrency:` block" is gone, and its replacement records why a non-required additive gate may cancel where the required `test` check may not — the file no longer contradicts itself
- [x] A-008 R3: `.github/workflows/ci.yml` is byte-unchanged — no paths filter, no concurrency key added
- [x] A-009 R5: A drain rejection or flush error still surfaces in preference to a recorded write error (the recorded error is thrown only when nothing inside `try`/`finally` threw), and the stream is ended and untracked on every path
- [x] A-010 R4: The recorded error is the **first** one — a second `error` event does not overwrite it

### Scenario Coverage

- [x] A-011 R6: A test asserts `open()`'s returned stream has a non-zero `error` listener count synchronously on return
- [x] A-012 R6: A test asserts a failed-open stream's `finalize` rejects with that error and the test process survives (no uncaught `error`)
- [x] A-013 R6: A test asserts `finalizeQuietly` on a failed-open stream resolves
- [x] A-014 R6: A test asserts the happy path (open → write → `finalize`) still resolves, writes the payload, and leaves zero live streams
- [x] A-015 R2: The `paths` filter's `proto/**` entry is justified in-file by a pointer to `drivers/android/app/build.gradle.kts:104`, so the non-obvious dependency is not silently re-litigated

### Edge Cases & Error Handling

- [x] A-016 R5: `finalize` on an untracked path still resolves immediately (idempotency preserved), verified by the pre-existing second-stop test
- [x] A-017 R3: The `push`-to-`main` group key is per-run unique (`github.run_id`), so no `main` run can be queued behind, evicted by, or cancelled because of another
- [x] A-018 R1: The timeout values leave real headroom over measured worst cases (~5.8× android, ~2.7× ios), so a cold cache or slow runner image does not produce a spurious red job

### Code Quality

- [x] A-019 Pattern consistency: New code follows the naming and structural patterns of surrounding code — the registry's existing private-field/`_`-prefix convention, its doc-comment style that states *why*, and the test file's `liveStreamCount`/`createOutputFilePath` helpers
- [x] A-020 No unnecessary duplication: Existing utilities are reused — `Logger.e` for the error log, the test file's existing helpers, and the two `drivers.yml` `paths` lists duplicated deliberately — anchors parse (GitHub Actions shipped them 2025-09-18) but two short literal lists stay eyeball- and diff-verifiable, and anchor support inside `on:` is unverified here <!-- review: implementation conforms to R2, but the stated premise was outdated — GitHub Actions has supported YAML anchors/aliases since 2025-09-18 (github.blog changelog), so the in-file comment at drivers.yml:32-35, R2's parenthetical and intake Assumption 9 asserted something false. RESOLVED in rework cycle 2: all four sites now record the true reason and Assumption 9 is re-graded Confident. -->
- [x] A-021 Readability over cleverness: The `A && B || C` concurrency ternary and the `??=` first-error record are each accompanied by a comment explaining why the obvious simpler form is wrong
- [x] A-022 No god functions: `open()` and `finalize` stay short and single-purpose — no logic beyond entry bookkeeping is added to either
- [x] A-023 No magic numbers: the two `timeout-minutes` values carry in-file derivations; no new unexplained numeric literal is introduced in `logWriteStream.ts`

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`
- Item 2's paths filter has an asymmetry the intake records: this PR itself edits
  `.github/workflows/drivers.yml`, which is in the filter, so its own `drivers` run WILL fire — that
  is the filter admitting correctly, not a failure. Proving it *excludes* correctly needs a PR
  touching no driver path. The concurrency block ships source-verified unless the PR happens to
  receive two pushes in quick succession.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | `LogStreamEntry` is a module-private (non-exported) interface | The registry itself is deliberately kept out of the package barrel — the class doc records it as "an internal detail of those two providers, not API" — so its map value type has no reason to be exported. Nothing outside the file references the entry shape | S:70 R:95 A:95 D:90 |
| 2 | Confident | The "no uncaught `error`" half is carried by the sibling attachment test's synchronous `stream.listenerCount('error') > 0`, not by test case 2; case 2 pins the recorded-error half only (`finalize` rejects) | Case 2 attaches its own handler via `await once(stream, 'error')` before the asynchronous open can fail, so the event is handled with or without the fix — reaching the assertions proves nothing about unhandledness, and against the pre-fix source the test fails on `assert.rejects`, not on an uncaught error. Attachment is instead asserted structurally, on return, before any other listener exists. The one place an escape from the listener is genuinely observable — a `Logger.e` that throws inside it — gets its own test driving a throwing `Logger` sink, the `sessionRunner.test.ts` pattern. No process-level `uncaughtException` handler is installed anywhere: it would swallow real failures elsewhere in the suite | S:60 R:85 A:80 D:70 |
| 3 | Confident | Test case 2 awaits the stream's `error` event (via a second, `once`-style listener) before calling `finalize`, rather than racing the two | Either ordering rejects — a `finalize` that lands first rejects from `finished(stream)` inside the `finally`, one that lands after rejects from the recorded error below it — but only the deterministic ordering actually exercises the new post-`finally` re-throw, which is the code under test. Adding a second `error` listener is harmless: the persistent one is already attached, so nothing is left unhandled | S:65 R:90 A:85 D:70 |
| 4 | Certain | The in-file rationale for the paths list lives in one comment block above the `pull_request` trigger, with a short "keep byte-identical" pointer above the `push` list | The full derivation duplicated under both triggers would be the same drift hazard the duplicated list already carries, doubled; a single authority plus a pointer is the same shape the file already uses for its other cross-references. GitHub Actions ignores comments entirely, so placement is free | S:60 R:95 A:90 D:85 |

4 assumptions (2 certain, 2 confident, 0 tentative).
