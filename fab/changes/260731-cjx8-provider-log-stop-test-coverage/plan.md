# Plan: Provider-Level Log-Stop Failure Test Coverage

**Change**: 260731-cjx8-provider-log-stop-test-coverage
**Intake**: `intake.md`

## Requirements

### device-node: Provider-level failing-stream stop coverage

#### R1: A stop over a failed write stream is pinned at the provider level

`packages/device-node/src/device/test/logCaptureProviders.test.ts` MUST gain one parameterized test per platform (Android + iOS — a new `for (const platform of ['Android', 'iOS'] as const)` block mirroring the existing one, reusing its `createProvider`-style construction with `execFileStub`/`spawnStub`/`FakeChildProcess`) that pins the caller-visible outcome of PR #168's fix: a `stopLogCapture` over a write stream whose asynchronous `open(2)` failed reports `success: false`.

The test MUST reuse the existing `createUnopenableFilePath()` helper (line 115) — no duplicate helper. It MUST await the stream's `error` event deterministically (no sleep-based settling) before stopping. The changes MUST be append-only with respect to existing tests: no existing test is modified or weakened (constitution Test Integrity rule), and the new block MUST be inserted **before** the deliberately-last test (its header comment mandates last-in-file placement) — right after the existing platform loop is the natural spot.

- **GIVEN** a provider started against `await createUnopenableFilePath()` (start succeeds — the ENOENT arrives as an `error` event after `open()` returns)
- **WHEN** the stream's recorded `error` has been awaited deterministically and `stopLogCapture` runs with the default `'exits'` fake-child behaviour (`stdout` ended so the drain reaches EOF)
- **THEN** the stop response asserts `success === false`, its message matches `/ENOENT/`, and `liveStreamCount(providerRegistry(provider)) === 0`

#### R2: The new tests kill the finalize→finalizeQuietly mutation

The new provider-level tests MUST fail when the success-path `finalize` call is mutated to `finalizeQuietly` at `AndroidLogcatProvider.ts` (~line 157) and `IOSLogProvider.ts` (~line 135) — the mutation that restores exactly the defect #168 fixed. Verification is procedural (no committed artifact): apply the mutation, run the device-node tests, confirm the new tests fail; revert with `git checkout -- packages/device-node/src/device/AndroidLogcatProvider.ts packages/device-node/src/device/IOSLogProvider.ts`, confirm `git status` shows the providers clean, re-run and confirm all green.

- **GIVEN** the new tests pass against the unmutated providers
- **WHEN** `finalize` → `finalizeQuietly` is applied at both success-path call sites and the suite re-runs
- **THEN** the two new tests fail (and only source-mutation-caused failures appear); after `git checkout` revert, the working tree providers are clean and the full suite is green again

#### R3: Item A — `finalize`'s unconditional recorded-error rejection is kept and documented

