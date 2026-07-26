# Intake: Fix the Session and Log-Sink Cleanup Leaks in `runTests`

**Change**: 260726-gohy-fix-runtests-session-cleanup-leak
**Created**: 2026-07-26

## Origin

Direct follow-up to `260726-vzi3-split-testexecutor-runtests` (PR #154, merged `4962fe2`), where
this bug was found and **deliberately deferred**.

While reviewing #154, CodeRabbit flagged that `runTests` can create a device session and then throw
before the block that releases it. Investigation confirmed the finding was real but **pre-existing**,
not introduced by that refactor — `origin/main` was structurally identical (`goalSession` assigned at
`testRunner.ts:203`, abort check throwing at `:225`, and the `try` whose `finally` performed cleanup
only opening at `:233`). The pipeline's own review stage had independently reached the same
conclusion, describing it as "a preserved pre-existing quirk".

It was deferred because #154's contract was **zero behavior change** — that equivalence is what made
a 685-line restructuring reviewable. Closing the leak alters cleanup semantics on an error path, so
it needed its own change. A four-step fix spec was recorded in that change's `plan.md`; this change
executes it.

> Note: PR #154 was squash-merged at `afce765`, *before* the review-response commit `454e587` landed,
> so that deferred-leak note never reached `main`. It was carried forward with the archive move in
> commit `2e94a16` on this branch, so the historical record is complete.

## Why

**Problem — two distinct resource leaks on early-exit paths.** In `runTests`:

```ts
const goalSession = await prepareRunSession(ctx, checked);
if (ctx.runAborted) {
  throw abortedBeforeExecutionError();     // ← session already exists; never released
}

try {
  await runTestLoop(ctx, checked, effectiveGoals, goalSession);
  return await finalizeRun(ctx);
} finally {
  await cleanupRunResources(ctx, goalSession);   // ← the ONLY cleanup site
}
```

`cleanupRunResources` (`testRunner.ts:499`) does three things: `goalSession.cleanup()`,
`Logger.removeSink(ctx.logSink)` (when set), and `Logger.removeSink(ctx.bufferingSink)`. Because it
runs only from the **inner** `finally`, any throw before that `try` skips all three:

1. **Device-session leak.** If `ctx.runAborted` is true immediately after `prepareRunSession`
   (a SIGINT arriving during device preparation — precisely the window where preparation is slow and
   a user is most likely to hit Ctrl-C), the prepared device session is never cleaned up. That leaves
   real external resources dangling: emulator/simulator state, adb/driver processes, ports.

2. **Log-sink leak (broader).** `Logger.addSink(ctx.bufferingSink)` runs unconditionally near the top
   of `runTests`, but the matching `removeSink` lives in `cleanupRunResources`. So **every** early
   exit — a validation failure, an abort before session prepare, or a `prepareRunSession` failure —
   leaves the sink registered on the module-level `Logger`. Each such call permanently attaches
   another sink and its backing `bufferedLogEntries` array.

**Consequence.** The session leak strands external resources on a path users actually hit. The sink
leak is worse in aggregate for the **test suite**, which calls `runTests` many times in one process:
sinks accumulate across tests, so every later `runTests` call feeds log entries into every earlier
call's buffer. That is latent cross-test interference and unbounded growth in a long-lived process.

**Why it survived.** The abort-after-session-prepare path has **no test coverage** — which is also
why this change must add one, not merely patch the code.

## What Changes

### 1. Restructure `runTests`' cleanup boundaries (`packages/cli/src/testRunner.ts:136-156`)

Move the post-`prepareRunSession` abort check **inside** the `try` that releases the session, and
lift sink removal to the outer `finally` so it runs on every path:

```ts
  try {
    const { checked, effectiveGoals } = await runValidationPhase(ctx);
    if (ctx.runAborted) {
      throw abortedBeforeExecutionError();
    }

    const goalSession = await prepareRunSession(ctx, checked);
    try {
      // moved INSIDE: a session now exists, so it must be released on this path too
      if (ctx.runAborted) {
        throw abortedBeforeExecutionError();
      }
      await runTestLoop(ctx, checked, effectiveGoals, goalSession);
      return await finalizeRun(ctx);
    } finally {
      await releaseSession(goalSession);   // session only
    }
  } finally {
    removeSigintListener();
    if (ctx.logSink) {
      Logger.removeSink(ctx.logSink);
    }
    Logger.removeSink(ctx.bufferingSink);
  }
```

### 2. Narrow `cleanupRunResources` to session release only (`testRunner.ts:499`)

It currently mixes session teardown with sink removal. Reduce it to the session concern (renaming to
something like `releaseSession` is appropriate) and keep its existing swallow-and-warn semantics —
`goalSession.cleanup()` failing MUST still log `Failed to clean up device resources:` and MUST NOT
propagate, since it runs in a `finally` and would otherwise mask the real error.

### 3. Add the missing regression test (`packages/cli/src/testRunner.test.ts`)

At least one test covering **abort after session prepare, before execution**, asserting the session
was released. The file already has the seam: tests override `testRunnerDependencies` members
(e.g. `prepareTestSession` at `:619`), and `addSigintListener` (`:91`) is injectable, so a test can
supply a session whose `cleanup()` sets a flag and an abort listener that fires during preparation.
The existing SIGINT test at `:1103` is the closest model.

The test MUST fail against the current code and pass after the fix — verify that ordering explicitly
rather than assuming it. A second test asserting sink removal on an early-exit path is desirable if
it can be written without brittle coupling to `Logger` internals.

### Behavior that MUST NOT change

- Thrown error identity on both abort paths: `PreExecutionFailureError`, `phase: 'setup'`, message
  `Run aborted before execution.`, `exitCode: 130`.
- Ordering on the **success** path. Today: `finalizeRun` → inner `finally` (session cleanup + sink
  removal) → outer `finally` (`removeSigintListener`). After: `finalizeRun` → inner `finally`
  (session release) → outer `finally` (`removeSigintListener` + sink removal). Nothing reads the
  sinks in between, so this is unobservable — but confirm rather than assume.
- The lazy `reportWriter` contract (`undefined` is meaningful) and `ctx.logSink` being set only by
  `initializeReportWriter` (`:309-312`).
- Everything PR #154 established: the `TestRunContext` per-call local, the phase helpers, and
  #153's `max-depth` hoist with its documented exception-path qualification.

### Out of scope

- The remaining 133 lint warnings (84 `max-lines-per-function` + 49 `complexity`), including the
  untested giants `sessionRunner.ts:286`, `cloud-core/src/submit.ts:70`, `reportWriter.ts:156`.
- Promoting lint rules from `warn` to `error`.
- Test backfill for `report-web` / `cloud-core`; Dependabot; `.gitattributes` lockfile strategy.
- Any change to `prepareRunSession`'s own internal error handling.

## Affected Memory

Probably none, but hydrate MUST verify rather than assume — this changes a resource-lifecycle
contract, which is exactly the kind of thing memory may document.

- `cli/*` memory files describe report-writing and CLI surfaces; `device-node/log-capture.md`
  describes capture lifecycle. Hydrate MUST grep `docs/memory/**` for `runTests`,
  `cleanupRunResources`, session cleanup, and log-sink lifecycle, and update anything that states
  the old (leaking) behavior.
- If nothing documents it, consider whether the durable rule — *a resource acquired before a guard
  must be released by a `finally` that the guard sits inside* — is worth one line, given the
  remaining refactor work will keep restructuring `try`/`finally` boundaries. Keep it tight or skip.

## Impact

- **Modified**: `packages/cli/src/testRunner.ts` (small, localized), `packages/cli/src/testRunner.test.ts`
  (new regression test(s)).
- **Expected diff**: small — a moved guard, a moved pair of `removeSink` calls, a narrowed helper,
  plus test additions.
- **Risk**: low-to-moderate. The code change is small, but it is a **deliberate behavior change** on
  error paths in the CLI's main entry point, and cleanup now runs where it previously did not. The
  348-test suite (115 in `cli`) is the safety net.
- **Expected outcome**: **348 → 349+ tests** (this change ADDS tests — unlike the last three, the
  count SHOULD rise), lint **133 warnings / 0 errors** unchanged or better, build green.

## Open Questions

- Should the sink-removal fix ship together with the session fix, or separately? (Assumed together —
  they share one root cause and one code region; see Assumptions #4.)
- Is a sink-leak regression test worth the coupling to `Logger` internals? (Assumed desirable but
  optional; the session test is mandatory — see Assumptions #6.)

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Fix the leak now, as its own change | Deferred from #154 precisely so it could be done separately; a four-step spec was recorded in that plan | S:95 R:85 A:90 D:95 |
| 2 | Certain | The bug is real and pre-existing, not introduced by #154 | Verified against `origin/main`: session assigned `:203`, abort throws `:225`, cleanup `try` opens `:233` — same window; review called it a preserved pre-existing quirk | S:90 R:85 A:95 D:95 |
| 3 | Certain | This change intentionally CHANGES behavior (cleanup now runs on paths it previously skipped) | It is a bug fix, not a refactor; the no-behavior-change rule from #153/#154 does not apply, but error identity and exit codes must be preserved | S:90 R:70 A:90 D:90 |
| 4 | Confident | Fix the session leak and the sink leak together | Same root cause (cleanup bound to the inner `finally`), same ~20-line region; splitting would mean touching the same code twice | S:75 R:80 A:85 D:80 |
| 5 | Certain | A regression test for abort-after-session-prepare is mandatory | The absence of coverage is why the leak survived; fixing without a test invites regression. The DI seam already supports it | S:90 R:85 A:90 D:90 |
| 6 | Confident | A sink-leak test is desirable but optional | Asserting sink removal may couple to `Logger` internals; the session test is the load-bearing one | S:70 R:85 A:80 D:75 |
| 7 | Certain | Preserve the thrown error identity exactly (`PreExecutionFailureError`, `setup`, same message, exit 130) | Callers and tests depend on exit code 130 for abort; only cleanup should change | S:90 R:75 A:95 D:95 |
| 8 | Certain | Preserve `goalSession.cleanup()`'s swallow-and-warn semantics | It runs in a `finally`; propagating would mask the original error | S:85 R:80 A:95 D:90 |
| 9 | Confident | Test count should INCREASE (348 → 349+) | Unlike the prior three changes, this one adds tests; a flat count means the regression test was not actually added | S:80 R:90 A:85 D:85 |
| 10 | Confident | Hydrate must actively verify memory, not assume none | This alters a resource-lifecycle contract, the kind of thing memory may document | S:70 R:85 A:80 D:75 |

10 assumptions (7 certain, 3 confident, 0 tentative, 0 unresolved).
