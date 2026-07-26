# Intake: Split the Two Largest Well-Tested Functions

**Change**: 260726-vzi3-split-testexecutor-runtests
**Created**: 2026-07-26

## Origin

Fourth change in the code-quality initiative, and the second to touch application code:

1. `260724-gl51` (PR #151) — first PR test gate + four code-quality principles as ESLint `warn` rules.
2. `260725-358i` (PR #152) — committed lockfile, `npm ci`, reproducible installs.
3. `260725-983g` (PR #153) — cleared 16 warnings (156 → 140); `no-unused-vars` and `max-depth` now
   **zero tree-wide**.

The remaining **140 warnings** are entirely `max-lines-per-function` (87) and `complexity` (53) —
the two rules that still block promoting the rule set from `warn` to `error`.

> User direction: "that is merged, plan the next now, do a rebase with main", then selected
> **"Two biggest, well-tested"** from the scoping options — refactor `TestExecutor.executeGoal` and
> `testRunner.runTests`, using their existing tests as the safety net, rather than the broader sweep
> or the characterization-test-first route.

**Why these two.** They are the worst offenders on *both* metrics simultaneously, and — critically —
both already have real test coverage, so no characterization tests need to be written first:

| Function | Lines | Complexity | Existing tests |
|----------|-------|------------|----------------|
| `packages/goal-executor/src/TestExecutor.ts:230` `executeGoal` | **405** | 42 | `TestExecutor.test.ts` — 7 |
| `packages/cli/src/testRunner.ts:101` `runTests` | **280** | **46** (highest in repo) | `testRunner.test.ts` — 22 |

The three other giants — `sessionRunner.ts:286` (219 lines), `cloud-core/src/submit.ts:70` (175),
`reportWriter.ts:156` (156) — have **zero** tests and are deliberately excluded; refactoring them
requires characterization tests first, which is a separate change.

## Why

**Problem.** These two functions are the least maintainable code in the repository. `executeGoal` is
a 405-line method wrapping the entire goal-execution iteration loop; `runTests` is a 280-line
function with a cyclomatic complexity of 46 — nearly four times the agreed ceiling of 12. Both are
central execution paths that every run passes through.

**Consequence if not fixed.** A complexity-46 function has an enormous number of distinct paths,
which is precisely why the 6 stale CLI tests and the dead `formatSection` went unnoticed for months
in this area of the codebase — nobody can hold the whole thing in their head to notice drift. These
two functions are also the single biggest blocker to the initiative's endpoint: the rules cannot be
promoted from `warn` to `error` while any violation remains, and these are the hardest ones.

**Why now, and why this is safe.** The previous change proved the loop (gate → fix → green) works,
and deliberately took only the zero-risk warnings. This change takes the highest-value ones that are
still protected by existing tests: 29 tests across the two areas, inside a 348-test suite. Extracting
well-named helpers from a long function is the standard, well-understood remedy for both rules at
once — one restructuring clears a `max-lines-per-function` *and* a `complexity` warning per function.

## What Changes

### 1. `packages/goal-executor/src/TestExecutor.ts` — split `executeGoal` (405 lines, complexity 42)

The method's body is a single `for (let iteration = 1; iteration <= maxIterations; iteration++)`
loop containing every phase of one execution step. The decomposition should **keep the loop in
`executeGoal`** and extract each phase into a private method, so the top-level method reads as the
sequence of phases it actually is.

Local state accumulated across iterations that MUST keep exactly its current semantics:

- `history` (string, appended per iteration)
- `remember` (string[], replaced/extended per iteration)
- `consecutiveTransientCaptureFailures` (counter, reset and incremented on specific paths)
- `this._aborted` checks and their early-exit behavior
- `stepTrace` / `StepTraceBuilder(iteration)` construction and the aggregation of planner +
  grounder LLM calls per step

**The central design risk is state threading.** Each extracted helper must either receive and return
the state it mutates, or operate on an explicit per-run (per-call) context object — `history`,
`remember`, and `consecutiveTransientCaptureFailures` persist across the whole invocation, not a
single iteration, so the context's lifetime is the call, not the loop body. Converting an
accumulating local into a field on the class, or into a shared mutable object with different
lifetime, would be a behavior change even if tests pass. Prefer explicit parameters and return
values over new instance fields.

### 2. `packages/cli/src/testRunner.ts` — split `runTests` (280 lines, complexity 46)

`runTests` runs the whole CLI test-run lifecycle in one function: logger init, workspace resolution,
report-run directory setup, host preflight, the per-test execution loop, report writing, and summary
construction. Extract those phases into helpers (module-private functions are fine — they need not
be exported).

State that MUST keep its exact semantics: `testResults`, `encounteredFailure`, `reportWriter`
(created lazily; `undefined` is meaningful), `runDir`, `startedAt`, and the abort handling
(`runAborted`) plus loop-exit conditions that the previous change already touched at `:238`/`:320`/
`:325`.

> **Note — do not undo the previous change.** PR #153 flattened three `max-depth` blocks inside this
> function, including hoisting post-result checks out of the per-test `try`. That hoist carries a
> documented, deliberate qualification (an `appendLogLine` write failure propagates out of the loop
> rather than being caught). Preserve that behavior and its recorded qualification; do not silently
> revert it while restructuring.

### 3. Constraints on every extracted helper (applies to both files)

- Each extracted helper MUST itself be **≤ 60 lines** and **complexity ≤ 12** — otherwise the
  refactor merely relocates a warning instead of clearing it.
- Helpers MUST be given intention-revealing names describing the phase they own.
- **Net warning count MUST decrease.** Splitting a 405-line function into five 80-line helpers would
  *increase* the count; that outcome means the decomposition was too coarse and must be redone.

### 4. Optional, only if trivially clean

`TestExecutor.ts` has two smaller violations in the same file, likely natural to resolve while
already in it: `_captureDeviceState:681` (62 lines — just 2 over — complexity 13) and
`_capturePostActionScreenshot:790` (complexity 13). Fix them **only** if the fix is small and
obvious. If either requires real restructuring, leave it — this change's success is defined by the
two headline functions.

### Out of scope

- The three untested giants: `sessionRunner.ts:286`, `cloud-core/src/submit.ts:70`,
  `reportWriter.ts:156`. They need characterization tests first (a later change).
- Any other of the 140 warnings, including all oversized **test** functions (e.g.
  `testRunner.test.ts:139` at 234 lines) — test-file ergonomics are a separate concern.
- Promoting rules from `warn` to `error` — only correct when all 140 are cleared.
- Test backfill for `report-web` / `cloud-core`; Dependabot; the `.gitattributes` lockfile strategy.
- **Any behavior change whatsoever.** This is a pure restructuring.

## Affected Memory

Likely none, but this MUST be verified at hydrate rather than assumed — unlike the previous change,
this one restructures the internals of two documented subsystems.

- `cli/*` and `device-node/*` memory files describe public surfaces and contracts, not the internal
  structure of `runTests`/`executeGoal`, so no invalidation is expected.
- Hydrate MUST grep `docs/memory/**` for references to `executeGoal`, `runTests`, and any helper
  names introduced, and update anything that describes these functions' internal shape. If a memory
  file documents a phase sequence that the extraction renames, that IS a required update.

## Impact

- **Modified (2 files, possibly 2 more for tests)**: `packages/goal-executor/src/TestExecutor.ts`,
  `packages/cli/src/testRunner.ts`. Test files should NOT need changes — if a test must change to
  keep passing, that is a signal the refactor altered behavior and must be re-examined (see
  Assumptions #6).
- **Expected diff**: large but structural — roughly 685 lines reorganized into a thin orchestrating
  function plus named phase helpers in each file.
- **Risk**: **the highest of the initiative so far.** These are the two central execution paths
  (goal execution and CLI test running). The mitigation is the existing 29 tests plus the full
  348-test suite, and the strict no-behavior-change rule.
- **Expected outcome**: **140 → ~136 warnings** (4 cleared: 2 `max-lines-per-function` +
  2 `complexity`), possibly ~134 if the two optional items are trivially fixable. 0 errors,
  **348 tests still passing with no test-file edits**.

## Open Questions

- Should the extracted `executeGoal` phase helpers be private methods on `TestExecutor` or free
  functions taking an explicit context? (Assumed private methods, matching the file's existing
  `_captureDeviceState` / `_capturePostActionScreenshot` convention — see Assumptions #3.)

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Scope is exactly `executeGoal` + `runTests` (plus 2 optional same-file items) | User selected "Two biggest, well-tested" over the broad sweep and the characterization-test route | S:95 R:80 A:90 D:95 |
| 2 | Certain | The three untested giants are excluded | `sessionRunner`/`submit`/`reportWriter` have zero tests; refactoring them without characterization tests would be unsafe | S:90 R:80 A:95 D:95 |
| 3 | Confident | `executeGoal` phases become private methods on `TestExecutor`; the iteration loop stays in `executeGoal` | Matches the file's existing `_`-prefixed private-method convention; keeping the loop in place makes the top level read as its phase sequence | S:70 R:75 A:85 D:70 |
| 4 | Certain | Every extracted helper must itself be ≤60 lines and complexity ≤12, and the net warning count MUST fall | Otherwise the refactor relocates warnings rather than clearing them, defeating the purpose | S:90 R:85 A:95 D:90 |
| 5 | Certain | Accumulating state must be threaded explicitly (params/returns or a per-run/per-call context), NOT promoted to new instance fields | Changing a local's lifetime to a field is a real behavior change that tests may not catch; the context's lifetime is the invocation, since the accumulators outlive any single iteration | S:85 R:65 A:90 D:85 |
| 6 | Confident | No test file should need modification; if one does, treat it as evidence of behavior change | The refactor is behavior-preserving, so existing assertions must hold unchanged; a required test edit is a red flag, not a chore | S:80 R:70 A:85 D:80 |
| 7 | Certain | The previous change's `max-depth` fixes in `runTests` — including the hoist and its documented exception-path qualification — must be preserved, not reverted | They are deliberate, reviewed, and shipped in PR #153; silently undoing them would reintroduce cleared warnings and lose a recorded caveat | S:90 R:80 A:90 D:90 |
| 8 | Confident | The two optional `TestExecutor` items are fixed only if trivial | `_captureDeviceState` is 2 lines over; taking it opportunistically is cheap, but it must not expand the change | S:70 R:90 A:85 D:75 |
| 9 | Confident | Hydrate must actively verify memory rather than assume none is affected | This change alters internal structure of two documented subsystems; the prior change's "no memory impact" conclusion does not automatically transfer | S:70 R:85 A:80 D:75 |
| 10 | Certain | Verification is build → 348 tests (no count change) → lint (~136, 0 errors, no new warnings of any rule) | Mirrors CI; a test-count drop means a lost test, and a rule-count rise means relocated warnings | S:90 R:85 A:95 D:95 |

10 assumptions (6 certain, 4 confident, 0 tentative, 0 unresolved).
