# Intake: Batched Refactor of `goal-executor` — 19 Warnings in One Change

**Change**: 260726-fnwt-batch-refactor-goal-executor
**Created**: 2026-07-26

## Origin

This change exists because of a **deliberate course correction**, not a new discovery.

Asked to assess progress against the original goals, a measurement of the initiative showed it was
only partially tracking. Two of the four code-quality principles were complete (`no-unused-vars` and
`max-depth` both at zero, held across five changes), and the "tests run at PR opening" goal was
delivered in #151. But the function-size and complexity principles had barely moved: **156 → 131
warnings, of which only 9 came from actual function-splitting** across two changes.

The diagnosis was a scoping error of mine, repeated. Per-change *cost* is roughly fixed — intake,
apply, review, hydrate, ship, CodeRabbit, merge, archive — yet I kept scoping each refactor to **one
or two functions**. At ~4.5 warnings cleared per refactor change, the remaining 97 source warnings
would need ~21 more changes. That is not a viable plan. A secondary drift compounded it: three of the
last five changes (#155, #157, #158) were bug fixes that fell *out* of the refactoring work, each
spawned by the previous. All were real — one data-loss-adjacent — but none advanced the stated goal.

> User direction: "finish 158 then start the batched goal-executor change".

**This change is the corrected shape**: one package, many functions, one review. It targets **19 of
the 97 source warnings (~20%)** in a single change — more than the previous six changes cleared
combined.

**Base note**: this branch is cut from `origin/main` at `c39f8fc` (#157's merge). PR #158 is open and
green but not yet merged, so it is not in this base. There is no file overlap — #158 touches
`cloud-core`, this touches `goal-executor` — but this branch will need a rebase once #158 lands.

## Why

**Problem.** `goal-executor` carries 21 source warnings, the largest concentration in the repo, and
they sit in the two files with the **strongest test coverage available** — 15 tests for
`ActionExecutor.ts` and 32 for `AIAgent.ts`, 47 together. That combination is exactly what previous
changes lacked: the untested giants (`sessionRunner.ts`, `reportWriter.ts`) had to be deferred
precisely because restructuring without tests is unsafe. Here the safety net already exists and has
been idle.

**Consequence if not fixed.** Beyond the warnings themselves: `AIAgent.plan` (134 lines) and
`AIAgent.ground` (136 lines) are the LLM interaction core, and `ActionExecutor`'s eight `_execute*`
methods are every device action the product performs. These are the functions a contributor must read
to change behaviour, and they are the least readable in the codebase. The rules also cannot be
promoted from `warn` to `error` — the initiative's endpoint — while 97 source violations remain, and
this is the single biggest tranche.

**Why this is the right batch.** It is the highest warning density in the repo *and* the highest test
coverage, so it maximises cleared debt per unit of review risk. And it is where **DRY (principle 2)
can finally get real traction** — see What Changes §1.

## What Changes

### 1. `packages/goal-executor/src/ActionExecutor.ts` — 11 warnings, 8 functions

| Line | Function | Lines | Also complexity? |
|------|----------|-------|------------------|
| 156 | `executeAction` | 61 | ✅ |
| 234 | `_executeTap` | 68 | |
| 309 | `_executeLongPress` | 63 | |
| 377 | `_executeType` | 81 | |
| 464 | `_executeScroll` | 64 | |
| 539 | `_executeLaunchApp` | 102 | ✅ |
| 650 | `_executeSetLocation` | 63 | |
| 871 | `_executeVisualGroundingFallback` | 93 | ✅ |

**Look for the shared shape first.** Seven of these are sibling `_execute*` methods of 63–102 lines
implementing one device action each. Sibling methods of that size and symmetry almost always share
scaffolding — argument validation, grounding, driver dispatch, trace/step recording, error mapping.
**Before extracting per-method helpers, read them together and identify what is genuinely common.**
Factoring shared scaffolding once serves principle 2 (DRY) directly and will clear more warnings than
eight independent extractions, because each sibling shrinks by the shared part rather than by a
private helper apiece.

This is the first change in the initiative where DRY is addressable in earnest. Take it seriously —
but only where the commonality is real. Forcing seven genuinely different actions through one
abstraction would be worse than the duplication.

### 2. `packages/goal-executor/src/ai/AIAgent.ts` — 8 warnings, 6 functions

| Line | Function | Lines | Also complexity? |
|------|----------|-------|------------------|
| 217 | `plan` | 134 | ✅ |
| 379 | `ground` | 136 | ✅ |
| 542 | `_callLLM` | 81 | |
| 964 | `normalizePlannerResponse` | — | ✅ (complexity only) |
| 1026 | `normalizePromptAction` | — | ✅ (complexity only) |
| 1143 | `normalizeUsage` | — | ✅ (complexity only) |

`plan` and `ground` are the two largest. They are likely near-parallel (request → prompt → LLM call →
normalise → trace), so the same "find the shared shape" instruction applies. The three `normalize*`
functions are module-level and complexity-only — they are defensive parsers of untrusted LLM output,
so their branchiness is largely inherent; prefer extracting per-field or per-shape helpers over
restructuring the validation logic, and do **not** weaken any validation to reduce a branch count.

### 3. Method — follow the conventions already recorded in memory

`docs/memory/ci/pr-quality-gate.md` § Design Decisions holds the rules established by #154–#158.
They are binding here, not advisory:

- **Every extracted helper MUST itself be ≤60 lines and complexity ≤12.** A refactor that relocates
  warnings instead of clearing them is a failure. Net count MUST fall by ~19.
- **Accumulating state goes on a per-call local context object**, never a new instance field or
  module-level state — changing a local's lifetime is a real behaviour change tests may not catch.
- **Where loop control must stay visible at the top level**, use the phase-outcome discriminated-union
  pattern rather than sentinel exceptions or boolean out-flags.
- **`finally` scope follows the acquisition** — every acquisition independently, not just the most
  recent. Two bugs in this initiative came from violating this; if any of these functions acquire a
  resource, its release must sit in a `finally` whose `try` opens immediately after the acquisition.
- **`max-depth` and `no-unused-vars` are at zero tree-wide and MUST stay there.** A new violation of
  either is a regression this change introduced, not inherited debt.

### 4. Refactor incrementally, verifying per function

This is the highest-volume change of the initiative — 14 functions across 2 files. Do **not**
restructure everything and then run the suite once. Refactor one function (or one shared-scaffolding
extraction) at a time and run the package's tests after each, so a behavioural break is localised to
the step that caused it rather than hidden among eleven. Report the sequence.

### Excluded: `GrounderResponseConverter.ts`

It carries 2 complexity warnings (lines 45, 124) and has **zero tests** — a grep of every
`*.test.ts` in the package finds no reference to it. Refactoring it here would repeat exactly the
mistake this initiative has avoided since #154. It needs characterization tests first, which is its
own change (and would also close a coverage gap in an otherwise well-tested package).

### Out of scope

- `GrounderResponseConverter.ts` (above), `TestExecutor.ts` (already split in #154), `trace.ts`,
  `VisualGrounder.ts`, `providerFailure.ts`, `schemas.ts`, `index.ts`.
- Every warning outside `goal-executor` — `cli/reportWriter.ts` (7), `device-node/DeviceDiscoveryService.ts`
  (8), `report-web/runDetailController.ts` (6), etc. Each package is its own batch.
- The **35 warnings in test files** — long test functions are conventional; they are not the goal.
- Promoting rules from `warn` to `error` (only correct at zero), `report-web` backfill, Dependabot,
  splitting the oversized `ci` memory domain.
- **Any behaviour change.** This is a pure restructuring.

## Affected Memory

Likely none, but hydrate MUST verify rather than assume — this restructures the internals of two
documented subsystems.

- No memory file currently describes the internal phase structure of `ActionExecutor`'s `_execute*`
  methods or `AIAgent.plan`/`ground`. Hydrate MUST grep `docs/memory/**` for those names, any new
  helper names introduced, and for descriptions of the action-execution or LLM-call sequence.
- If a genuinely reusable pattern emerges from the shared-scaffolding work (§1) — a sibling-family
  extraction shape — consider whether it belongs alongside the existing refactor DDs. Prefer
  sharpening existing text; `pr-quality-gate.md` is ~25KB against a ~15KB soft advisory cap.

## Impact

- **Modified**: `packages/goal-executor/src/ActionExecutor.ts`,
  `packages/goal-executor/src/ai/AIAgent.ts`. **No test file should change.**
- **Expected diff**: large but structural — roughly 800–900 lines reorganised into thin orchestrators
  plus named helpers, possibly with shared scaffolding factored out of the `_execute*` family.
- **Risk**: **the highest-volume change of the initiative.** Mitigated by the strongest coverage
  available (47 tests across the two files, inside a 368-test suite), the per-function incremental
  verification in §4, and the strict no-behaviour-change rule. The specific risk to watch is the
  shared-scaffolding extraction in §1 — collapsing seven sibling methods onto one helper is where a
  subtle per-action difference could be lost.
- **Expected outcome**: warnings **131 → ~112** (19 cleared; possibly more if DRY factoring removes
  duplication beyond the flagged functions); tests **368 unchanged, 0 fail, no test file edited**;
  `max-depth` and `no-unused-vars` still zero; 0 errors.

## Open Questions

- If the `_execute*` family shares less than it appears, is a smaller cleared count acceptable?
  (Yes — see Assumptions #4: honest partial factoring beats a forced abstraction.)
- Should `GrounderResponseConverter.ts` characterization tests be folded in? (No — Assumptions #8.)

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Batch the whole package in one change rather than one-or-two functions | Per-change ceremony cost is fixed; the measured ~4.5-warnings-per-change rate needs ~21 more changes for the remaining 97. The user directed this correction explicitly | S:95 R:80 A:90 D:90 |
| 2 | Certain | Target `ActionExecutor.ts` + `AIAgent.ts` — highest warning density AND highest test coverage | 19 warnings against 47 existing tests; maximises cleared debt per unit of review risk | S:90 R:80 A:90 D:90 |
| 3 | Certain | Exclude `GrounderResponseConverter.ts` | 2 warnings but ZERO tests — refactoring it would repeat the mistake avoided since #154; needs characterization first | S:90 R:85 A:95 D:95 |
| 4 | Confident | Look for shared scaffolding across the `_execute*` family before per-method extraction | Seven siblings of 63–102 lines almost certainly share structure; factoring once serves DRY and clears more than eight independent extractions. But only where commonality is real — a forced abstraction over genuinely different actions is worse than the duplication | S:70 R:70 A:80 D:70 |
| 5 | Certain | Every extracted helper must itself be ≤60 lines and ≤12 complexity; net count MUST fall | Recorded DD; otherwise the refactor relocates warnings rather than clearing them | S:90 R:85 A:95 D:90 |
| 6 | Certain | Refactor incrementally with per-function test runs, not big-bang | 14 functions; localising a break to its causing step is the difference between a fix and a bisect | S:85 R:80 A:90 D:85 |
| 7 | Certain | No test file may change; a required edit is evidence of behaviour change | The refactor is behaviour-preserving, so existing assertions must hold unchanged — the same rule that held for #154 and #156 | S:90 R:80 A:90 D:90 |
| 8 | Confident | Do NOT fold `GrounderResponseConverter` characterization tests into this change | It would mix a test-writing change into a large refactor and blur what the review is certifying; it is a clean separate change | S:75 R:85 A:85 D:80 |
| 9 | Confident | Do not weaken validation in the three `normalize*` functions to reduce complexity | They parse untrusted LLM output; branchiness is largely inherent, and trading robustness for a lint count would be a real regression | S:80 R:75 A:85 D:80 |
| 10 | Certain | `max-depth` and `no-unused-vars` must remain at zero | Both are clear tree-wide and held across five changes; a new violation is PR-introduced regression | S:90 R:90 A:90 D:90 |

10 assumptions (7 certain, 3 confident, 0 tentative, 0 unresolved).
