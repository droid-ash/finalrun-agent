# Intake: Provider-Level Log-Stop Failure Test Coverage

**Change**: 260731-cjx8-provider-log-stop-test-coverage
**Created**: 2026-07-31

## Origin

One-shot `/fab-new` invocation carrying an independent adversarial review finding against PRs #168–#172. The user's raw input (condensed; full text in `.history.jsonl`):

> Close a test-coverage gap that was proven by mutation, in packages/device-node. PR #168 fixed a real defect where stopping log capture reported success over a log file that was never written. All 7 tests it added drive LogWriteStreamRegistry directly, and all 8 pre-existing provider tests use a good writable path. So no test ever puts a FAILING write stream through stopLogCapture, and the caller-visible outcome of the fix is completely unpinned. Proof: replacing `finalize` with `finalizeQuietly` at AndroidLogcatProvider.ts:157 and IOSLogProvider.ts:135 — which restores exactly the defect #168 fixed — leaves all 120 device-node tests green. REQUIRED: add provider-level coverage so that mutation would fail. Verify the new test actually kills the mutation (apply it, confirm the test fails, revert with git checkout, confirm clean status). Per the constitution Test Integrity rule, append only — do not modify or weaken any existing test. ALSO ASSESS with judgement: (a) logWriteStream.ts:172–174 never clears `entry.error`, so `finalize` rejects unconditionally once an error is recorded even when the flush succeeded and `writableFinished` is true, contradicting the contract at lines 133–136 — an existing test (logCaptureProviders.test.ts:304–320) pins the inconsistent behaviour; (b) the recorded error is consumed once (finalize deletes the entry in its `finally`), so a `finalizeQuietly` before `finalize` silently discards it — safe only by accident of call ordering and untested. Fix or document each, and state which and why. Do NOT commit or `git add fab/backlog.md` under any circumstance — it is intentionally untracked scratch; the git-pr expected-area guard would otherwise stage untracked files under fab/.

Key decisions from intake analysis (verified against the working tree, see Assumptions): the mutation-proof claim checks out structurally; `createUnopenableFilePath()` already exists in the target test file (line 115) and MUST be reused; both assessment items resolve to "keep behaviour, document" rather than code changes to `logWriteStream.ts`.

## Why

1. **The pain point**: PR #168 (`260730-zga4` / `260730-eyvt`) fixed a defect where `stopLogCapture` reported success over a log file that was never written — `finalize` now re-throws the error `open()`'s listener recorded, and the providers' success path converts that rejection into `DeviceNodeResponse { success: false }`. But the fix's *caller-visible outcome* — a stop over a failed stream reports `success: false` — is pinned by no test. The 7 registry tests added by #168 (logCaptureProviders.test.ts:226–407) drive `LogWriteStreamRegistry` directly, and all 8 provider tests (the `for (const platform of ['Android', 'iOS'])` loop, lines 120–224) use `createOutputFilePath()`, a good writable path. No test ever puts a failing write stream through a provider's `stopLogCapture`.

2. **The consequence**: the load-bearing distinction between `finalize` (throws — the success path's call at `AndroidLogcatProvider.ts:157` and `IOSLogProvider.ts:135`) and `finalizeQuietly` (swallows — the already-failing paths' call) is mutation-invisible. Replacing `finalize` with `finalizeQuietly` at those two call sites — which restores exactly the defect #168 fixed — leaves all 120 device-node tests green (mutation run by the adversarial reviewer). Any future refactor of the providers can silently reintroduce the defect, and nothing in CI would notice. A truncated/unwritten device log raises no error anywhere downstream — a short log reads as a quiet device — so the test suite is the *only* place this defect can ever be caught.

3. **Why this approach**: a provider-level test that opens a capture against an unopenable path and asserts the stop response reports `success: false` pins the caller-visible contract (the `DeviceNodeResponse`), not the registry internals — which is precisely the layer the mutation shows is uncovered. Killing the mutation is the acceptance proof: apply the two-line mutation, the new test must fail; revert, it must pass.

## What Changes

### 1. New provider-level failing-stream stop tests (REQUIRED)

**File**: `packages/device-node/src/device/test/logCaptureProviders.test.ts` — append-only; no existing test is modified or weakened (constitution Test Integrity rule, reinforced by the user).

Add one parameterized test per platform (Android + iOS — a new `for (const platform of ['Android', 'iOS'] as const)` block mirroring the existing one, reusing its `createProvider`-style construction with `execFileStub`/`spawnStub`/`FakeChildProcess`):

