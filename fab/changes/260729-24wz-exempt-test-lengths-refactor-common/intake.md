# Intake: Exempt Test Lengths, Clear `common`

**Change**: 260729-24wz-exempt-test-lengths-refactor-common
**Created**: 2026-07-29

## Origin

> exempt test files from max-lines-per-function, start the common refactor

Both instructions answer the status report that preceded them, which found the remaining 78 lint
warnings split **43 source / 35 test**, and identified `packages/common` as the one package never
batch-refactored — the only one whose worst source offender is also completely untested.

The two halves belong in one change because they move the **same metric**. Landing them separately
would mean measuring the refactor against a baseline that had just shifted underneath it. Here the
exemption lands first and its intermediate baseline is recorded explicitly, so each delta stays
independently attributable.

### A correction to the number quoted when this was proposed

The status report said exempting tests would take the count "from 78 to 43". That figure assumed
exempting test files from *every* code-quality rule. The instruction is narrower — exempt
`max-lines-per-function` only — and the measured split is:

| | `max-lines-per-function` | `complexity` | total |
|---|---|---|---|
| **test files** | 29 | 6 | 35 |
| **source files** | 23 | 20 | 43 |

So the exemption removes **29**, not 35: `78 → 49`. Six test files also trip `complexity`, and that
rule stays on for tests. Clearing `common`'s 7 source warnings then gives **42**.

## Why

**The exemption.** `max-lines-per-function` exists to stop a production function from accumulating
responsibilities until nobody can hold it in their head. A test function is not that shape. Its
length is usually *arrange* — fixtures, stubbed dependencies, a hand-built harness — and splitting
it into helpers moves that setup away from the assertions it explains, which makes the test harder
to read, not easier. The three longest functions in the entire repo are now test bodies (234, 157,
153 lines) and every one of them is a case where inlined setup is the clearer choice.

The rule was doing real harm as well as no good: 29 warnings is 37% of the total, so the number that
gates this initiative's endpoint (`warn` → `error`) was dominated by findings nobody intends to act
on. A metric that mixes "must fix" with "will never fix" cannot be driven to zero, and cannot be
promoted to `error`.

**`complexity` and `max-depth` deliberately stay on for tests.** They catch something the length
rule does not: branching *logic* inside a test. A test with a complexity of 20 is making decisions,
and a test that makes decisions can pass for the wrong reason — its own branches go unverified. Six
test files trip `complexity` today and each is worth looking at eventually. Exempting length is a
judgement about shape; exempting branching would be a judgement about correctness, and those are
not the same call.

**The `common` refactor.** `common` is the base of the dependency graph — every other package
imports it — and it is the last package with untouched source offenders. `Hierarchy` is the sharp
case: **16 files** across `goal-executor` and `device-node` consume it, and **no test exercises any
of its parse paths**. It is simultaneously the most-depended-on parser in the repo and the least
verified. That combination is the argument for doing it now rather than last.

## What Changes

### 1. Exempt test files from `max-lines-per-function`

`eslint.config.mjs`. The code-quality rules live in the `files: ['**/*.{ts,tsx,mts,cts}']` block
(`max-lines-per-function` 60, `max-depth` 4, `complexity` 12). Add a **later** config object that
narrows only the length rule for test files:

```js
{
  // Test files are exempt from max-lines-per-function ONLY. A long test body is
  // usually inlined arrange — fixtures and a hand-built harness — and hoisting
  // that into helpers moves the setup away from the assertions it explains.
  // `complexity` and `max-depth` deliberately stay ON: they catch branching
  // logic inside a test, and a test that branches can pass for the wrong reason.
  files: ['**/test/**/*.{ts,tsx}', '**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}'],
  rules: { 'max-lines-per-function': 'off' },
}
```

The glob set MUST cover this repo's actual layout: tests live in per-subfolder `test/` directories
(e.g. `packages/device-node/src/infra/ios/test/SimctlClient.test.ts`) *and* are named `*.test.ts`.
`*.spec.ts` is included because `fab/project/config.yaml` `test_paths` lists it, even though no
`.spec` file exists today.

**Acceptance is exact, not approximate**: after this task alone, `npm run lint` MUST report **49
warnings, 0 errors** — 43 source plus the 6 surviving test `complexity` warnings — and **zero**
`max-lines-per-function` findings in any test file. Record that intermediate count before starting
task 2; it is what makes the refactor's own delta measurable.

### 2. Characterize `Hierarchy.ts` — no parse path has any coverage

`packages/common/src/models/Hierarchy.ts` (397 lines). Verified: no test in the repo calls
`Hierarchy.fromJson`, `fromJsonString`, or `fromFlatJson`. The only file mentioning `Hierarchy` in a
test is `models/test/DeviceAction.test.ts`, and it references the unrelated `GetHierarchyAction`
*action type* — not this class.

