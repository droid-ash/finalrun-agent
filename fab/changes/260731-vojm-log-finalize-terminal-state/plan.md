# Plan: Log Finalize Awaits Terminal Stream State

**Change**: 260731-vojm-log-finalize-terminal-state
**Intake**: `intake.md`

## Requirements

### device-node: Write-stream finalization decides from terminal state

#### R1: `finalize` awaits the stream's terminal `'close'` state before deciding
`LogWriteStreamRegistry.finalize` MUST NOT decide success or failure until the tracked stream has reached its terminal `'close'` state, on **every** finalize path that reaches a tracked stream (`fs.WriteStream` always emits `'close'` — `emitClose` defaults true — after `end()` → `finish` → auto-destroy, and after `destroy(err)`). The wait MUST be state-based and MUST NOT itself throw (e.g. skip when `stream.closed`, else await a plain `'close'` listener): the failure already lives in `entry.error` / `stream.errored`, and the decision is what reports it. Untracked paths keep their immediate return.

- **GIVEN** a tracked stream that has emitted `finish` but whose auto-destroy `close(2)` has not yet completed
- **WHEN** `finalize` runs
- **THEN** it waits for `'close'` before reading any error state, so a close-time error is always observed — never missed by timing

- **GIVEN** a tracked stream already destroyed and closed (e.g. a failed asynchronous `open(2)`)
- **WHEN** `finalize` runs
- **THEN** the wait is skipped (`stream.closed` already true) and the decision runs immediately

#### R2: Success is state-based — resolve iff finished and un-errored, else reject with the first error
After terminal state, `finalize` MUST resolve iff `stream.writableFinished && stream.errored === null`. In that state, if a stale `entry.error` is recorded (reachable only via a bare non-destroying `emit('error')` — every real fs error either destroys the stream or is a close-time error, which sets `stream.errored`), `finalize` MUST log a warning naming the file and the stale error and still resolve. Otherwise it MUST reject with `entry.error ?? stream.errored` (first-recorded error wins; `stream.errored` is the fallback for a destroy with nothing recorded), synthesizing a generic error only in the in-principle-unreachable state where both are null. The normative outcome matrix is the intake's §2 table.

- **GIVEN** a stream that flushed and closed cleanly with a stale non-destroying recorded error
- **WHEN** `finalize` decides
- **THEN** it resolves, and a warning names the output file and the stale error

