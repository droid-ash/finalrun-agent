# Intake: Clear Dead Code and Excess Nesting Flagged by the Lint Gate

**Change**: 260725-983g-dead-code-nesting-cleanup
**Created**: 2026-07-25

## Origin

Third change in the code-quality initiative, and the **first that improves application code** — the
two predecessors built the measurement infrastructure:

1. `260724-gl51-ci-gate-lint-enforcement` (PR #151, merged) — added the repo's first PR test gate and
   encoded four code-quality principles as ESLint `warn` rules.
2. `260725-358i-lockfile-reproducible-installs` (PR #152, merged `af577b3`) — committed the lockfile
   and switched CI/release to `npm ci`, making the gate's verdict depend on what changed rather than
   on when it ran.

Those rules now surface **156 warnings**, which are a direct machine-measurement of the user's four
original goals:

| Rule | Count | Original goal |
|------|-------|---------------|
| `max-lines-per-function` (>60) | 87 | #1 readability / #4 function size |
| `complexity` (>12) | 53 | #2 DRY / #3 YAGNI proxy |
| `@typescript-eslint/no-unused-vars` | 10 | #3 YAGNI (dead code) |
| `max-depth` (>4) | 6 | #4 nesting depth |

> User direction: asked to "prepare for the next stage… rebase from main and start", then selected
> **"Quick wins: dead code + nesting"** from the queued follow-ups — the 16 low-risk warnings, in
> preference to the 140 that need characterization tests first.

This change takes **only the 16 low-risk warnings** (10 `no-unused-vars` + 6 `max-depth`). The 140
`max-lines-per-function`/`complexity` warnings are deliberately left for a later change that writes
characterization tests before restructuring anything.

## Why

**Problem.** The lint gate identifies 16 concrete, unambiguous defects: ten pieces of dead code and
six blocks nested past the agreed depth-4 ceiling. They are real (not false positives — each was
inspected during intake), they are currently invisible in CI because the rules are `warn`-severity,
and they will stay indefinitely unless deliberately cleared.

**Consequence if not fixed.** Dead code misleads readers into thinking it is live — the clearest
case here is `formatSection` in `hostPreflight.ts`, orphaned back in commit `42ec272`
("simplify doctor output to tick/cross format") and still sitting in the file months later. That
same commit's drift also left six CLI tests stale, which cost a debugging cycle in the previous
change. Dead code is not inert; it is a standing invitation to misread the system. Separately, the
warnings cannot be promoted to `error` (the endpoint of this initiative) while any remain.

**Why this scope.** These 16 are the subset that can be fixed **without** restructuring behavior:
deleting an unreferenced symbol and flattening a nested block with a guard clause are both
locally-verifiable and covered by the existing 348-test suite. The other 140 require splitting large
functions, which genuinely risks behavior change and should be preceded by characterization tests.
Doing the safe subset first also exercises the full gate → fix → green loop end-to-end at low stakes.

## What Changes

### 1. Remove ten unused symbols (`@typescript-eslint/no-unused-vars`)

Each was located and inspected during intake. Grouped by required treatment, because they are **not
uniform** — three need more than a deletion:

**(a) Straight deletions — unreferenced imports/types/consts (7)**

| File:line | Symbol | Kind |
|-----------|--------|------|
| `packages/cli/src/hostPreflight.ts:10` | `ExecFileFn` | type |
| `packages/cli/src/reportServerManager.test.ts:69` | `createSuccessfulCommandResult` | test helper |
| `packages/cli/src/testRunner.ts:10` | `RunTarget` | import |
| `packages/cli/src/testRunner.ts:31` | `LoadedEnvironmentConfig` | import |
| `packages/device-node/src/discovery/DeviceDiscoveryService.test.ts:8` | `ChildProcess` | import |
| `packages/goal-executor/src/ai/AIAgent.test.ts:16` | `LLMPhase` | import |
| `packages/goal-executor/src/trace.ts:312` | `MAGENTA` | const |

For each, confirm no remaining reference in the package (including type-only positions and string
references) before deleting.

**(b) Dead function — `packages/cli/src/hostPreflight.ts:221` `formatSection`**

Orphaned by commit `42ec272`, which replaced the grouped `Ready` / `Setup Required` / `Warnings`
doctor sections with a flat per-check `✓/✗/⚠` list. Verified during intake: `formatSection` has
**zero** callers repo-wide.

**Cascade already checked — there is none.** `formatSection` calls `formatCheckLines`, but
`formatCheckLines` is *also* called at `hostPreflight.ts:208` by a still-live function, so it MUST be
kept. Delete `formatSection` only.

**(c) Unused parameter — `packages/device-node/src/device/android/AndroidDevice.ts:102`**

```ts
async rotate(action: RotateAction): Promise<DeviceNodeResponse> {
```

The parameter is positional and part of the device interface, so it MUST NOT be deleted. The
surrounding methods in this very file already establish the convention the lint config expects
(`argsIgnorePattern: '^_'`):

```ts
async home(_action: HomeAction): Promise<DeviceNodeResponse> { … }
async hideKeyboard(_action: HideKeyboardAction): Promise<DeviceNodeResponse> { … }
```

Fix: rename `action` → `_action`. Pattern-consistent with its immediate neighbours; no signature or
behavior change.

**(d) Write-only local — `packages/device-node/src/grpc/setup/AndroidDeviceSetup.ts:202`**

`startupState` is declared `let startupState: AndroidDriverStartupState | null = null;` at line 116
and assigned at lines 168, 185 (`= null`), and 202. Intake inspection found every nearby *read* —
lines 171, 204, 207 — to be `spawned.startupState`, a **property access on a different object**, not
the local. (Lines 395+ are an unrelated method with its own `const startupState`.) The local appears
genuinely write-only.

**This one requires verification before removal**, because it is the only case where the fix spans
multiple lines and branches. The implementer MUST confirm across the *whole* enclosing method
(including any `catch`/`finally` and closures) that the local is never read. Then:

- **If write-only** — remove the declaration (line 116) and all three assignments. This is the
  correct fix and also serves goals #1/#3.
- **If a read exists** — do not remove; rename to `_startupState` only if that satisfies the rule,
  and record why removal was unsafe.

### 2. Flatten six blocks nested deeper than 4 (`max-depth`)

| File:line | Enclosing context |
|-----------|-------------------|
| `packages/cli/src/sessionRunner.ts:482` | depth 5 |
| `packages/cli/src/sessionRunner.ts:505` | depth 5 |
| `packages/cli/src/testRunner.ts:238` | inside `runTests` |
| `packages/cli/src/testRunner.ts:320` | inside `runTests` |
| `packages/cli/src/testRunner.ts:325` | inside `runTests` |
| `packages/device-node/src/infra/android/AdbClient.ts:884` | depth 5 |

Preferred techniques, in order: **guard clauses / early `continue` / early `return`** to remove a
nesting level; then **inverting a condition**; and only if neither suffices, **extracting a small
well-named helper**.

**Scope guard — this is not the big refactor.** Three of the six sit inside
`testRunner.ts::runTests`, the repo's largest function (~293 lines) and a headline target of the
*later* refactor change. Here, do the **minimum** restructuring that brings each block to depth ≤ 4.
Do **not** undertake a general decomposition of `runTests`, and do not chase its
`max-lines-per-function`/`complexity` warnings — those belong to the follow-up that writes
characterization tests first. A helper extracted purely to reduce depth is acceptable; a wholesale
restructuring is not.

**Behavior must be preserved.** These are control-flow edits in live code paths (session running,
test running, adb interaction). No functional change is intended or permitted on any normal
execution path.

**One qualified exception, on an error path.** Hoisting the post-result checks out of the per-test
`try` in `testRunner.ts` changes where an exception thrown by `reportWriter.appendLogLine` (an
`fs.appendFileSync`) is handled: previously the per-test `catch` caught it; now it propagates out of
the loop. The outcomes converge — the original `catch`'s own first action is another
`appendLogLine` to the same file, which rethrows the same error — so no observable difference is
expected. The guarantee is therefore: **identical behavior on every normal path, and equivalent
(not identical) handling of an `appendLogLine` write failure**, which MUST be verified to still
rethrow and propagate rather than being silently swallowed.

### Out of scope

- The **87 `max-lines-per-function`** and **53 `complexity`** warnings — the next change, which must
  write characterization tests first.
- Promoting any lint rule from `warn` to `error` — only correct once all 156 are cleared.
- Test backfill for `report-web` / `cloud-core` (still 0 tests each).
- Dependabot/Renovate and the `.gitattributes` lockfile merge strategy.
- Any dependency change.

## Affected Memory

None. This change removes dead code and reduces nesting without altering any documented behavior,
interface, or contract. The `ci` domain's description of the lint rules remains accurate — only the
warning count changes, which memory does not record.

## Impact

- **Modified (10 files)**: `packages/cli/src/hostPreflight.ts`, `packages/cli/src/testRunner.ts`,
  `packages/cli/src/sessionRunner.ts`, `packages/cli/src/reportServerManager.test.ts`,
  `packages/device-node/src/device/android/AndroidDevice.ts`,
  `packages/device-node/src/grpc/setup/AndroidDeviceSetup.ts`,
  `packages/device-node/src/infra/android/AdbClient.ts`,
  `packages/device-node/src/discovery/DeviceDiscoveryService.test.ts`,
  `packages/goal-executor/src/ai/AIAgent.test.ts`, `packages/goal-executor/src/trace.ts`.
- **Expected diff**: small and mostly subtractive — roughly 10 deletions plus 6 localized
  control-flow edits.
- **Risk**: low for the deletions (unreferenced symbols; the compiler catches a mistake), **moderate**
  for the six `max-depth` edits, which touch live control flow in `sessionRunner`, `testRunner`, and
  `AdbClient`. The existing suite is the safety net: `cli` 115 tests and `device-node` 91 tests
  cover these areas.
- **Expected outcome**: **156 → ~140 warnings**, 0 errors, all 348 tests still passing.

## Open Questions

- If flattening a `max-depth` block cleanly requires extracting a helper that also reduces that
  function's line count, is that acceptable here or should it wait for the refactor change?
  (Assumed acceptable when the extraction is *incidental* to the depth fix — see Assumptions #7.)

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Scope is exactly the 16 low-risk warnings (10 unused-vars + 6 max-depth) | User explicitly selected "Quick wins: dead code + nesting" over the larger options | S:95 R:85 A:90 D:95 |
| 2 | Certain | Do NOT touch the 87 max-lines-per-function / 53 complexity warnings | Explicitly deferred; they need characterization tests first, which this change does not write | S:90 R:85 A:90 D:90 |
| 3 | Certain | `formatSection` is dead and safe to delete; `formatCheckLines` must be KEPT | Verified at intake: `formatSection` has zero callers repo-wide, but `formatCheckLines` is still called at hostPreflight.ts:208 by a live function | S:95 R:80 A:95 D:95 |
| 4 | Certain | `rotate`'s unused param is renamed `action` → `_action`, never deleted | It is positional and interface-bound; sibling methods `home`/`hideKeyboard` in the same file already use the `_action` form the config's `argsIgnorePattern: '^_'` expects | S:90 R:85 A:95 D:95 |
| 5 | Confident | `startupState` is write-only and its declaration + 3 assignments can be removed | Intake found all nearby reads to be `spawned.startupState` (a different object); flagged for whole-method verification before removal, with a `_startupState` rename as the documented fallback | S:70 R:70 A:80 D:75 |
| 6 | Certain | The six max-depth fixes MUST preserve behavior exactly | They edit live control flow in session/test/adb paths; the 348-test suite is the safety net | S:90 R:70 A:90 D:90 |
| 7 | Confident | A small helper extracted *incidentally* while reducing depth is acceptable; a general decomposition of `runTests` is not | Three violations sit inside the 293-line `runTests`; the line-count/complexity work is explicitly the next change's job, so restructuring must stay minimal | S:70 R:75 A:80 D:70 |
| 8 | Certain | No memory update is needed | No documented behavior, interface, or contract changes — only dead code removal and nesting reduction | S:85 R:90 A:85 D:90 |
| 9 | Certain | Verification is the full gate sequence: build → 348 tests → lint | Mirrors CI exactly; the warning count should drop to ~140 with 0 errors and no test regressions | S:90 R:85 A:95 D:95 |
| 10 | Confident | Deleting the 3 unused symbols in *test* files is safe | They are unreferenced helpers/imports in test files; the suite must still report the same 348 passing tests, which proves no test was silently disabled | S:75 R:85 A:85 D:80 |

10 assumptions (7 certain, 3 confident, 0 tentative, 0 unresolved).
