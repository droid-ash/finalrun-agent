# Plan: Batched Refactor of `goal-executor` — 19 Warnings in One Change

**Change**: 260726-fnwt-batch-refactor-goal-executor
**Intake**: `intake.md`

## Requirements

### goal-executor: ActionExecutor decomposition

#### R1: `_execute*` shared scaffolding is factored once
The seven flagged `_execute*` sibling methods in `packages/goal-executor/src/ActionExecutor.ts` MUST be restructured around shared scaffolding helpers wherever the commonality is real: the timed-phase-with-span-collection tail (`_runSpanPhase` / `_finishWithDevicePhase`), the single-device-action-or-throw step (`_runSingleDeviceAction`), the ground-to-point-with-visual-fallback preamble shared by tap/longPress (`_groundTargetPoint`), and the raw-grounder-output preamble shared by launchApp/setLocation (`_groundStructuredOutput`). Genuinely divergent actions (scroll's converter-based grounding, type's tolerant null-point focus grounding) MUST keep their own paths rather than being forced through one abstraction.

- **GIVEN** the existing 15 ActionExecutor tests
- **WHEN** the `_execute*` family is restructured onto the shared helpers
- **THEN** all 15 tests pass byte-for-byte unchanged (same trace span names, ordering, statuses, details, error strings, terminalFailure payloads)

#### R2: `executeAction` dispatch is a lookup, not a 14-case switch
`executeAction` MUST route to per-action handlers via a lookup helper (`_resolveHandler`) instead of the 14-case switch, preserving the unknown-action error string `Unknown action: {action}`, the per-invocation local `llmCalls` accumulator, and the catch-path logging behavior exactly.

- **GIVEN** an `ActionInput` with any of the 13 known planner action strings
- **WHEN** `executeAction` runs
- **THEN** the same handler as before executes with the same arguments, and llmCalls are merged into the output only when non-empty
- **AND** an unknown action still yields `{ success: false, error: "Unknown action: ..." }`

#### R3: Phase outcomes are discriminated unions
Where a helper can either produce a value for the caller to continue with or terminally resolve the action, it MUST return a discriminated `PhaseOutcome`-style union (`{ kind: 'proceed'|... } | { kind: 'done'; output: ActionOutput }`) — never a sentinel exception or a boolean out-flag — so early-exit control stays visible in the orchestrating method.

- **GIVEN** a grounding failure inside `_groundTargetPoint`
- **WHEN** `_executeTap` inspects the outcome
- **THEN** the `kind: 'done'` branch returns the terminal `ActionOutput` at the top level of `_executeTap`

### goal-executor: AIAgent decomposition

