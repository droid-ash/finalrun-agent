# Intake: Env Structural Refactor Pilot

**Change**: 260731-65sg-env-structural-refactor-pilot
**Created**: 2026-07-31

## Origin

One-shot `/fab-new` invocation by the operator, with hard constraints. Raw input (condensed; full text in `.history.jsonl`):

> Structural refactor pilot for packages/common/src/env.ts (119 lines). This is the first change in this sequence that can alter runtime behavior, so the constraints below are harder than usual and they are not negotiable. THE INVARIANT: this refactor MUST NOT change observable behavior. packages/common/src/test/env.test.ts has 16 tests covering this file and that suite is your safety net. Per the project constitution Test Integrity rule, you MUST NOT modify, weaken, relax, or delete any existing test to make the refactor pass — if a test fails, the refactor is wrong, not the test. Adding NEW tests that pin behavior you are about to move is encouraged. STEP ZERO: run the test suite BEFORE touching anything and record that it is green. [Operator offered three structural observations as starting points to verify, plus explicit behavior traps to preserve. Keep the change genuinely small and reviewable — a pilot to prove the refactor pattern works safely, not to fix everything. Report exactly which behaviors were verified unchanged and by what evidence.]

**Baseline recorded (Step Zero, done at intake time)**: `npm run build && npm test` in `packages/common` on branch `c5-env-refactor` (clean tree, HEAD `7b38afc`) → **123 tests, 123 pass, 0 fail** (the 16 `env.test.ts` tests included). The baseline is green; refactoring proceeds on a sound base.

**Interaction mode**: one-shot; zero clarifying questions asked (no Unresolved decisions — see Assumptions).

## Why

1. **The pain point.** `packages/common/src/env.ts` mixes three unrelated concerns: (a) the `CliEnv` dotenv/OS-environment loader (its rightful content), (b) a pass-through re-export barrel of seven model/provider symbols from `./constants.js` (lines 8–16) that have nothing to do with environment loading, and (c) two reasoning-level validation helpers (`REASONING_LEVELS_LABEL`, `parseReasoningLevel`, lines 100–119) that are misplaced: they validate config/CLI values against `REASONING_LEVELS`, which lives in `constants.ts` — where the exactly parallel helper `parseModel` + `SUPPORTED_AI_PROVIDERS_LABEL` already sit beside their own level list (`constants.ts:44–105`). Misplaced definitions make the module graph lie about ownership: a reader looking for reasoning-level validation finds it in the env loader, and `workspace.ts` imports validation logic through the env module.

2. **The consequence of not fixing.** The barrel accretes: every symbol re-exported through `env.ts` invites the next import to route through it, deepening false coupling to the env module. This pilot is also sequenced work — it is the first behavior-capable change proving the refactor pattern (characterize → pin → move → verify) is safe; if it is skipped, larger refactors in this sequence have no validated template.