- **GIVEN** a provider started against `await createUnopenableFilePath()` — the existing helper at line 115 (a path whose parent directory does not exist, so `fs.createWriteStream` fails its async `open(2)` with ENOENT). `startLogCapture` succeeds: the ENOENT arrives as an `error` event after `open()` returns. **Reuse this helper — do not write a new one** (user checked; it exists).
- **WHEN** `stopLogCapture` runs with the default `'exits'` fake-child behaviour (SIGINT lands, child exits, `stdout` ended so the drain reaches EOF).
- **THEN** the stop response asserts `success === false` (the recorded ENOENT makes `finalize` reject; the provider's outer catch converts it to a failure response), the message reflects the stop error (e.g. matches `/ENOENT/`), and `liveStreamCount(providerRegistry(provider)) === 0` (the entry is untracked on every path).

Mechanics the test must respect (from reading the code):

- The write stream's `error` event must have fired before the stop asserts on the recorded error. Await it deterministically (e.g. `await once(stream-bearing event source)` is not available at provider level — instead await the registry-visible effect or a `setImmediate`/`once`-based settle; the registry tests use `once(stream, 'error')` but the provider owns the stream privately). The concrete synchronization technique is an apply-time decision; what is REQUIRED is that the test is deterministic, not sleep-based flakiness.
- Piping `LOG_PAYLOAD` into a destroyed stream is unnecessary; the test needs no payload — the defect is about the *error*, not the bytes.
- **Placement**: the existing test at lines 373–407 is *deliberately LAST in the file* (its header comment explains a throwing-sink failure mode that must not cascade into later tests). New tests MUST be inserted **before** it — right after the existing platform loop (after line 224) is the natural spot. Inserting between existing tests does not modify any existing test.

### 2. Mutation-kill verification (REQUIRED, procedural — no committed artifact)

After the new tests pass:

1. Apply the mutation: change `finalize` → `finalizeQuietly` at `AndroidLogcatProvider.ts:157` and `IOSLogProvider.ts:135` (the success-path finalize calls only).
2. Run the device-node tests (`npm test` in `packages/device-node`, which runs `node ../../scripts/run-node-tests.mjs`). The two new tests MUST fail; if they stay green the test does not pin the contract and must be reworked.
3. Revert the mutation with `git checkout -- packages/device-node/src/device/AndroidLogcatProvider.ts packages/device-node/src/device/IOSLogProvider.ts` and confirm `git status` is clean (modulo this change's own `fab/changes/` artifacts and intentionally-untracked files) before proceeding.
4. Re-run the tests to confirm all green post-revert.

### 3. Assessment item A — `finalize`'s unconditional recorded-error rejection: KEEP, document (no code change)

`logWriteStream.ts:172–174` re-throws `entry.error` unconditionally — even if `_endAndFlush` completed and `stream.writableFinished` is true. The user flags this as contradicting the contract prose ("a log that could not be flushed is a failed stop") and notes a `writableFinished` guard would align code with contract, while the existing test at logCaptureProviders.test.ts:304–320 pins the unconditional behaviour (it `emit`s errors directly, leaving the stream undestroyed, so the flush succeeds and only the recorded error can reject).

**Decision: keep the unconditional rejection; document the reasoning. Do not add a `writableFinished` guard.** Reasoning:

- **The contradicting state is unreachable in production.** `fs.WriteStream` has `autoDestroy: true`: every *real* `error` (ENOENT on open, ENOSPC on write) destroys the stream, so `writableFinished` can never become true after a genuine error. The flush-succeeded-with-recorded-error state exists only via a bare `stream.emit('error', …)` — which is exactly how the pinning test constructs it, because two real failures cannot be ordered deterministically (its own comment, lines 309–314).
- **Conservative failure is the safer contract.** An `error` event on the stream means the file is *not known to be complete* — the actual invariant the callers need (the CLI copies the file immediately after the stop). Rejecting on any recorded error errs toward a false failure of a diagnostic artifact; a guard errs toward a false success over a possibly-corrupt file, which is the exact shape of the original #168 defect.
- **Test Integrity.** The guard would flip the outcome of the existing test at 304–320 (`assert.rejects(...)` would resolve), forcing a modification of an existing test — prohibited for this change (append-only), and rightly so: that test pins first-error-wins *and* the rejection.
- The "contradiction" is between code and one reading of the docstring prose, not between code and any reachable behaviour. The cheap alignment is one clarifying sentence in the `finalize` doc comment (a rationale claim passing the deletion test): a recorded error rejects even when the flush later succeeded, because an errored stream's contents are not trustworthy and the only reachable errored states are auto-destroyed anyway. Whether to add that sentence or leave the existing prose (which already says "That holds for an error open's listener recorded long before this call") is an apply-time judgement — the existing sentence arguably already covers it, and adding redundant prose has its own cost.

### 4. Assessment item B — recorded error consumed once (quiet-then-loud ordering): DOCUMENT, do not fix

`finalize` deletes the registry entry in its `finally` (`logWriteStream.ts:161`), so the recorded error is consumed by whichever caller finalizes first. A `finalizeQuietly` call *before* a `finalize` for the same path would log-and-swallow the error, leaving the later `finalize` to find an untracked path and resolve — success over a possibly-unwritten file. Today this cannot happen, but only by call ordering:

- In both providers' `stopLogCapture`, `finalize` (success path) always runs before the catch-path `finalizeQuietly`; the quiet-first paths (start failure, signal-undelivered early return) all return `success: false` themselves, so no success is ever reported over a swallowed error.
- The one sequence that *could* reach quiet-then-loud — a failing stop followed by a second stop for the same file — reports `success: true` on the second stop (untracked path resolves). This is reachable at provider level but guarded upstream: `LogCaptureManager`'s `_stoppedTestCases` set prevents double-stop per test case, and the existing "tolerates a second stop" test (lines 159–178) pins second-stop-success for the *good-path* case only.

**Decision: document the ordering invariant; no code change.** Reasoning: any "fix" is a redesign with real costs — keeping errored entries as tombstones leaks them (the registry's whole design GCs entries with their owner; see the memory Design Decision rejecting a module-level registry for exactly this), and making `finalizeQuietly` preserve the entry breaks its "end the stream and drop its entry" contract that the leak-prevention paths rely on. The hazard is real but currently unreachable through the manager, and the cost of the fix exceeds the risk. Documentation lands in two places:

1. A short rationale comment on `finalize`'s `finally` (or `finalizeQuietly`'s doc comment) stating the invariant: *the recorded error is consumed by the first finalization; callers that need the error surfaced must call `finalize` before any `finalizeQuietly` for the same path — the providers' call ordering and `LogCaptureManager`'s stopped-set are what currently guarantee this.* This passes the deletion test (a cross-file coupling not recoverable from the code in front of the reader).
2. The `device-node/log-capture` memory file (hydrate stage) records the same invariant under the finalization requirement.

No new test pins the accidental behaviour — a test asserting "second stop over a failed stream reports success" would cement the accident as a contract, which is worse than leaving it documented as an accepted hazard.

## Affected Memory

- `device-node/log-capture`: (modify) add the provider-level failing-stream coverage to the finalization contract's test surface; record the once-consumed recorded-error ordering invariant (item B) and the keep-unconditional-rejection decision (item A) as Design Decisions.

## Impact

- `packages/device-node/src/device/test/logCaptureProviders.test.ts` — append two parameterized tests (Android/iOS) before the deliberately-last test; no existing test modified.
- `packages/device-node/src/device/logWriteStream.ts` — at most comment-only edits (item B's ordering-invariant rationale comment; possibly one clarifying sentence for item A). **No behavioural change to any source file.**
- `AndroidLogcatProvider.ts` / `IOSLogProvider.ts` — touched only transiently during mutation verification; reverted via `git checkout`; zero net diff.
- Test count goes 120 → 122; all existing tests must stay green throughout.
- **Ship-stage constraint**: `fab/backlog.md` MUST NOT be committed or `git add`ed under any circumstance — it is intentionally untracked scratch. The `/git-pr` expected-area guard would otherwise stage untracked files under `fab/`; the ship step must stage explicitly around it.

## Open Questions

- None. The input is fully specified; the two judgement calls (items A and B) are resolved above with reasoning, as requested.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Reuse the existing `createUnopenableFilePath()` helper (logCaptureProviders.test.ts:115) for the new provider tests | User instructed to check for it; verified present in the working tree — writing a duplicate would violate the project's own anti-pattern list | S:95 R:90 A:100 D:95 |
| 2 | Certain | New tests are appended as a second platform-parameterized loop placed before the deliberately-last test (lines 373–407), not after it | That test's header comment mandates last-in-file placement to contain a throwing-sink failure mode; inserting before it modifies no existing test | S:85 R:90 A:95 D:90 |
| 3 | Confident | Item A: keep `finalize`'s unconditional recorded-error rejection; no `writableFinished` guard; at most a clarifying doc sentence | `autoDestroy` makes the contradicting state unreachable with real errors; a guard flips the existing pinning test (304–320), which is append-only-prohibited; conservative failure matches the "not known to be complete" invariant the CLI copy depends on | S:80 R:60 A:85 D:70 |
| 4 | Confident | Item B: document the once-consumed recorded-error ordering invariant (code comment + memory); no redesign, no test pinning the accident | Hazard is unreachable through `LogCaptureManager`'s stopped-set today; tombstone/preserve-entry fixes reintroduce the leak the per-instance registry design exists to prevent; user explicitly allowed "fix or document, your call" | S:80 R:65 A:80 D:65 |
| 5 | Confident | The new test asserts `success === false`, a message matching the stop error (ENOENT), and `liveStreamCount === 0`; the exact async-settle technique for the stream's `error` event is left to apply | The response fields are the caller-visible contract the mutation proof targets; the synchronization detail is a test-mechanics choice with several deterministic options, all reversible | S:75 R:80 A:75 D:60 |
| 6 | Certain | Mutation-kill verification is procedural: apply the two-line mutation, confirm the new tests fail, revert via `git checkout`, confirm clean status, re-run green | Explicit user requirement restated verbatim; no interpretation needed | S:95 R:95 A:95 D:95 |

6 assumptions (3 certain, 3 confident, 0 tentative, 0 unresolved).