Per the recorded discipline, an untested function is **characterized before it is restructured**.
Characterization tests MUST pass **before and after** — they prove equivalence, not a bug fix. Write
them against the pre-refactor source and confirm they pass there first.

The behaviour that must be pinned, because it is exactly what a naive refactor breaks:

- **Alias precedence, in order.** `_parseFlatNode` reads ~10 fields through fallback chains, e.g.
  `text` ← `text` ?? `title` ?? `value`; `accessibilityText` ← `content_desc` ?? `contentDesc` ??
  `accessibilityText` ?? `label`; `isSelected` ← `isSelected` ?? `is_selected` ?? `is_checked`. Pin
  the winner for each chain, and pin that a *later* alias is used only when every earlier one is
  absent.
- **`??` semantics, not truthiness.** `??` falls through on `null`/`undefined` **only**. So
  `isScrollable: false` in the JSON is *kept* as `false` rather than replaced by the default, and
  `text: ''` is kept as `''`. A helper written with `||` or a truthiness check would silently change
  all ten chains. This is the single highest-risk property in the file — pin it per chain with an
  explicit falsy-but-present case.
- **`id` post-processing.** An Android resource id containing `:id/` is reduced to its last segment;
  ids without `:id/` pass through unchanged; a null id stays null.
- **`isImage` is not a pure alias chain.** It is `(json.isImage ?? false) || clazz includes
  ImageView | ImageButton | SvgView`. Pin both the explicit-flag path and each class-substring path.
- **`_parseBounds`.** The 4-element array form, and whatever other forms the function accepts —
  read it and pin each, including the null/malformed result.
- **`fromFlatJson` vs `fromJson`.** Both entry points, including how flattened nodes relate to the
  tree and what `_flattenNode` produces.

**Mutation-verify each characterization test**: corrupt one behaviour in the source, confirm exactly
the test that pins it fails, restore. A characterization test that cannot fail is decoration.

### 3. Refactor `Hierarchy.ts` — 4 of the 7 warnings

| Site | Warning |
|---|---|
| `HierarchyNode` constructor (:28) | complexity 14 |
| `_parseNode` (:248) | complexity 16 |
| `_parseFlatNode` (:302) | 61 lines **and** complexity 36 |

Complexity 36 in a function with no branching statements comes entirely from the repeated
alias-chain pattern. The DRY fix is one small helper — first key present wins, `??` semantics
preserved exactly:

```ts
private static _pick<T>(json: Record<string, unknown>, keys: readonly string[], fallback: T): T
```

It collapses roughly eight of the ten chains. `id` (post-processing) and `isImage` (extra
disjunction) keep their own logic — do not force them through the helper to satisfy DRY.

**Zero behaviour change**, proven by the task-2 characterization tests passing unmodified. If a
characterization test needs editing to accommodate the refactor, the refactor is wrong.

