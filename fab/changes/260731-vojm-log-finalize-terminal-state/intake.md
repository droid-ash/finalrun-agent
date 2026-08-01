# Intake: Log Finalize Awaits Terminal Stream State

**Change**: 260731-vojm-log-finalize-terminal-state
**Created**: 2026-07-31

## Origin

One-shot `/fab-new` invocation. The user's raw input, abridged to its operative content — this quote is the fullest surviving record; `.history.jsonl` retains only a condensed one-line summary of the command arguments (via `--log-args`):

> Fix a stream-error reporting defect that two independent reviewers flagged and PR #173 deliberately only documented. In `packages/device-node/src/device/logWriteStream.ts`, `entry.error` is never cleared once set, so `finalize` rejects UNCONDITIONALLY — including when the log was flushed completely and `stream.writableFinished` is true. That contradicts the contract written in the same file, which says a log that could not be flushed is a failed stop; here it WAS flushed. Why this is being reopened: an operator-side adversarial review raised it as should-fix; PR #173 chose to document the behaviour and add provider-level failure coverage instead of changing it; CodeRabbit then reviewed #173 and independently rated the same issue at lines 140 and 202 as MAJOR severity under data integrity. Two independent reviewers converging is why it is now being fixed. COMPLICATION: an existing test in `logCaptureProviders.test.ts` currently PINS the inconsistent behaviour — it emits a non-destroying error directly then expects finalize to reject even though the flush succeeds. Per the constitution Test Integrity rule, tests conform to the spec rather than the reverse — updating that test is legitimate if a fully-flushed log is a successful stop; weakening a test merely to make the change pass is not. State plainly which you are doing and why. Read CodeRabbit's reasoning on PR #173 first: it notes the unconditional check rejects a close-time error when the listener records it before finalize completes, and that waiting for the terminal stream state is the alternative — so decide whether a `writableFinished` guard suffices or whether you must await the terminal state properly. ALSO decide with reasons, do not fix blindly: the recorded error is consumed once because finalize deletes the entry in its finally, so `finalizeQuietly` before `finalize` silently discards it — currently safe only by accident of provider call ordering, and untested. Add tests pinning whatever behaviour you land on and verify device-node plus the repo-wide suite stay green. Do NOT commit `fab/backlog.md`.