3. **Why this approach.** Move the two validation helpers to their true home (`constants.ts`, beside `REASONING_LEVELS`, mirroring `parseModel`'s placement) while keeping `env.ts`'s **export surface byte-compatible** via re-exports. This is the only shape that satisfies the Test Integrity constraint: `env.test.ts:6` imports `CliEnv, parseModel, parseReasoningLevel` from `../env.js`, and that file must not be modified — so `env.js` must keep exporting all three. Alternatives rejected: deleting the barrel outright (would force an import-path edit in `env.test.ts` — prohibited); splitting `CliEnv` into loader/store/merger units (observation 3) — real but out of pilot scope, and `CliEnv` at ~75 lines is not acutely painful; doing nothing (leaves the false ownership in place and the pattern unproven).

## What Changes

### Verified characterization (supersedes the operator's starting hypotheses where they differ)

Operator observations verified at intake time with grep evidence:

- **Observation 1 (barrel) — confirmed, but the blast radius is smaller than stated.** The seven-symbol re-export block (`env.ts:8–16`) has exactly **one** consumer that imports those symbols through `env.js`: `env.test.ts:6` (`parseModel`). The four named consumers import only `env.ts`'s own exports: `checkRunner.ts:4` and `testLoader.ts:14` import `CliEnv`; `workspace.ts:18` imports `parseReasoningLevel`; `index.ts:114` re-exports `CliEnv, parseReasoningLevel`. Package-level consumers already receive all seven constants symbols directly via `index.ts:94` (`export * from './constants.js'`). No deep imports of `common`'s env module exist from any other package (repo-wide grep; `packages/common/package.json` has no `exports` field, other packages import the package root).
- **Observation 2 (misplaced validation helpers) — confirmed.** `REASONING_LEVELS_LABEL` is used only inside `env.ts` itself (error messages); `parseReasoningLevel` is consumed by `workspace.ts` (lines 456, 485), `index.ts:114`, and `env.test.ts`.
- **Observation 3 (CliEnv mixes concerns) — confirmed but explicitly OUT OF SCOPE.** `CliEnv`'s body is not touched by this pilot, byte-for-byte.

### Change area 1: move the reasoning-level helpers to `constants.ts`

Move `env.ts:100–119` verbatim into `constants.ts`, placed immediately after the `REASONING_LEVELS` block (`constants.ts:36–37`) to mirror `parseModel`'s co-location with `SUPPORTED_AI_PROVIDERS`:

```ts
// constants.ts (after REASONING_LEVELS / ReasoningLevel)
export const REASONING_LEVELS_LABEL = REASONING_LEVELS.join(', ');

export function parseReasoningLevel(value: unknown, label: string): ReasoningLevel | undefined {
  // body moved verbatim from env.ts:102-119 — no logic edits of any kind
}
```

The function body moves **verbatim** — identical error message strings (tests assert on them: `must be a string. Allowed values: minimal, low, medium, high.` etc.), identical trim/undefined/null/empty-string semantics.

### Change area 2: `env.ts` keeps a byte-compatible export surface

- Add `REASONING_LEVELS_LABEL` and `parseReasoningLevel` to the existing re-export block from `./constants.js` (which keeps its seven current symbols — none removed).
- Drop the now-unused value import of `REASONING_LEVELS` / `ReasoningLevel` at `env.ts:7`.
- Annotate the re-export block as a backward-compatibility shim (one short rationale comment: consumers historically imported these through `env.js`; `env.test.ts` still does and must not be edited per the constitution's Test Integrity rule).
- **Every symbol importable from `env.js` today remains importable from `env.js` after the change**: `CliEnv`, `parseReasoningLevel`, `REASONING_LEVELS_LABEL`, `MODEL_FORMAT_EXAMPLE`, `PROVIDER_ENV_VARS`, `SUPPORTED_AI_PROVIDERS`, `SUPPORTED_AI_PROVIDERS_LABEL`, `parseModel`, `ParsedModel`, `SupportedProvider`.

### Change area 3: point the two in-package consumers at the true home

- `workspace.ts:18`: `import { parseReasoningLevel } from './env.js'` → `from './constants.js'`.
- `index.ts:114`: `export { CliEnv, parseReasoningLevel } from './env.js'` → `export { CliEnv } from './env.js'` — `parseReasoningLevel` now reaches the package surface through the existing `export * from './constants.js'` (line 94), same binding. One purely additive delta: `REASONING_LEVELS_LABEL`, having moved into `constants.ts`, also becomes reachable from the package root via that star export (nothing removed; every pre-existing binding identical — see plan.md Assumption 4 / A-009).
- `checkRunner.ts` / `testLoader.ts`: **untouched** — they import `CliEnv`, whose home remains `env.ts`.
- `env.test.ts`: **untouched, byte-for-byte** (Test Integrity).

### Change area 4: NEW pinning tests (append-only)

Existing `env.test.ts` leaves the operator's two behavior traps entirely uncovered — there is no `getRequired` test and no `includeDotEnv: undefined` test. Append NEW tests (new `test(...)` blocks only; no existing block edited) pinning:

1. `getRequired` throws `Missing required environment variable: {key}` when the key is **absent**.
2. `getRequired` throws the same error when the value is an **empty string** (the falsy-check trap — `if (!value)`, not `=== undefined`).
3. `getRequired` returns the value when present and non-empty.
4. `load(envName, { includeDotEnv: undefined, ... })` — explicitly passed `undefined` — **still loads** dotenv files (the `!== false` trap).
5. `set()` followed by `get()` round-trips a programmatic value.

These may live as appended blocks in `env.test.ts` or in a sibling new test file — appended blocks preferred (same subject, same fixtures available). Adding tests is explicitly encouraged by the operator; only *modifying existing* tests is prohibited.

### Behavior traps — preserved by construction (MUST hold after the change)

- `getRequired` keeps the falsy check `if (!value)` — empty string treated as missing and throws. (Untouched: `CliEnv` body is not edited.)
- `load()` precedence order: `.env.<envName>` first (`keepExisting: false`), then plain `.env` filling only unset keys (`keepExisting: true`), then OS environment overriding everything. (Untouched.)
- `includeDotEnv` defaults to true via `options?.includeDotEnv !== false` — an explicitly passed `undefined` still includes dotenv files. (Untouched, and newly pinned by test 4.)
- `parseReasoningLevel` / error-string semantics — moved verbatim; the 5 existing tests assert the exact strings through the `env.js` path, which still resolves to the same function.

### Verification protocol (evidence the invariant held)

1. Baseline already recorded: 123/123 green pre-change (see Origin).
2. Post-change: `npm run build && npm test` in `packages/common` — all 123 original tests pass **unmodified**, plus the new pinning tests.
3. `git diff` on `packages/common/src/test/env.test.ts` shows additions only (no `-` lines) — or no diff at all if new tests land in a sibling file.
4. Repo-wide typecheck/build of dependent packages (`npm run build`/`typecheck` across workspaces, per CI's gate) — confirms no consumer outside `common` broke.
5. Export-surface check: the post-change export set of built `dist/env.js` equals the pre-change set exactly; the package root (`dist/index.js`) equals the pre-change set plus the one intentional additive symbol `REASONING_LEVELS_LABEL` (see plan.md Assumption 4 / A-009). Verify by listing `Object.keys(require/import)` of both built files before and after, or by inspection of the re-export blocks.

## Affected Memory

- `common/env`: (new) The `CliEnv` loading contract (dotenv precedence: `.env.<envName>` → `.env` fill-only → OS env overrides all; `includeDotEnv !== false` default; `getRequired`'s falsy check treating empty string as missing) and the module-placement decision: reasoning-level validation lives in `constants.ts` beside `REASONING_LEVELS` (mirroring `parseModel`), while `env.ts`'s re-export block is a deliberate backward-compat shim kept because `env.test.ts` imports through it under the Test Integrity rule.

## Impact

- **Files edited**: `packages/common/src/env.ts` (helpers removed, re-exports extended, ~25 lines net out), `packages/common/src/constants.ts` (~25 lines in), `packages/common/src/workspace.ts` (1 import line), `packages/common/src/index.ts` (1 export line), `packages/common/src/test/env.test.ts` (append-only new tests, or a new sibling test file).
- **Runtime behavior**: none — that is the invariant. Export bindings for every public symbol resolve to the same functions/values.
- **Other packages**: none — no deep imports of `common/…/env` exist; package-root export set changes only additively (`REASONING_LEVELS_LABEL` newly reachable via the pre-existing star export of `constants.js`; nothing removed).
- **CI**: standard gate (build → typecheck → test → lint) must stay green; no workflow changes.

## Open Questions

- None — the operator's constraints resolve every material decision; remaining choices are graded assumptions below.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Refactor shape: move `REASONING_LEVELS_LABEL` + `parseReasoningLevel` verbatim to `constants.ts` beside `REASONING_LEVELS` | Codebase gives the answer — `parseModel` + `SUPPORTED_AI_PROVIDERS_LABEL` already sit beside their level list in `constants.ts`; exact parallel placement | S:90 R:85 A:95 D:85 |
| 2 | Certain | `env.ts` keeps a full backward-compat re-export block (all seven constants symbols + the two moved helpers); `env.test.ts` stays byte-untouched | Forced by the constitution Test Integrity rule + operator constraint: the test imports `parseModel`/`parseReasoningLevel` through `env.js` and must not be edited | S:95 R:80 A:95 D:90 |
| 3 | Certain | `CliEnv` body untouched byte-for-byte; observation 3 (mixed concerns inside the class) explicitly out of pilot scope | Operator: "genuinely small and reviewable... not to fix everything"; the behavior traps live in `CliEnv`, and not touching it preserves them by construction | S:90 R:85 A:90 D:85 |
| 4 | Confident | Update `workspace.ts` to import from `./constants.js` and simplify `index.ts:114` to `export { CliEnv }` (star export at line 94 already carries `parseReasoningLevel`, same binding) | Realizes the refactor's point (consumers import from the true home) at 2 lines of diff; package export set provably unchanged | S:75 R:85 A:85 D:70 |
| 5 | Confident | Append NEW pinning tests for the uncovered traps: `getRequired` (missing / empty-string / present) and `includeDotEnv: undefined`, plus `set`/`get` round-trip | Operator explicitly encourages new tests; existing suite has zero `getRequired` coverage, so the falsy-check trap is currently unpinned | S:80 R:90 A:90 D:75 |
| 6 | Confident | Do NOT remove the six unused constants re-exports from `env.ts` in this pilot | Removal is API-surface cleanup, not this pilot's goal; keeping them is the zero-risk choice and a follow-up change can retire the shim after consumers are audited | S:70 R:80 A:80 D:65 |
| 7 | Certain | Verification = baseline 123/123 green (recorded pre-change), full suite green post-change with existing tests unmodified, dependent-package typecheck/build, and export-surface equality check | Operator's Step Zero mandate + "report exactly which behaviors you verified unchanged and by what evidence" | S:95 R:90 A:95 D:90 |

7 assumptions (4 certain, 3 confident, 0 tentative, 0 unresolved).