#### R4: `plan` and `ground` share the retry engine, keep their own tracing
`plan` and `ground` MUST be decomposed into a prompt-build helper, per-attempt phase helpers, and one shared retry engine (`_retryLLMAttempts`) that owns the attempt loop, the retry-warning log line (byte-identical message format including the grounder's ` for feature=...` suffix), the no-retry-on-`FatalProviderError` propagation, and the exhausted-attempts error. The tracing difference — `plan` records two trace phases per attempt (`planning.llm` + `planning.parse`), `ground` records one phase spanning both — is genuine divergence and MUST be preserved per function, not parameterized away.

- **GIVEN** a `_callLLM` mock that fails once then succeeds (the existing retry tests)
- **WHEN** `plan()` / `ground()` run
- **THEN** exactly 2 `_callLLM` calls occur and the parsed response is returned; a `FatalProviderError` on call 1 propagates after exactly 1 call

#### R5: `_callLLM` keeps its test-visible seam
`_callLLM` MUST keep its exact name and signature `(systemPrompt, userParts, feature) → Promise<{ output, text, llmCall }>` (tests replace it by property assignment), with internals extracted into message-building, call-trace-building, and response-logging helpers. Accumulating per-call state (timings, lastLLMCall) MUST live in per-call locals/context objects, never new instance fields.

- **GIVEN** the AIAgent retry tests that assign `agent._callLLM`
- **WHEN** the suite runs after the refactor
- **THEN** the mock still intercepts every LLM call and all 32 AIAgent tests pass unchanged

#### R6: `normalize*` parsers split by shape/field without weakening validation
`normalizePlannerResponse`, `normalizePromptAction`, and `normalizeUsage` MUST fall to complexity ≤12 by extracting per-shape/per-field helpers (action-record resolution, no-action fallback, swipe/status action normalization, a prototype-safe fixed-action `Map`, token-count field reads) while preserving every existing branch's semantics — no validation check may be removed or loosened, and object-key lookups on LLM-controlled strings MUST NOT become prototype-inheriting plain-object lookups.

- **GIVEN** every parser input exercised by the existing tests (nested/unwrapped planner output, terminal status, rotate, malformed values)
- **WHEN** the parsers run after the split
- **THEN** outputs are value-identical, and an actionType like `"toString"` still falls to the unsupported-action default

### Verification discipline

#### R7: Incremental refactor with per-step test runs; zero behavior change
The refactor MUST proceed one function (or one shared-scaffolding extraction) at a time, running the goal-executor suite after each step. No test file may be edited. Final state: `npm run build` exit 0; 368 tests / 0 fail (goal-executor 67); `npm run lint` exit 0 with ~112 warnings, 0 errors, `max-depth` and `no-unused-vars` at zero; every extracted helper ≤60 lines and complexity ≤12; the only remaining goal-executor source warnings are the 2 excluded `GrounderResponseConverter.ts` complexity warnings.

- **GIVEN** the baseline of 131 warnings / 368 passing tests
- **WHEN** the change completes
- **THEN** warnings are ~112 (19 cleared from the 14 flagged functions), tests are 368/0-fail, and `git diff --numstat` shows no `*.test.ts` changed

### Non-Goals

- `GrounderResponseConverter.ts` (zero tests — needs characterization first, its own change)
- The 35 test-file warnings; warnings outside goal-executor; promoting rules to `error`
- Any behavior change, any new DI seam, any test edit

### Design Decisions

#### Shared scaffolding helpers over eight independent per-method extractions
**Decision**: Factor the `_execute*` family's common structure once — span-collecting timed-phase tails, device-action-or-throw, the two grounding preambles — and let each sibling shrink by the shared part.
**Why**: Seven siblings of 63–102 lines repeat the same try/`_runTimedPhase`/push-span/`_success`/`_failure` scaffolding 9 times; DRY (principle 2) is served by one factoring, and it clears more lines per function than private helpers apiece.
**Rejected**: One mega-abstraction all seven actions flow through — scroll (converter-validated), type (tolerant null focus point), and launchApp (device prep phase) differ materially; forcing them through one shape would be worse than the duplication.
*Introduced by*: 260726-fnwt-batch-refactor-goal-executor

#### One shared retry engine for plan/ground; per-function tracing preserved
**Decision**: `_retryLLMAttempts` owns the attempt loop/warn/rethrow policy for both `plan` and `ground`; the per-attempt phase helpers stay per-function because their trace-phase structure genuinely differs (two phases vs one).
**Why**: The retry policy is byte-identical between the two; the tracing is not. Sharing exactly the common part is the intake's "find the shared shape — but only where the commonality is real" instruction applied.
**Rejected**: A hooks-parameterized engine also owning trace phases — would need an awkward per-stage callback interface to express the two-phase/one-phase difference, hiding more than it shares.
*Introduced by*: 260726-fnwt-batch-refactor-goal-executor

#### Fixed planner actions move to a prototype-safe Map
**Decision**: The 12 constant `case`s of `normalizePromptAction` become a module-level `ReadonlyMap`; `swipe`/`status` get named helpers; the default branch is unchanged.
**Why**: A 14-case switch is ≥15 complexity even with empty bodies — the switch itself must go. A `Map` (not a plain object) is used because `actionType` is LLM-controlled text: `obj['toString']` on a plain object would resolve to an inherited function instead of falling through to the unsupported-action default.
**Rejected**: Plain `Record` lookup — prototype-inheriting keys would change behavior for hostile/degenerate action types; keeping the switch and extracting only swipe/status — leaves complexity at ~15.
*Introduced by*: 260726-fnwt-batch-refactor-goal-executor

## Tasks

### Phase 1: Setup

- [x] T001 Verify baseline in `packages/goal-executor`: build exit 0, 368 tests / 0 fail (goal-executor 67), lint 131 warnings / 0 errors, per-rule breakdown recorded <!-- R7 -->

### Phase 2: Core Implementation — ActionExecutor.ts

- [x] T002 Add `PhaseOutcome` union type, `_runSpanPhase`, `_finishWithDevicePhase`, `_runSingleDeviceAction` to `packages/goal-executor/src/ActionExecutor.ts`; convert `_executeSingleDevicePhase`, `_executeWait`, `_executeDeeplink` tails onto them; run goal-executor tests <!-- R1 -->
- [x] T003 Extract `_groundTargetPoint` (ground + visual-fallback preamble, discriminated union) and refactor `_executeTap` + `_executeLongPress`; run tests <!-- R1, R3 -->
- [x] T004 Refactor `_executeType` onto `_runSpanPhase`/`_finishWithDevicePhase`/`_runSingleDeviceAction` (its null-tolerant focus grounding stays its own path); run tests <!-- R1 -->
- [x] T005 Refactor `_executeScroll` onto the shared tail (converter-based grounding stays its own path); run tests <!-- R1 -->
- [x] T006 Extract `_groundStructuredOutput` (raw-output grounder preamble with per-action validate) and refactor `_executeSetLocation`; run tests <!-- R1, R3 -->
- [x] T007 Extract `_fetchInstalledApps` and refactor `_executeLaunchApp` onto `_groundStructuredOutput` + shared tail; run tests <!-- R1, R3 -->
- [x] T008 Extract `_runVisualGroundPhase` and refactor `_executeVisualGroundingFallback`; run tests <!-- R1, R3 -->
- [x] T009 Extract `_resolveHandler` lookup and slim `executeAction`; run tests; lint ActionExecutor.ts → 0 warnings <!-- R2 -->

### Phase 3: Core Implementation — ai/AIAgent.ts

- [x] T010 Extract `_buildPlannerPrompt` from `plan` in `packages/goal-executor/src/ai/AIAgent.ts`; run tests <!-- R4 -->
- [x] T011 Add `_retryLLMAttempts` + `_runPlannerLLMPhase` + `_runPlannerParsePhase`; decompose `plan`'s retry loop; run tests <!-- R4 -->
- [x] T012 Extract `_buildGrounderPrompt` + `_runGrounderAttempt` + `_logGrounderResult`; decompose `ground` onto `_retryLLMAttempts`; run tests <!-- R4 -->
- [x] T013 Split `_callLLM` internals into `_buildLLMMessages` + `_buildLLMCallTrace` + `_logLLMResponse`, keeping `_callLLM`'s name/signature; run tests <!-- R5 -->
- [x] T014 Split `normalizePlannerResponse` into `resolvePlannerAction` + `plannerResponseWithoutAction`; run tests <!-- R6 -->
- [x] T015 Split `normalizePromptAction` into a prototype-safe fixed-action `Map` + `normalizeSwipeAction` + `normalizeStatusAction`; run tests <!-- R6 -->
- [x] T016 Split `normalizeUsage` token-count reads into `usageTokenCount`; run tests; lint AIAgent.ts → 0 warnings <!-- R6 -->

### Phase 4: Polish

- [x] T017 Full verification: `npm run build --workspaces --if-present` exit 0; `npm run test:workspaces` exit 0 / 368 tests / 0 fail with per-package counts; `npm run lint` exit 0 / ~112 warnings / 0 errors with per-rule breakdown; `git diff --numstat` shows no test file changed <!-- R7 -->

## Execution Order

- T002 blocks T003–T009 (shared tail helpers are prerequisites)
- T011 blocks T012 (`_retryLLMAttempts` is shared)
- Phases 2 and 3 are independent of each other but run sequentially for per-step test isolation

## Acceptance

### Functional Completeness

- [x] A-001 R1: All seven flagged `_execute*` methods are ≤60 lines / ≤12 complexity, restructured on the shared scaffolding helpers — `npm run lint` emits zero warnings for `ActionExecutor.ts`
- [x] A-002 R2: `executeAction` is ≤60 lines / ≤12 complexity with lookup dispatch and identical routing — all 13 map keys match the old switch cases one-for-one
- [x] A-003 R4: `plan` and `ground` are ≤60 lines / ≤12 complexity, sharing `_retryLLMAttempts`
- [x] A-004 R5: `_callLLM` is ≤60 lines with unchanged name/signature — `UserPart` is a structurally identical alias of the old inline union
- [x] A-005 R6: All three `normalize*` functions are ≤12 complexity — zero lint warnings for `ai/AIAgent.ts`

### Behavioral Correctness

- [x] A-006 R1: Trace span names/order/status/details, error strings, and terminalFailure payloads are unchanged — verified by a 92-scenario differential harness running the `origin/main` and refactored `ActionExecutor` side by side over identical mocks (output + span array + captured trace-phase log stream + device/grounder call sequence all byte-identical); all 15 ActionExecutor tests pass unmodified
- [x] A-007 R4: Retry counts, fatal-error propagation, and retry log formats are unchanged — verified by a 35-scenario `plan`/`ground` differential (retry-warning strings byte-identical for both label variants); all 32 AIAgent tests pass unmodified

### Scenario Coverage

- [x] A-008 R7: `npm run test:workspaces` exit 0, 368 tests, 0 fail — 75 common / 18 cloud-core / 91 device-node / 67 goal-executor / 117 agent
- [x] A-009 R6: Parser outputs value-identical for every tested input shape; `Map`-based lookup keeps prototype keys falling to the default branch — 463-case differential over the `normalize*` parsers, exercising all 14 action types, 10 prototype-chain names, and a range of planner and usage payload shapes

  > **On the 463 figure**: an earlier wording described this as "14 action types × 13 payload shapes plus 10 prototype-chain names", which multiplies out to 192 and does not reconcile with 463. That parenthetical named the principal dimensions rather than an exhaustive factorization, and it should not have been written as an arithmetic. 463 is the count the harness reported at the time; the harness was throwaway and is gone, so the exact composition cannot now be re-derived. The figure is recorded as-reported and the false decomposition removed rather than replaced with a reconstructed one.
- [x] A-009b R4: `_resolveFeatureConfig(FEATURE_PLANNER)` moved from once-per-`plan()` to once-per-attempt (2 calls on retry instead of 1) with no observable difference — 12-case differential over valid and invalid `features.planner.model` overrides, confirming the function is pure and that any `parseModel` throw still fires earlier in `_summarizePlannerRequest`

> **Differential totals reconcile as** 92 (`ActionExecutor`) + 35 (`plan`/`ground`) + 463 (`normalize*`) + 12 (config relocation, A-009b) = **602 comparisons, 0 mismatches**, plus 4 negative controls (span rename, retry-warning separator, fixed-action reason, `ReadonlyMap`→plain object) that all fired, proving the harnesses detect the regression classes at risk. A-009b was initially omitted, which left the acceptance items summing to 590 against a cited 602.

### Edge Cases & Error Handling

- [x] A-010 R3: Grounding failures, visual-fallback failures, and prep-phase failures still resolve through the same `_failure`/`_buildTrace` paths with identical span contents
- [x] A-011 R6: No validation branch in the `normalize*` parsers was removed or weakened

### Code Quality

- [x] A-012 Pattern consistency: helpers follow the `_`-prefixed-private / module-private conventions and the phase-outcome union DD from `docs/memory/ci/pr-quality-gate.md` (`_runSpanPhase`/`_finishWithDevicePhase` return `ActionOutput | undefined` rather than a wrapped union — no proceed-value exists; early exit stays visible at the top level, per Assumption 2)
- [x] A-013 No unnecessary duplication: the 9 repeated device-phase tails and the duplicated retry loops are factored once; every extracted helper is ≤60 lines / ≤12 complexity; every new helper has ≥1 call site
- [x] A-014 Readability over cleverness: no new instance fields (verified by diffing the field declarations) and no module-level mutable state; `LLMCallTimings` and the `_resolveHandler` map are per-call locals
- [x] A-015 Lint: exit 0, 112 warnings (131 −19), 0 errors, `max-depth`/`no-unused-vars` zero; only remaining goal-executor source warnings are `GrounderResponseConverter.ts:45` and `:124`

### Security

- [x] A-016 R6: LLM-controlled strings never index prototype-inheriting objects (`ReadonlyMap` + `Object.prototype.hasOwnProperty.call` guards confirmed load-bearing by negative-control injection); `_redactRuntimeString` is byte-identical to `origin/main`

## Notes

### Dead code surfaced by the refactor (recorded, not removed here)

Review found two genuinely dead constructs. Both are **pre-existing** — faithfully carried across
rather than introduced — but the refactor made them visible and cheap to remove, so they are
recorded rather than lost.

**1. `ActionExecutor.ts` `_runSingleDeviceAction`'s `failureMessage` parameter is dead.**
`_executeDeviceAction` already substitutes `'Action failed'` for a missing driver message, so
`result.error` is never nullish and **none of the ten per-action fallback strings can ever be
emitted**. Review confirmed empirically: mutating `'Set location action failed'` in the built output
changed nothing across 92 differential scenarios. Before this change the ten strings were scattered
one per method; the refactor collected them behind a single parameter, so deleting the parameter and
all ten call-site arguments is now a contained edit.

**2. `AIAgent.ts` `throw lastError ?? new Error(exhaustedMessage)` is unreachable.**
The attempt loop always returns or throws on the last attempt (`MAX_LLM_ATTEMPTS = 2`), so
`lastError` and the `exhaustedMessage` parameter are dead. TypeScript needs a terminal throw, but it
does not need a parameterised message — `origin/main` had the identical dead guard inline.

**Why not removed here.** This change is already the highest-volume of the initiative (14 functions,
877 lines reorganised) and a reviewer has just certified it as behaviour-preserving against 602
differential comparisons. Enlarging that diff with dead-code deletion would mean re-certifying it.
Both belong in a small follow-up — and note neither is caught by lint: they are a dead *parameter*
and a dead *branch*, not unused variables, so `no-unused-vars` at zero does not cover them.


- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- `packages/goal-executor/src/ActionExecutor.ts:768` `_runSingleDeviceAction(action, traceStep, failureMessage)` — the `failureMessage` parameter is unreachable: `_executeDeviceAction` already substitutes `'Action failed'` for a missing driver message, so `result.error` is never nullish and none of the ten per-action fallback strings (`'Tap action failed'`, `'Long press action failed'`, `'Failed to focus input field'`, `'Failed to enter text'`, `'Scroll action failed'`, `'Launch app action failed'`, `'Set location action failed'`, `'Deeplink action failed'`, `'Device action failed'`, `` `${actionType} action failed` ``) can ever be emitted. Pre-existing dead code, but the refactor collected it behind one parameter, making it cheap to drop. Verified: mutating `'Set location action failed'` in the built output changed no observable behaviour across 92 differential scenarios.
- `packages/goal-executor/src/ai/AIAgent.ts:312` `throw lastError ?? new Error(exhaustedMessage)` and the `lastError` local — unreachable, because the loop always returns or throws on the last attempt (`MAX_LLM_ATTEMPTS = 2`). Makes the `exhaustedMessage` parameter and both call sites' literals (`'Planner failed after all retry attempts'`, `'Grounder failed after all retry attempts'`) dead. Faithfully preserves the same dead guard `origin/main` had inline; TypeScript needs *some* terminal throw, but not a parameterised message.
- `packages/goal-executor/src/ActionExecutor.ts:718` `_executeSimpleAction` — now a pure one-line pass-through to `_executeSingleDevicePhase`. With dispatch a lookup map, the three `back`/`home`/`hideKeyboard` entries could call `_executeSingleDevicePhase` directly and the wrapper could go.
- `packages/goal-executor/src/ActionExecutor.ts:1044` `_pushGroundSpan(spans, name, …)` and `:779` `_groundToPoint(input, feature, tracePhase, …)` — every call site passes the literal `'action.ground'` for both parameters. Pre-existing; both could become constants inside the helpers.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Non-flagged siblings sharing the exact same tail (`_executeWait`, `_executeDeeplink`, `_executeSingleDevicePhase`) are also converted onto the shared helpers | Leaving two copies of the tail pattern in one file defeats the DRY factoring; all three are covered by existing tests (wait, deeplink ×2, rotate) and the conversion is mechanical | S:70 R:85 A:85 D:80 |
| 2 | Confident | Prep-phase early exits use `ActionOutput \| undefined` from `_runSpanPhase` (undefined = proceed) rather than a wrapped union | There is no proceed-value to carry, so `{kind:'ok'}` would be ceremony; early-exit stays visible at top level (`if (failure) return failure`), which is what the recorded DD actually requires — it bans sentinel exceptions and boolean out-flags, not nullable failure returns | S:65 R:85 A:80 D:70 |
| 3 | Certain | `_callLLM`, `_parsePlannerResponse`, `_parseGrounderResponse`, `_resolveFeatureConfig`, `_getProviderOptions` keep exact names/signatures | AIAgent tests reach them by name via casts and replace `_callLLM` by property assignment; renaming any of them breaks tests, which is prohibited evidence of contract change | S:90 R:90 A:95 D:95 |
| 4 | Confident | The fixed-action lookup in `normalizePromptAction` returns a shallow copy (`{ ...entry }`) from a module-level `ReadonlyMap` | Callers only read `.act`/`.reason` today, but returning the shared object would make a future caller mutation corrupt the table; the copy is free and preserves the original fresh-literal-per-call semantics exactly | S:70 R:80 A:85 D:80 |
| 5 | Certain | `generateText` receives the `messages` array built for observability instead of a duplicated inline literal | The two literals are value-identical today (same `userContent` reference, same system string); passing one array is pure dedup with no behavioral seam | S:85 R:85 A:90 D:90 |
| 6 | Certain | Dispatch-map construction in `_resolveHandler` happens per call (local object), not on a new instance field | Constraint 3 bans new instance/module state; a 13-entry object literal per action execution is negligible next to an LLM round-trip | S:85 R:90 A:90 D:85 |

6 assumptions (3 certain, 3 confident, 0 tentative).