**A latent defect that MUST NOT be fixed here.** The field reads use lying casts —
`json['text'] as string` when the value is a number yields a number typed as `string`, the same
class of defect as `SimctlClient._trimmed` (fixed in #164). Leave it exactly as is: fixing it would
break the zero-behaviour-change contract and destroy the equivalence proof. Record it as a
follow-up, as every such find in this initiative has been.

### 4. Refactor the three tested `common` functions — the other 3 warnings

These already have tests, so existing coverage is the equivalence proof; no characterization pass is
needed. Confirm the relevant tests actually exercise each function before relying on them, and
mutation-verify that reliance.

| Site | Warning | Existing coverage |
|---|---|---|
| `checkRunner.ts::runCheck` (:51) | 66 lines | `test/workspace.test.ts:112` |
| `env.ts::load` (:31) | complexity 17 | `test/env.test.ts` |
| `workspace.ts::resolveEnvironmentFile` (:350) | 62 lines | `test/workspace.test.ts` |

### Non-Goals

- **Exempting tests from `complexity` or `max-depth`** — deliberately kept, for the reason above.
  The 6 test `complexity` warnings survive this change and stay visible.
- **Fixing the `as string` / `as boolean` casts in `Hierarchy.ts`** — a real defect, deliberately
  deferred so the refactor keeps a clean equivalence proof.
- **The other packages' 36 remaining source warnings** — `report-web` (13) is blocked on a DOM test
  environment; `cli` (13), `device-node` (6), `goal-executor` (2), `cloud-core` (2) are separate work.
- **Promoting `warn` → `error`** — still the endpoint, still only honest at zero. This change moves
  78 → 42, so it is not yet reachable.
- **The `ci` memory-domain split** (~50KB against a ~15KB soft cap) — a queued
  `/docs-reorg-memory` job.

## Affected Memory

- `ci/pr-quality-gate.md`: (modify) test files are exempt from `max-lines-per-function` while
  `complexity` and `max-depth` still apply to them — and *why* the line is drawn there (shape vs.
  branching correctness), since the natural instinct is to exempt tests from all three
- `common/hierarchy.md`: (new) new domain — `Hierarchy`'s parse contract: the two entry points, the
  alias-precedence chains with their `??`-not-truthiness semantics, `id` shortening, the `isImage`
  disjunction, and bounds parsing. `common` has no memory domain today; the base of the dependency
  graph having no recorded contract is itself the gap

## Impact

**5 source files, 1 config file, and their tests.**

| Package | Files | Warnings cleared |
|---|---|---|
| root | `eslint.config.mjs` | 29 (test length findings) |
| `common` | `models/Hierarchy.ts` | 4 |
| `common` | `checkRunner.ts`, `env.ts`, `workspace.ts` | 3 |

**Blast radius.** `Hierarchy` is consumed by 16 files across `goal-executor` (`AIAgent`,
`GrounderResponseConverter`, `TestExecutor`, `ActionExecutor`), `device-node` (`Device`,
`AndroidDevice`, `IOSSimulator`, `CommonDriverActions`, `DeviceRuntime`, `GrpcDriverClient`) and
`common` itself. Nothing about its public surface changes, but a behaviour change would surface as a
grounding failure at runtime rather than a test failure — which is precisely why task 2 precedes
task 3.

**Expected end state**: `npm run lint` at **42 warnings / 0 errors** (0 from `common`), tests at
**469 + N**, typecheck and build exit 0, `max-depth` and `no-unused-vars` still at **0**.

**Verification order is load-bearing**: exemption → record 49 → characterize → confirm green on
unmodified source → refactor → confirm the same tests still green.

## Open Questions

None. The one judgement call the instruction left open — whether the exemption covers `complexity`
and `max-depth` too — is resolved to "no" and recorded as a graded assumption, with the 6 surviving
test `complexity` warnings kept visible rather than silently swept up.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | The exemption covers `max-lines-per-function` only; `complexity` and `max-depth` stay on for tests | The instruction named that rule specifically. The distinction is also substantive: length is a claim about shape, branching is a claim about whether the test can pass for the wrong reason | S:90 R:90 A:85 D:85 |
| 2 | Certain | `Hierarchy.ts` is characterized before it is restructured | Verified zero coverage of every parse path; the repo's recorded discipline is characterize-then-refactor, and 16 consumers make a silent behaviour change expensive to detect | S:85 R:85 A:95 D:90 |
| 3 | Certain | Both halves ship as one change, exemption first, with the intermediate 49 recorded | They move the same metric; separating them would measure the refactor against a baseline that had just shifted. Recording the intermediate count keeps both deltas attributable | S:80 R:85 A:85 D:80 |
| 4 | Certain | The `as string` / `as boolean` casts in `Hierarchy.ts` are left untouched and recorded as follow-up | Fixing them changes behaviour on malformed input, which would void the equivalence proof the characterization tests exist to provide. Every prior latent find in this initiative was deferred the same way | S:85 R:80 A:90 D:85 |
| 5 | Confident | The alias chains collapse into one `_pick` helper preserving `??` semantics; `id` and `isImage` keep their own logic | Eight chains are structurally identical; the other two carry extra logic. Per the mirror rule, share on measured sameness and stop there rather than forcing the outliers through. A scored down: only `_parseFlatNode`'s chains were read, not `_parseNode`'s | S:70 R:85 A:75 D:75 |
| 6 | Certain | The test glob covers `**/test/**`, `*.test.*` and `*.spec.*` | The repo uses per-subfolder `test/` directories *and* the `.test.ts` suffix, so either pattern alone under-matches; `.spec` is included because `config.yaml` `test_paths` lists it | S:75 R:90 A:85 D:80 |
| 7 | Confident | `common` gets a new memory domain rather than folding into an existing one | No `common` domain exists, and the base of the dependency graph having no recorded parse contract is the gap this exposes. Avoids growing `ci/pr-quality-gate.md`, already ~50KB against a ~15KB cap | S:60 R:80 A:85 D:80 |
| 8 | Confident | The three tested functions rely on existing tests as their equivalence proof, verified by mutation | Their coverage was confirmed by grep to specific test lines; mutation-verifying converts "a test imports this" into "a test would catch this". A scored down: only `runCheck`'s coverage was confirmed to a specific test line; the other two are inferred | S:70 R:85 A:75 D:75 |

8 assumptions (5 certain, 3 confident, 0 tentative, 0 unresolved).