`logWriteStream.ts` MUST keep the unconditional `entry.error` re-throw (no `writableFinished` guard — a guard would flip the existing pinning test at logCaptureProviders.test.ts:304–320, prohibited by append-only Test Integrity, and would err toward false success over a possibly-corrupt file, the exact shape of the #168 defect). The only permitted edit is comment-only: at most one clarifying sentence in `finalize`'s doc comment stating that a recorded error rejects even when the flush later succeeded, because an errored stream's contents are not trustworthy and the only errored states reachable with real errors are auto-destroyed anyway (`fs.WriteStream` has `autoDestroy: true`).

- **GIVEN** the change is complete
- **WHEN** `logWriteStream.ts` is diffed against its pre-change state
- **THEN** no behavioural change exists — the diff is comment-only — and the unconditional rejection remains

#### R4: Item B — the once-consumed recorded-error ordering invariant is documented, not fixed

`logWriteStream.ts` MUST gain a short rationale comment (on `finalizeQuietly`'s doc comment or `finalize`'s `finally`) stating the invariant: the recorded error is consumed by the first finalization (`finalize` deletes the entry in its `finally`), so a `finalizeQuietly` before a `finalize` for the same path silently discards it; callers that need the error surfaced must call `finalize` before any `finalizeQuietly` for the same path — the providers' call ordering and `LogCaptureManager`'s stopped-set are what currently guarantee this. No redesign (tombstones/preserved entries reintroduce the leak the per-instance registry design prevents), and no new test pins the accidental second-stop-over-failed-stream behaviour.

- **GIVEN** the change is complete
- **WHEN** a reader encounters `finalizeQuietly`/`finalize`
- **THEN** the cross-file ordering invariant is stated in a comment that passes the deletion test, and no code path in `logWriteStream.ts` behaves differently

### Non-Goals

- No behavioural change to `logWriteStream.ts`, `AndroidLogcatProvider.ts`, or `IOSLogProvider.ts` (providers touched only transiently during mutation verification; zero net diff)
- No test pinning the quiet-then-loud second-stop accident — that would cement an accident as a contract
- No modification of any existing test (append-only)
- Never `git add`/commit anything in this stage; `fab/backlog.md` is never touched

## Tasks

### Phase 2: Core Implementation

- [x] T001 Add the provider-level failing-stream stop tests to `packages/device-node/src/device/test/logCaptureProviders.test.ts`: a small structural helper to reach the tracked stream (mirroring `providerRegistry`/`liveStreamCount`) plus a new `for (const platform of ['Android', 'iOS'] as const)` block, inserted after the existing platform loop and before the first registry test (so the deliberately-last test stays last). Each test: start against `createUnopenableFilePath()`, `await once(trackedStream, 'error')`, end `stdout`, stop, assert `success === false`, message matches `/ENOENT/`, `liveStreamCount === 0`. Append-only — no existing test touched. <!-- R1 -->
- [x] T002 [P] Add one clarifying sentence to `finalize`'s doc comment in `packages/device-node/src/device/logWriteStream.ts` (item A rationale: recorded error rejects even when the flush succeeded; comment-only). <!-- R3 -->
- [x] T003 [P] Add the once-consumed ordering-invariant rationale comment to `finalizeQuietly`'s doc comment in `packages/device-node/src/device/logWriteStream.ts` (item B; comment-only). <!-- R4 -->

### Phase 3: Integration & Edge Cases

- [x] T004 Rebuild and run `npm test` in `packages/device-node`; confirm 122 tests, all green, and that the pre-existing 120 are unchanged. <!-- R1 -->
- [x] T005 Mutation-kill verification: apply `finalize` → `finalizeQuietly` at `AndroidLogcatProvider.ts` success-path call (~line 157) and `IOSLogProvider.ts` (~line 135), rebuild, run tests, confirm the two new tests FAIL; revert with `git checkout -- packages/device-node/src/device/AndroidLogcatProvider.ts packages/device-node/src/device/IOSLogProvider.ts`, confirm `git status` shows the providers clean, rebuild, re-run tests, confirm all 122 green. Capture the failing output as evidence. <!-- R2 -->

## Execution Order

- T001 blocks T004; T004 blocks T005
- T002/T003 are comment-only and can run alongside T001

## Acceptance

### Functional Completeness

- [x] A-001 R1: Two new parameterized provider tests (Android + iOS) exist in `logCaptureProviders.test.ts`, reuse `createUnopenableFilePath()`, and pass against the unmutated providers
- [x] A-002 R3: `finalize`'s unconditional recorded-error rejection is unchanged; item A is addressed by at most one clarifying doc sentence
- [x] A-003 R4: The once-consumed ordering invariant is documented in `logWriteStream.ts` as a rationale comment passing the deletion test

### Behavioral Correctness

- [x] A-004 R1: The new tests assert the caller-visible contract — `success === false`, message matching `/ENOENT/`, `liveStreamCount === 0` — not registry internals beyond the established structural-access pattern
- [x] A-005 R2: With the two-site `finalize` → `finalizeQuietly` mutation applied, the new tests fail; after `git checkout` revert the providers are clean and the full suite is green (procedural evidence reported)

### Scenario Coverage

- [x] A-006 R1: The tests await the stream's `error` event deterministically (no sleeps/arbitrary timeouts) before stopping, and use the default `'exits'` fake-child behaviour with `stdout` ended

### Edge Cases & Error Handling

- [x] A-007 R1: Test changes are append-only — no existing test modified or weakened; the deliberately-last test (throwing-sink) remains last in the file

### Removal Verification

- [x] A-008 R3: No `writableFinished` guard was added and no behavioural diff exists in `logWriteStream.ts` (comment-only edits)

### Code Quality

- [x] A-009 Pattern consistency: New tests follow the file's existing conventions (structural private-state access helpers, `once`-based awaits, platform-parameterized loop shape)
- [x] A-010 No unnecessary duplication: `createUnopenableFilePath()` and the existing stub helpers are reused; no duplicate helpers written
- [x] A-011 Comment content: New comments carry rationale/coupling information that passes the deletion test (no restatement comments)

### Review Verification (2026-07-31)

Evidence recorded by the review stage:

- Clean rebuild (`npm run build`) + `npm test` in `packages/device-node`: **122 tests, 122 pass, 0 fail** — both new tests named in the output (A-001, A-004).
- `git diff --numstat`: `logCaptureProviders.test.ts` **66 added / 0 deleted** (strictly insertion-only, A-007); `logWriteStream.ts` **17 added / 1 deleted**, the single deletion being one JSDoc line replaced by an extended version of the same prose — comment-only, no behavioural diff (A-002, A-008). The deliberately-last throwing-sink test remains last in the file.
- Mutation kill re-run independently: `finalize` → `finalizeQuietly` at `AndroidLogcatProvider.ts:157` and `IOSLogProvider.ts:135` → **120 pass / 2 fail**, and the two failures are exactly the two new tests. Reverted with `git checkout --`; `git status` shows both providers clean; rebuild + re-run → **122/122 green** (A-005).
- Determinism (A-006): `open()` is the last statement before `startLogCapture` returns on the test's path, and the `fs.open` completion is a macrotask, so no `error` event can precede the `once(trackedStream(...), 'error')` attach. No sleeps or timeouts.
- `npx eslint` on both changed files: clean. (`prettier --check` flags `logCaptureProviders.test.ts`, but the sole violation is the pre-existing `spawnStub` cast at lines 93–98 — present on `HEAD` and untouched by this change; no CI job runs prettier.)
- A-010 checked on the item's own terms: `createUnopenableFilePath()` and every module-level stub helper are reused, and no duplicate *helper* was written. The per-loop `createProvider` arrow function is duplicated verbatim (lines 242–251 vs 121–130), which `plan.md` R1 explicitly prescribed ("reusing its `createProvider`-**style** construction"); it is reported as a should-fix rather than an acceptance failure.

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- None — this change adds test coverage and rationale comments without making existing code redundant. Specifically checked: the seven registry-level tests added by PR #168 (`logCaptureProviders.test.ts:292–473`) are **not** superseded by the new provider-level tests — they pin registry contracts the provider tests cannot reach (listener attachment at `open()` return, first-error-wins, `finalizeQuietly`'s resolve-and-log, the throwing-`Logger`-sink escape paths), while the new tests pin only the caller-visible `DeviceNodeResponse`. No source symbol, branch, or config became unused.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Await the failed open deterministically via structural access to the registry's tracked entry (`_streams.get(path).stream`) + `await once(stream, 'error')` | Intake left the settle technique to apply but required determinism; the file already reads private state structurally (`providerRegistry`, `liveStreamCount`) and its registry tests already use `once(stream, 'error')` — this composes both established patterns with zero new machinery | S:80 R:90 A:90 D:85 |
| 2 | Confident | Item A: add the single clarifying sentence to `finalize`'s doc comment rather than leaving the existing prose | Intake explicitly weighed both and called it an apply-time judgement; the existing sentence covers errors recorded "long before this call" but not the flush-succeeded case the pinning test constructs, so one sentence carries non-recoverable rationale (autoDestroy reachability) and passes the deletion test | S:70 R:85 A:80 D:65 |
| 3 | Certain | Item B's invariant comment lands on `finalizeQuietly`'s doc comment (with a pointer from the consumption site) rather than inside `finalize`'s `finally` | Intake offered either location; `finalizeQuietly` is the call whose early placement triggers the hazard, so its doc is where the reader who could misorder the calls looks first | S:75 R:90 A:85 D:75 |
| 4 | Confident | The new tests do not write `LOG_PAYLOAD` into the failed stream | Intake states the payload is unnecessary — the defect is about the error, not the bytes; the errored stream auto-unpiped, so bytes would go nowhere and only add noise | S:85 R:90 A:85 D:80 |

4 assumptions (2 certain, 2 confident, 0 tentative).