Key intake-time findings (CodeRabbit's PR #173 review was read in full before this intake was written):

- **CodeRabbit finding 1** (MAJOR, Data Integrity, anchored at `logWriteStream.ts:136-140`): "`fs.WriteStream` sets `writableFinished` and then starts asynchronous auto-destroy. A close callback can report `EIO` after `finalize` skips `_endAndFlush`; the final `entry.error` check can therefore resolve successfully before the listener records the error. Wait for the terminal close/error state on the `writableFinished` path, add a regression test, and update the decision in `docs/memory/device-node/log-capture.md`." So the defect is **two-faced and timing-dependent**: a close-time error recorded *before* the check rejects a fully-flushed log (the contract contradiction the user quotes), and one recorded *after* the check is silently missed (success over a non-durable file). A bare `writableFinished` guard fixes only the first face and makes the second face unconditional — it is not sufficient.
- **CodeRabbit finding 2** (concurrent-stop serialization at `LogCaptureManager`) was **withdrawn by CodeRabbit itself** after verification: "The memory document explicitly accepts the overlapping-stop check-then-act race... I also verified both providers. Each current quiet-first path returns `success: false`. A swallowed recorded error does not produce a successful stop response in these paths."
- The pinning test the user cites now sits at `logCaptureProviders.test.ts:370-386` (`'LogWriteStreamRegistry records only the first error a stream emits'`) — line numbers drifted since the user's reading. It emits two bare non-destroying `stream.emit('error', …)` calls, lets the flush succeed, and asserts `finalize` rejects with the first error — pinning first-error-wins *and* the unconditional rejection in one test.
- The memory DD "The recorded-error rejection is unconditional, with no `writableFinished` guard" (`docs/memory/device-node/log-capture.md`, introduced by PR #173 / change `cjx8`) itself concedes both halves of the argument this change relies on: real errors auto-destroy the stream (so flushed-but-errored is reachable in production only via a close-time error), and a close-time error is recorded with `writableFinished` already true (so a guard drops it). What that DD did not resolve is the race CodeRabbit identified: today the close-time error is observed only if it lands before `finalize`'s check.

## Why

1. **The pain point**: `LogWriteStreamRegistry.finalize` decides success/failure by reading `entry.error` at whatever moment its `finally` completes, instead of after the stream's terminal state. That produces two wrong outcomes from one root cause: (a) a log that flushed completely (`writableFinished === true`) with a stale non-destroying error recorded is reported as a *failed* stop, contradicting the file's own contract ("a log that could not be flushed is a failed stop" — this one *was* flushed); (b) a close-time error (`EIO` from the `close(2)` that auto-destroy performs after `finish`) arriving *after* the check is silently missed — a *successful* stop over a file whose durability the OS just refused to confirm. Face (b) is the data-integrity defect: the CLI copies the log file immediately after the stop resolves.
2. **If not fixed**: stop success/failure for close-time errors stays a race, and the pinned contradiction stays cemented in a test, misleading the next reader into treating either behaviour as designed. Two independent reviewers (operator-side adversarial review: should-fix; CodeRabbit: MAJOR / data integrity) converged on this after PR #173 explicitly deferred it — the deferral decision has been overtaken.
3. **Why this approach**: awaiting the stream's terminal close/error state before deciding removes the race entirely, at which point the success predicate can be made state-based (did the stream finish and close cleanly?) rather than history-based (was an error ever recorded?). A bare `writableFinished` guard was considered and rejected — see Assumptions #1.

## What Changes

### 1. `finalize` awaits the terminal stream state before deciding (`packages/device-node/src/device/logWriteStream.ts`)

`_endAndFlush` currently early-returns on `stream.writableFinished || stream.destroyed`, which is exactly where the close-time window opens (auto-destroy's `close(2)` runs after `finish`). The fix: after the existing drain/end sequence in `finalize`'s `try`/`finally`, wait until the stream has emitted `'close'` (fs.WriteStream always emits it — `emitClose` defaults true — after either `end()` → `finish` → auto-destroy, or `destroy(err)`), so every error the stream will ever deliver has been recorded before the decision runs.

Implementation guidance (apply may refine mechanics, not semantics):

- A state-based wait is the cleaner primitive: `if (!stream.closed) await once(stream, 'close')` (or equivalent). `finished(stream)` from `node:stream/promises` is awkward here — it *rejects* on an errored stream and has premature-close edge cases on already-destroyed streams; the recorded `entry.error` / `stream.errored` already carry the failure, so the wait itself should never throw.
- The wait belongs on every finalize path that reaches a tracked stream (not only the `writableFinished` one) — after `'close'`, terminal state is fully settled for all cases.
- Precedence is preserved: a drain rejection thrown from the `try` still wins (the `finally` still untracks, ends, and now awaits close); the recorded-error decision still runs only when nothing above threw.
- The drain-timeout degradation is untouched: unpipe → end → await close → (no recorded error) → resolve with a possibly-truncated log. Bounding is unchanged; awaiting `'close'` on an ended stream cannot hang.

### 2. New success/failure semantics — state-based, not history-based

After terminal state, `finalize`:

- **Resolves** iff `stream.writableFinished && stream.errored === null` — the stream finished (all data handed to the fd) *and* was not destroyed by any error, including a close-time one. If `entry.error` is set in this state (reachable only via a bare non-destroying `emit('error')` — every real fs error either destroys the stream or is a close-time error, which sets `stream.errored`), log a warning naming the file and the stale error, and resolve: the flush and close both completed cleanly, so the file *is* known to be complete — this is the contract ("a log that could not be flushed is a failed stop") applied literally.
- **Rejects** otherwise, with `entry.error ?? stream.errored` (first-recorded error wins, exactly as today; `stream.errored` is the fallback for a defensive premature-destroy with nothing recorded — apply may synthesize a generic error if both are somehow null in that unreachable state).

Outcome matrix (all after the terminal-state wait, so all deterministic):

| Scenario | `writableFinished` | `stream.errored` | `entry.error` | Outcome |
|---|---|---|---|---|
| Clean flush, clean close | true | null | unset | resolve (today: resolve) |
| Open fails (ENOENT) / write fails (ENOSPC) | false | set | set | reject with first error (today: reject) |
| Close-time error (EIO after finish) | true | set | set | **reject — now deterministic** (today: race — reject or silent success by timing) |
| Bare non-destroying `emit('error')`, clean flush+close | true | null | set | **resolve + warning log** (today: reject — the contract contradiction) |
| Drain timeout, stream ends clean | true | null | unset | resolve, possibly-truncated log (today: same) |

The large doc comments on `finalize` and `_endAndFlush` that currently *argue for* the unconditional rejection (the "a guard on `writableFinished` here would silently drop exactly that error" paragraph and the `_endAndFlush` "destroyed early return" paragraph) must be rewritten to state the new guarantee: the decision runs after the terminal close/error state, so close-time errors are always observed and a cleanly-finished-and-closed stream is a successful stop.

### 3. Test updates (Test Integrity rule — stated plainly)

**This change updates the pinning test to match the spec; it does not weaken a test to make the change pass.** The spec (the contract in `logWriteStream.ts` itself, and the memory Requirement "a log that could not be flushed is a failed stop... because the file is not known to be complete") keys failure to *the file not being known complete*. After the terminal-state wait, a stream that finished and closed cleanly is known complete — rejecting it contradicts the spec, and the constitution's Test Integrity rule directs updating the test to the spec. The rejection previously pinned there is not lost as coverage: it is *re-pinned deterministically* on the close-time-error scenario, which is the only production-reachable flushed-then-errored shape.

Concretely, in `packages/device-node/src/device/test/logCaptureProviders.test.ts`:

- **Rework** `'LogWriteStreamRegistry records only the first error a stream emits'` (currently ~line 370): first-error-wins must stay pinned, but on a *genuinely failing* stream — e.g. emit two errors and destroy the stream (or use two bare emits followed by `stream.destroy(firstError)`), then assert `finalize` rejects with the **first**. Its current secondary assertion (rejection despite a clean flush) moves to the two new tests below.
- **New test — flushed-cleanly resolves over a stale non-destroying error**: bare `emit('error')`, clean write, `finalize` resolves, file content intact, stream untracked. This pins face (a) of the fix.
- **New test — close-time error rejects deterministically** (CodeRabbit's requested regression test): drive a stream to `finish` cleanly, then deliver a destroying error at close time (e.g. force the auto-destroy `close(2)` to fail by stubbing/subclassing, or `stream.destroy(err)` after `finish` — apply picks the most faithful deterministic construction), and assert `finalize` — started *before* the error lands — rejects with it. This pins face (b) and the race closure.
- **Provider-level quiet-first pinning tests** (both platforms, parameterized like the existing block): see §4.
- All existing registry-level and provider-level tests are re-run; any other test asserting the old unconditional rejection is updated on the same spec-conformance ground (state which in the PR).

### 4. `finalizeQuietly`-before-`finalize` consumption — decided: keep once-consumed semantics, pin the safety invariant with tests

Decision (with reasons, per the user's instruction not to fix blindly): **keep** the registry's once-consumed error (entry deleted in `finalize`'s `finally`) and the documented-not-enforced ordering. Rationale:

- CodeRabbit raised serialization and then **withdrew it** after verifying every quiet-first provider path (`startLogCapture` catch, kill-returns-false early return, `_waitForExit` outer catch) already returns `success: false` on its own — no success is ever reported over a swallowed error in sequential flows.
- The memory DD's rejections stand unchanged: tombstoning errored entries reintroduces unbounded growth the per-instance registry exists to avoid; making `finalizeQuietly` preserve entries breaks its "end the stream and drop its entry" contract for every already-failing caller.
- The overlapping stop/abort check-then-act race in `LogCaptureManager` remains an accepted, documented hazard — out of scope here, as it was for #173 and for CodeRabbit's withdrawal.

What changes is the **"untested" half**: add provider-level tests (both platforms) pinning the invariant that makes the hazard safe — a quiet-first path over a stream with a recorded error returns a *failure* response by itself (e.g. `kill()` returning false → early failure return, over an errored stream: assert `success: false` and zero live streams). This pins the safety invariant, **not** the accident — the memory DD's rejection of "a test pinning today's second-stop-over-a-failed-stream success" is about cementing the swallow-then-resolve sequence as a contract, which these tests deliberately do not touch.

### 5. Memory + comment updates (hydrate stage)

- `docs/memory/device-node/log-capture.md`: the DD "The recorded-error rejection is unconditional, with no `writableFinished` guard" is **superseded** — rewritten to record the terminal-state-wait decision, the state-based success predicate, why the bare guard was rejected (drops close-time errors), and why unconditional rejection was rejected (contradicts the flushed-log contract *and* leaves close-time observation racy). The "consumed by the first finalization" DD gets its "untested" clause corrected (now pinned by provider-level tests). The Requirements section's listener/finalize scenarios are updated to the new outcomes (notably the "stream errors twice" scenario and the description-frontmatter's "finalize fails the stop on it" phrasing).
- `logWriteStream.ts` doc comments per §2.
- `LogWriteStreamRegistry.open`'s listener comment ("the record — the thing `finalize` reads to fail the stop") stays accurate but is adjusted to the new decision rule.

### Non-goals

- No change to the `finalize`/`finalizeQuietly` split or to any provider call site ordering.
- No serialization/single-flight guard in `LogCaptureManager` (withdrawn finding; accepted hazard stands).
- No change to drain-timeout bounding or its truncated-log degradation.
- `fab/backlog.md` MUST NOT be committed (explicit user instruction).

## Affected Memory

- `device-node/log-capture`: (modify) supersede the "unconditional recorded-error rejection" Design Decision with the terminal-state-wait decision and state-based success predicate; correct the "consumed by the first finalization" DD's untested-hazard clause (invariant now test-pinned); update the affected Requirement scenarios and the frontmatter description's finalize phrasing.

## Impact

- **Source**: `packages/device-node/src/device/logWriteStream.ts` (only source file with behavior change — `finalize`/`_endAndFlush` and their doc comments).
- **Tests**: `packages/device-node/src/device/test/logCaptureProviders.test.ts` (one reworked test, ~4 new tests across registry + both-platform provider blocks). Existing provider stop tests must stay green — their scenarios (ENOENT open error → `success: false`) are destroying errors, unaffected by the new predicate.
- **Docs**: `docs/memory/device-node/log-capture.md`.
- **Verification**: device-node package suite, then the repo-wide suite (build/typecheck/test per the CI gate), both green.
- **External context**: CodeRabbit holds a learning on PR #173 stating the unconditional re-throw is deliberate; the PR for this change should state explicitly that it supersedes that decision (two-reviewer convergence), so future bot reviews don't flag the fix as contradicting the learning.

## Open Questions

None — the input is highly directive, delegates the two open design decisions explicitly ("decide with reasons"), and both are resolved above with rationale (Assumptions #1–#4).

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Await the terminal close/error state, not a bare `writableFinished` guard | User poses exactly this fork; CodeRabbit recommends the wait; the #173 memory DD itself proves the bare guard drops close-time errors, and the guard leaves the close-time race unfixed — the guard is strictly worse on both faces | S:85 R:55 A:90 D:85 |
| 2 | Confident | Success predicate: resolve iff `writableFinished && stream.errored === null`; stale non-destroying recorded error → warn + resolve; otherwise reject with `entry.error ?? stream.errored` | Applies the file's own contract literally (flushed+closed = known complete); keeps close-time errors failing deterministically; first-error-wins preserved; only reachable resolve-over-recorded-error path is a test-artifact bare emit | S:80 R:50 A:80 D:75 |
| 3 | Certain | Rework the pinning test to the spec (first-error-wins re-pinned on a genuinely failing stream; rejection re-pinned on close-time error) — spec-conformance under the constitution's Test Integrity rule, not test-weakening | Constitution explicitly permits updating tests to match spec; coverage is moved, not dropped — the rejection assertion survives in a deterministic, production-reachable form | S:90 R:70 A:85 D:80 |
| 4 | Confident | Keep once-consumed `finalizeQuietly` semantics and the documented ordering hazard; add provider-level tests pinning that quiet-first paths return failure responses | CodeRabbit withdrew its serialization finding after verifying the invariant; memory DD rejections (tombstone, preserve-entry) stand; the user's "untested" complaint is answered by pinning the safety invariant, not the accident | S:70 R:75 A:70 D:60 |
| 5 | Certain | The user-cited test "lines 304–320" is the first-error-wins test now at lines 370–386 | Only test matching the description (bare non-destroying emit + reject despite successful flush); line drift explained by #173 having appended tests | S:75 R:90 A:90 D:85 |

5 assumptions (2 certain, 3 confident, 0 tentative, 0 unresolved).