- **GIVEN** a stream that emitted `finish` and then errored at close time (EIO from auto-destroy's `close(2)`)
- **WHEN** `finalize` — started before the error landed — decides
- **THEN** it rejects with that error, deterministically

- **GIVEN** a stream that recorded a first error, then emitted a second, then was destroyed
- **WHEN** `finalize` decides
- **THEN** it rejects with the **first** recorded error

#### R3: Drain-rejection precedence and the drain-timeout degradation are preserved
A drain rejection thrown from `finalize`'s `try` MUST still win (the `finally` still untracks, ends, and now awaits `'close'`); the terminal-state decision MUST run only when nothing above threw. The drain-timeout degradation is untouched: unpipe → end → await close → (clean state) → resolve with a possibly-truncated log; awaiting `'close'` on an ended stream cannot hang, so bounding is unchanged.

- **GIVEN** a source whose `finished(source)` rejects mid-drain
- **WHEN** `finalize` runs
- **THEN** the stream is still untracked, ended, and closed, and `finalize` rejects with the drain error — not a redundant one

- **GIVEN** a drain that times out on a stream that then ends cleanly
- **WHEN** `finalize` completes
- **THEN** it resolves after the timeout warning, exactly as today

#### R4: Doc comments state the new guarantee, not the superseded one
The doc comments in `logWriteStream.ts` that argue for the unconditional rejection MUST be rewritten to state the terminal-state guarantee: the `finalize` contract paragraph (the "a guard on `writableFinished` here would silently drop exactly that error" argument), `_endAndFlush`'s "destroyed early return" paragraph (that early return is removed), the `LogStreamEntry` rationale, and `open()`'s listener comment (the record's remaining role: first-error-wins precedence ahead of `stream.errored`, plus the stale-error warning). `finalizeQuietly`'s quiet-before-loud ordering hazard paragraph stays — that decision is unchanged.

- **GIVEN** the updated `logWriteStream.ts`
- **WHEN** a reader consults the `finalize`/`_endAndFlush`/`open` doc comments
- **THEN** every claim matches the implemented behavior (decision after terminal state; close-time errors always observed; cleanly-finished-and-closed stream is a successful stop), and no comment argues for the removed unconditional rejection

### device-node: Test conformance to the spec (Test Integrity)

#### R5: Registry tests are updated to the spec — coverage moved, not dropped
Per the constitution's Test Integrity rule, the test pinning the superseded behavior MUST be updated to the spec — this is spec-conformance test updating, not test-weakening; the plan and PR MUST state this plainly. Concretely, in `packages/device-node/src/device/test/logCaptureProviders.test.ts`: (a) the first-error-wins test (`'LogWriteStreamRegistry records only the first error a stream emits'`, ~line 370) MUST keep pinning first-error-wins but on a *genuinely failing* stream (its old secondary assertion — rejection despite a clean flush — moves to the new tests); (b) a new test MUST pin flushed-cleanly-resolves over a stale non-destroying error (file content intact, stream untracked, warning logged); (c) a new deterministic regression test MUST pin close-time-error-rejects (drive the stream to `finish` cleanly, force the auto-destroy close to fail, assert `finalize` — started before the error lands — rejects with it). Any other test asserting the old unconditional rejection is updated on the same ground.

- **GIVEN** the reworked first-error-wins test
- **WHEN** it runs against the new implementation
- **THEN** it emits two errors on a stream that is then genuinely destroyed and asserts `finalize` rejects with the first

- **GIVEN** the new flushed-cleanly test
- **WHEN** it runs
- **THEN** a bare `emit('error')` followed by a clean write/flush yields a resolving `finalize`, an intact file, zero live streams, and a warning naming the file

- **GIVEN** the new close-time-error test
- **WHEN** it runs
- **THEN** the stream finishes cleanly, the forced close failure is delivered, and `finalize` rejects with it — with no timing dependence

#### R6: Provider-level quiet-first failure-response invariant is pinned on both platforms
New provider-level tests (parameterized over Android and iOS like the existing blocks) MUST pin the invariant that makes the documented quiet-before-loud ordering hazard safe: a quiet-first path over a stream with a recorded error returns a **failure** response by itself (e.g. `kill()` returning `false` → early failure return over an errored stream: assert `success: false` and zero live streams). These tests pin the safety invariant, NOT the swallow-then-resolve accident — they do not assert a later `finalize` outcome for the same path.

- **GIVEN** a capture over an unopenable path (recorded `ENOENT`) whose stop's SIGINT is not delivered
- **WHEN** `stopLogCapture` takes the quiet-first early-return path
- **THEN** the response is `success: false` naming the SIGINT failure, and the registry tracks no stream

### Verification

#### R7: Package and repo-wide suites stay green
The device-node package suite MUST pass, then the repo-wide gate (build, typecheck, test) MUST pass. Nothing is committed by this stage, and `fab/backlog.md` is not touched.

- **GIVEN** the completed implementation and test updates
- **WHEN** the device-node suite and then the repo-wide build/typecheck/test run
- **THEN** all pass with no skipped or newly-failing tests

### Non-Goals

- No change to the `finalize`/`finalizeQuietly` split or any provider call-site ordering
- No serialization/single-flight guard in `LogCaptureManager` (withdrawn finding; accepted, documented hazard stands)
- No change to drain-timeout bounding or its truncated-log degradation
- Memory (`docs/memory/device-node/log-capture.md`) updates happen at hydrate, not this stage
- `fab/backlog.md` MUST NOT be committed

### Design Decisions

#### Await the terminal `'close'` state, not a bare `writableFinished` guard
**Decision**: `finalize` waits for the stream's `'close'` event (state-checked, never-throwing) before deciding, on every tracked path.
**Why**: The defect is two-faced and timing-dependent — a close-time error recorded before the check rejects a flushed log; one recorded after is silently missed. Awaiting `'close'` removes the race entirely; a bare `writableFinished` guard fixes only the first face and makes the second unconditional.
**Rejected**: `writableFinished` guard on the re-throw — drops close-time errors (the #173 memory DD itself proves this); `finished(stream)`/`events.once(stream, 'close')` as the wait primitive — both reject on an errored stream, but the recorded error already carries the failure, so the wait must never throw.
*Introduced by*: 260731-vojm-log-finalize-terminal-state

#### State-based success predicate with warn-and-resolve for a stale non-destroying error
**Decision**: Resolve iff `writableFinished && stream.errored === null`; in that state a recorded `entry.error` is logged as a guarded warning and the stop succeeds; otherwise reject with `entry.error ?? stream.errored` (synthesized generic error if both null).
**Why**: Applies the file's own contract literally — a stream that finished and closed cleanly IS known complete; the only reachable resolve-over-recorded-error path is a test-artifact bare emit. First-error-wins is preserved because `entry.error` takes precedence over `stream.errored` (which only holds whatever destroyed the stream). The warning is guarded so a throwing logger sink cannot flip a successful stop into a rejection.
**Rejected**: Unconditional rejection on any recorded error — contradicts the flushed-log contract and leaves close-time observation racy; clearing `entry.error` once the flush resolves — silently drops close-time errors by another route.
*Introduced by*: 260731-vojm-log-finalize-terminal-state

#### Keep once-consumed `finalizeQuietly` semantics; pin the safety invariant with provider tests
**Decision**: The registry's once-consumed error (entry deleted in `finalize`'s `finally`) and documented-not-enforced quiet-before-loud ordering are kept; the "untested" half is answered with provider-level tests pinning that quiet-first paths return failure responses by themselves.
**Why**: CodeRabbit withdrew its serialization finding after verifying every quiet-first provider path already returns `success: false`; tombstoning errored entries reintroduces the unbounded growth the per-instance registry avoids; making `finalizeQuietly` preserve entries breaks its contract for every already-failing caller.
**Rejected**: Tombstoning errored entries; entry-preserving `finalizeQuietly`; a test pinning the second-stop-over-a-failed-stream success (cements an accident as a contract).
*Introduced by*: 260731-vojm-log-finalize-terminal-state

#### Force the close-time failure via a `_destroy` override in the regression test
**Decision**: The close-time-error test overrides the tracked stream's documented `_destroy` hook to invoke the real teardown and then deliver the callback an `EIO`-shaped error, then ends the stream and awaits `finish` before calling `finalize`.
**Why**: A real `close(2)` failure cannot be provoked deterministically on a healthy fd, and `stream.destroy(err)` after `finish` races auto-destroy's own `destroy()` call. The `_destroy` override is the documented customization seam for exactly this teardown step, and it reproduces the precise production shape: `finish` first, error at close, `stream.errored` set with `writableFinished` true.
**Rejected**: `stream.destroy(err)` after `finish` — non-deterministic against auto-destroy; sleeping on timing — flaky by construction, the shape this suite explicitly avoids.
*Introduced by*: 260731-vojm-log-finalize-terminal-state

## Tasks

### Phase 2: Core Implementation

- [x] T001 Rework `_endAndFlush` in `packages/device-node/src/device/logWriteStream.ts`: remove the `writableFinished || destroyed` early return; `end()` the stream only when `!writableEnded && !destroyed`; then, unless `stream.closed`, await a plain never-rejecting `'close'` listener (no `finished()`, no `events.once`) <!-- R1, R3 -->
- [x] T002 Replace `finalize`'s history-based decision in `packages/device-node/src/device/logWriteStream.ts` with the state-based predicate: resolve iff `writableFinished && stream.errored === null` (guarded `Logger.w` warning naming the file and error when a stale `entry.error` is set), else `throw entry.error ?? stream.errored ?? new Error(...)`; keep the drain/unpipe `try` and untrack-in-`finally` structure unchanged <!-- R2, R3 -->
- [x] T003 Rewrite the affected doc comments in `packages/device-node/src/device/logWriteStream.ts`: the `finalize` contract paragraph, the post-`finally` decision comment, `_endAndFlush`'s doc (the "destroyed early return" paragraph is gone — state the close-wait guarantee and why the wait never throws), the `LogStreamEntry` rationale, `open()`'s listener rationale (record = first-error-wins ahead of `stream.errored` + the stale-error warning), and `finalizeQuietly`'s catch comment (drop the stale "used to be reached only by" narration); keep the quiet-before-loud ordering hazard paragraph <!-- R4 -->

### Phase 3: Tests

- [x] T004 Rework `'LogWriteStreamRegistry records only the first error a stream emits'` (~line 370 of `packages/device-node/src/device/test/logCaptureProviders.test.ts`) to pin first-error-wins on a genuinely failing stream: two bare emits, then `stream.destroy(...)`, assert `finalize` rejects with the first error and zero live streams <!-- R5 -->
- [x] T005 Add registry test: flushed-cleanly resolves over a stale non-destroying error — bare `emit('error')`, clean write, `finalize` resolves, file content intact, stream untracked, and a captured-sink warning names the output file <!-- R5 -->
- [x] T006 Add registry regression test: close-time error rejects deterministically — override the tracked stream's `_destroy` to fail the close, write + `end()` + await `finish`, then assert `finalize` rejects with the close-time error while `writableFinished` is true <!-- R5 -->
- [x] T007 Add provider-level quiet-first failure-response tests (both platforms, in the existing parameterized block of `logCaptureProviders.test.ts`): unopenable path (recorded `ENOENT`) + `signal-undelivered` child → assert `success: false` matching the SIGINT message and zero live streams <!-- R6 -->

### Phase 4: Verification

- [x] T008 Run the device-node package suite (`npm run build && npm test` scoped to `packages/device-node`); sweep for any other test asserting the old unconditional rejection and update it on the same spec-conformance ground (record which in the PR notes) <!-- R5, R7 -->
- [x] T009 Run the repo-wide gate: `npm run build`, `npm run typecheck`, `npm test` — all green; do not commit anything and do not touch `fab/backlog.md` <!-- R7 -->

## Acceptance

### Functional Completeness

- [x] A-001 R1: `finalize` reaches its success/failure decision only after the tracked stream's `'close'` state on every tracked path, via a never-throwing state-based wait
- [x] A-002 R2: The decision resolves iff `writableFinished && stream.errored === null`, warns-and-resolves on a stale non-destroying recorded error, and otherwise rejects with `entry.error ?? stream.errored` (generic synthesis only when both are null)
- [x] A-003 R4: No doc comment in `logWriteStream.ts` still argues for the unconditional rejection or the `_endAndFlush` destroyed early-return; the new comments state the terminal-state guarantee and pass the deletion test
- [x] A-004 R5: The reworked and new registry tests exist and pass: first-error-wins on a failing stream, flushed-cleanly-resolves with warning, deterministic close-time-error rejection
- [x] A-005 R6: Both platforms have a passing quiet-first failure-response test asserting `success: false` and zero live streams over an errored stream

### Behavioral Correctness

- [x] A-006 R2: Every row of the intake's outcome matrix holds: clean flush resolves; destroying open/write errors reject with the first error; close-time error rejects deterministically; bare-emit-then-clean-flush resolves with a warning; drain-timeout-then-clean-end resolves *(review: first four rows are test-covered; the drain-timeout row holds by inspection — no test exercises the 5 s bound, unchanged from before this change)*
- [x] A-007 R3: A drain rejection still wins over the terminal-state decision (the existing `'stdout exploded'` test passes unchanged), and the drain-timeout truncated-log degradation is unchanged *(review: `_endAndFlush` can no longer throw at all, so the drain rejection's precedence is now structural rather than incidental)*

### Scenario Coverage

- [x] A-008 R5: The close-time-error regression test is deterministic — no sleeps, no timing races; it awaits `finish` before finalizing and the forced close failure is delivered via the `_destroy` seam *(review: 30 consecutive runs of the file, 0 failures)*
- [x] A-009 R6: The quiet-first tests pin the safety invariant (failure response, zero live streams) without asserting a later `finalize` outcome for the same path (the accident stays unpinned)

### Edge Cases & Error Handling

- [x] A-010 R1: An already-closed stream (failed async open) skips the wait and decides immediately; an ended-but-not-yet-closed stream cannot hang the wait
- [x] A-011 R2: The stale-error warning is guarded so a throwing logger sink cannot flip a successful stop into a rejection; existing logger-sink-failure tests stay green *(review: guard verified by inspection; no test drives a throwing sink through the warn path)*

### Code Quality

- [x] A-012 Pattern consistency: New code follows the file's existing structure (guarded log calls, state-checked early returns, rationale-bearing comments) and the test file's existing deterministic-event conventions
- [x] A-013 No unnecessary duplication: The close-wait lives in one place (`_endAndFlush`), reused by every finalize path; no new helper duplicates existing utilities
- [x] A-014 No restatement comments introduced; every rewritten comment carries rationale the code cannot show (deletion test per `fab/project/code-quality.md`), and no rationale comment is deleted without replacement *(review: the rejected-alternative knowledge dropped from `finalize`'s contract paragraph is preserved in `_endAndFlush`'s new close-time-window paragraph, so nothing is unrecoverable)*

## Notes

- Test Integrity (constitution): the rework of the ~line-370 pinning test is spec-conformance test updating — the spec keys failure to "the file is not known to be complete", and after the terminal-state wait a finished-and-closed stream IS known complete. The old rejection assertion is not dropped: it is re-pinned deterministically on the close-time-error scenario, the only production-reachable flushed-then-errored shape.
- The PR should state it supersedes CodeRabbit's PR #173 learning ("the unconditional re-throw is deliberate") on two-reviewer convergence.

## Deletion Candidates

- `packages/device-node/src/device/test/logCaptureProviders.test.ts:383-385` — the comment block above the `finalize rejects with the error a failed open recorded` assertion describes a `_endAndFlush` early return that no longer exists and a resolve-without-the-record outcome that `stream.errored` now prevents; both claims are dead and misleading, so the block should be replaced (not merely trimmed) with the record's remaining role — first-error precedence ahead of `stream.errored`
- `packages/device-node/src/device/test/logCaptureProviders.test.ts:528-531` — the "`finalize` now re-throws a recorded error where it used to resolve, which is what first makes `finalizeQuietly`'s own `Logger.e` reachable" narration is the same stale-history shape T003 deliberately deleted from `finalizeQuietly`'s own catch comment in the source; the surviving mirror in this test is a deletion candidate on the same ground
- `docs/memory/device-node/log-capture.md` Design Decision "The recorded-error rejection is unconditional, with no `writableFinished` guard" (lines ~303-325) — superseded wholesale by this change; also the falsified `_endAndFlush` early-return claims at lines ~78, ~155-158, ~262, ~272 and the frontmatter description's "`finalize` fails the stop on it". Hydrate owns this (plan Non-Goals), listed here so the hydrate agent has the line inventory rather than re-deriving it
- No source symbol, branch, or config became unused: `finished` from `node:stream/promises` is still consumed by `_drain`, and nothing else in the repo references `_endAndFlush` or the removed early return

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | The close wait is a plain `'close'` listener wrapped in a bare Promise, skipped when `stream.closed` — not `events.once(stream, 'close')` and not `finished(stream)` | Both library primitives reject when the stream errors while waiting, violating the intake's explicit "the wait itself should never throw"; a bare listener is the only never-rejecting form and `'close'` is guaranteed by `emitClose: true` (fs default) | S:85 R:90 A:90 D:85 |
| 2 | Confident | The stale-error warning on the warn-and-resolve path is wrapped in the same guarded `try`/`catch` shape as the file's other log calls | The intake mandates warn + resolve; an unguarded `Logger.w` could reject a successful stop through a throwing sink, changing semantics the intake fixed — guarding preserves them and matches the file's established discipline | S:70 R:85 A:85 D:80 |
| 3 | Confident | Flush errors now surface through the terminal-state decision (recorded/`stream.errored`) instead of a `finished(stream)` rejection propagating from the `finally` | `_endAndFlush` must never throw for the close wait to run on every path; a flush error destroys the stream, so the decision rejects with the same error — caller-visible behavior is unchanged, only the throw site moves | S:65 R:80 A:85 D:75 |
| 4 | Confident | The close-time-error test forces the failure via a `_destroy` override (real teardown first, then an errored callback) rather than `stream.destroy(err)` after `finish` | `destroy(err)` after `finish` races auto-destroy's own `destroy()` call and is non-deterministic; `_destroy` is the documented Writable customization seam and reproduces the exact production shape (finish, then close-time error) | S:75 R:90 A:80 D:70 |

4 assumptions (1 certain, 3 confident, 0 tentative).
