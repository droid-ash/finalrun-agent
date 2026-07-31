# Plan: Env Structural Refactor Pilot

**Change**: 260731-65sg-env-structural-refactor-pilot
**Intake**: `intake.md`

## Requirements

### common/env: Pinning tests for uncovered behavior traps

#### R1: New append-only pinning tests
NEW `test(...)` blocks SHALL be appended to `packages/common/src/test/env.test.ts` (append-only — no existing test block modified, per the constitution's Test Integrity rule) pinning the operator's behavior traps that the existing 16 tests leave uncovered:

1. `getRequired` throws `Missing required environment variable: {key}` when the key is absent.
2. `getRequired` throws the same error when the value is an empty string (the falsy-check trap — `if (!value)`, not `=== undefined`).
3. `getRequired` returns the value when present and non-empty.
4. `load(envName, { includeDotEnv: undefined, ... })` — explicitly passed `undefined` — still loads dotenv files (the `!== false` trap).
5. `set()` followed by `get()` round-trips a programmatic value.

- **GIVEN** the pre-refactor code at baseline (123/123 green)
- **WHEN** the new pinning tests are appended and the suite is run before any production edit
- **THEN** all tests pass, proving the new tests pin *current* behavior rather than desired behavior
- **AND** `git diff` on `env.test.ts` shows additions only (no `-` lines)

### common/env: Move reasoning-level helpers to their true home

#### R2: Verbatim move of the two helpers to `constants.ts`
`REASONING_LEVELS_LABEL` and `parseReasoningLevel` (currently `env.ts:100–119`) SHALL move verbatim into `packages/common/src/constants.ts`, placed immediately after the `REASONING_LEVELS` / `ReasoningLevel` block (`constants.ts:36–37`), mirroring `parseModel`'s co-location with `SUPPORTED_AI_PROVIDERS`. No logic edits of any kind: identical error message strings, identical trim/undefined/null/empty-string semantics.

- **GIVEN** the helpers live in `env.ts` and 5 existing tests assert their exact error strings
- **WHEN** the function bodies are moved verbatim to `constants.ts`
- **THEN** `parseReasoningLevel('extreme', 'config.yaml reasoning')` still throws `config.yaml reasoning has invalid value "extreme". Allowed values: minimal, low, medium, high.` and all 5 existing `parseReasoningLevel` tests pass unmodified

#### R3: `env.ts` keeps a byte-compatible export surface
`env.ts` SHALL keep every symbol importable from `env.js` today importable after the change: `CliEnv`, `parseReasoningLevel`, `REASONING_LEVELS_LABEL`, `MODEL_FORMAT_EXAMPLE`, `PROVIDER_ENV_VARS`, `SUPPORTED_AI_PROVIDERS`, `SUPPORTED_AI_PROVIDERS_LABEL`, `parseModel`, `ParsedModel`, `SupportedProvider`. Specifically:

- `REASONING_LEVELS_LABEL` and `parseReasoningLevel` are added to the existing re-export block from `./constants.js` (its seven current symbols kept — none removed).
- The now-unused value import of `REASONING_LEVELS` / `ReasoningLevel` at `env.ts:7` is dropped.
- The re-export block carries one short rationale comment marking it a backward-compatibility shim (consumers historically imported these through `env.js`; `env.test.ts` still does and must not be edited per Test Integrity).
- `CliEnv`'s body stays byte-for-byte untouched.

- **GIVEN** `env.test.ts:6` imports `CliEnv, parseModel, parseReasoningLevel` from `../env.js` and must not be edited
- **WHEN** the helpers move out and the re-export block is extended
- **THEN** all imports through `env.js` resolve to the same bindings and every existing test passes unmodified

#### R4: In-package consumers point at the true home
The two in-package consumers SHALL be updated:

- `workspace.ts:18`: `import { parseReasoningLevel } from './env.js'` → `from './constants.js'`.
- `index.ts:114`: `export { CliEnv, parseReasoningLevel } from './env.js'` → `export { CliEnv } from './env.js'` — `parseReasoningLevel` reaches the package surface through the existing `export * from './constants.js'` (line 94), same binding, so the package's export set is unchanged.
- `checkRunner.ts` / `testLoader.ts` stay untouched (they import `CliEnv`, whose home remains `env.ts`).

- **GIVEN** the helpers now live in `constants.ts`
- **WHEN** `workspace.ts` and `index.ts` are updated
- **THEN** the package-root export set is provably unchanged and `workspace.ts`'s config validation behaves identically

### common/env: Verification of the invariant

#### R5: The refactor MUST NOT change observable behavior — verified by evidence
The verification protocol SHALL produce evidence for each behavior trap:

1. Post-change `npm run build && npm test` in `packages/common`: all 123 baseline tests pass unmodified, plus the new pinning tests.
2. `git diff` on `packages/common/src/test/env.test.ts` shows additions only (no `-` lines).
3. Repo-wide build/typecheck of dependent packages green (workspace-wide `npm run build`, per CI's gate).
4. Export-surface equality: the post-change export set of built `dist/env.js` equals the pre-change set exactly; the post-change export set of built `dist/index.js` equals the pre-change set plus the one intentional additive symbol `REASONING_LEVELS_LABEL` (see Assumption 4 / A-009).

- **GIVEN** baseline 123/123 green recorded at intake (HEAD `7b38afc`)
- **WHEN** all edits land
- **THEN** every check above passes with recorded evidence

### Non-Goals

- Splitting `CliEnv` into loader/store/merger units (operator observation 3) — confirmed real but explicitly out of pilot scope; `CliEnv` stays byte-for-byte untouched.
- Removing the six unused constants re-exports from `env.ts` — API-surface cleanup for a follow-up change after consumers are audited; keeping them is the zero-risk choice.
- Any `env.test.ts` modification of existing test blocks — prohibited by Test Integrity.

### Design Decisions

#### Pin-before-move ordering
**Decision**: Append and run the new pinning tests (R1) against the *pre-refactor* code before any production edit.
**Why**: A pinning test only proves the invariant if it demonstrably passes against the original behavior first — characterize → pin → move → verify is the pattern this pilot exists to validate.
**Rejected**: Writing tests after the move (test-alongside default) — would pin the *post*-move behavior, making the tests useless as movement detectors.
*Introduced by*: 260731-65sg-env-structural-refactor-pilot

#### Backward-compat shim over barrel deletion
**Decision**: `env.ts` keeps a full re-export block (seven constants symbols + the two moved helpers) annotated as a compatibility shim.
**Why**: `env.test.ts:6` imports `parseModel`/`parseReasoningLevel` through `env.js` and must not be edited (Test Integrity); the shim keeps the export surface byte-compatible.
**Rejected**: Deleting the barrel and fixing importers — would force an import-path edit in `env.test.ts`, which is prohibited.
*Introduced by*: 260731-65sg-env-structural-refactor-pilot

## Tasks

### Phase 1: Setup

- [x] T001 Capture pre-change export surface: build `packages/common` and record `Object.keys()` of `dist/env.js` and `dist/index.js` exports to a scratch file for post-change comparison <!-- R5 -->

### Phase 2: Core Implementation

- [x] T002 Append 5 new pinning `test(...)` blocks to `packages/common/src/test/env.test.ts` (getRequired missing / empty-string / present; `includeDotEnv: undefined` still loads dotenv; `set`/`get` round-trip), then run `npm run build && npm test` in `packages/common` to confirm they pin current behavior (all green, zero existing-test edits) <!-- R1 -->
- [x] T003 Move `REASONING_LEVELS_LABEL` + `parseReasoningLevel` verbatim from `packages/common/src/env.ts:100–119` into `packages/common/src/constants.ts`, immediately after the `REASONING_LEVELS`/`ReasoningLevel` block <!-- R2 -->
- [x] T004 In `packages/common/src/env.ts`: delete the moved helper definitions, add `REASONING_LEVELS_LABEL` + `parseReasoningLevel` to the `./constants.js` re-export block, drop the now-unused value import at line 7, annotate the block as a backward-compat shim; `CliEnv` body byte-untouched <!-- R3 -->

### Phase 3: Integration & Edge Cases

- [x] T005 [P] Update `packages/common/src/workspace.ts:18` to import `parseReasoningLevel` from `./constants.js` <!-- R4 -->
- [x] T006 [P] Update `packages/common/src/index.ts:114` to `export { CliEnv } from './env.js'` (parseReasoningLevel already reaches the surface via line 94's `export * from './constants.js'`) <!-- R4 -->
- [x] T007 Run verification protocol: `npm run build && npm test` in `packages/common` (all 123 baseline tests + new tests green); repo-wide workspace build/typecheck; `git diff` on `env.test.ts` shows additions only; export-surface equality vs T001 snapshot <!-- R5 -->

## Execution Order

- T002 (pin) MUST complete — green against pre-refactor code — before T003/T004 (move). This ordering is the point of the pilot pattern.
- T003 blocks T004 (env.ts re-exports symbols that must exist in constants.ts first).
- T005/T006 are parallel after T004; T007 last.

## Acceptance

### Functional Completeness

- [x] A-001 R1: Five new pinning test blocks exist covering getRequired (missing/empty/present), `includeDotEnv: undefined`, and set/get round-trip
- [x] A-002 R2: `REASONING_LEVELS_LABEL` and `parseReasoningLevel` are defined in `constants.ts` immediately after the `REASONING_LEVELS` block, bodies verbatim-identical to the originals
- [x] A-003 R3: Every symbol importable from `env.js` pre-change remains importable post-change (all ten listed symbols)
- [x] A-004 R4: `workspace.ts` imports `parseReasoningLevel` from `./constants.js`; `index.ts:114` exports only `CliEnv` from `./env.js`; `checkRunner.ts`/`testLoader.ts` untouched

### Behavioral Correctness

- [x] A-005 R2: All 5 existing `parseReasoningLevel` tests pass unmodified through the `env.js` import path (exact error strings preserved)
- [x] A-006 R5: All 123 baseline tests pass unmodified post-change; the full suite (baseline + new) is green

### Scenario Coverage

- [x] A-007 R1: The new pinning tests were run and green against the pre-refactor code before the move (T002 ordering respected)

### Edge Cases & Error Handling

- [x] A-008 R1: Empty-string `getRequired` throws (falsy check, not `=== undefined`) and explicit `includeDotEnv: undefined` still loads dotenv files — both pinned by test
- [x] A-009 R5: `git diff packages/common/src/test/env.test.ts` contains no removed lines; `env.js` export set exactly equal pre/post; package-root export set equal except the one documented additive symbol `REASONING_LEVELS_LABEL` (unavoidable consequence of the mandated move + pre-existing `export *` at `index.ts:94` — see Assumptions row 4; nothing removed, all pre-existing bindings identical); repo-wide build green

### Code Quality

- [x] A-010 Pattern consistency: moved code mirrors `parseModel`'s placement/style in `constants.ts`; new tests follow existing `env.test.ts` fixture patterns (`createTempDotEnvDir`, try/finally cleanup)
- [x] A-011 No unnecessary duplication: helpers moved, not copied — single definition in `constants.ts`, `env.ts` re-exports the same binding
- [x] A-012 Comments: the shim comment states rationale (why the re-export block exists), passing the deletion test; no restatement comments introduced

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- `packages/common/src/env.ts:13` (`REASONING_LEVELS_LABEL` in the shim block) — this change made it reachable from the package root via `index.ts:94`'s `export *`, so the `env.js` re-export now has zero consumers anywhere in the repo (grep: only `constants.ts` uses the symbol, and only internally in its own error strings).
- `packages/common/src/env.ts:10-20` (the whole backward-compat re-export block) — retirable in one edit the moment a change is permitted to touch `env.test.ts:6`; only `parseModel` and `parseReasoningLevel` are reached through `env.js` today and only by that test, while `MODEL_FORMAT_EXAMPLE`, `PROVIDER_ENV_VARS`, `SUPPORTED_AI_PROVIDERS`, `SUPPORTED_AI_PROVIDERS_LABEL`, `ParsedModel` and `SupportedProvider` have no `env.js` consumer at all. Deliberately deferred here (Non-Goals, Assumption 6).
- `packages/common/src/env.ts:1` and `:26` (`// Port of mobile_cli/lib/mobile_cli_env.dart`, `Dart equivalent: MobileCliEnv …`) — the referenced Dart tree does not exist in this repo; now that the module's ownership boundary has been redrawn these dangling provenance pointers are the last stale claim in the file. Two sibling files carry the same pattern (`packages/cli/src/terminalRenderer.ts:1`, `packages/device-node/src/filePathUtil.ts:1`), so this belongs to a repo-wide sweep, not to this pilot.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | New pinning tests land as appended blocks in `env.test.ts` (not a sibling file) | Intake states "appended blocks preferred (same subject, same fixtures available)"; additions-only diff satisfies Test Integrity | S:90 R:90 A:95 D:85 |
| 2 | Confident | Pin-before-move ordering: T002 runs and passes against pre-refactor code before T003/T004 | Intake names the pattern "characterize → pin → move → verify"; pinning after the move would not prove the invariant | S:80 R:85 A:90 D:80 |
| 3 | Confident | Export-surface equality verified via node one-liners listing `Object.keys()` of built `dist/env.js`/`dist/index.js` before and after | Intake's verification item 5 offers exactly this method ("or by inspection"); runtime listing is the stronger evidence | S:75 R:90 A:85 D:75 |
| 4 | Confident | Accept the one-symbol additive package-root export delta (`REASONING_LEVELS_LABEL` newly reachable from the package root) rather than deviate from the mandated scope | Discovered at verification: intake's "package export set unchanged" claim missed that moving the label into `constants.ts` puts it under `index.ts:94`'s pre-existing `export *` — TypeScript has no `export * except X`. The delta is purely additive (nothing removed, every pre-existing binding identical — verified by runtime comparison), so no existing consumer can observe a behavior change; the alternatives (duplicate definition left in `env.ts`, or rewriting line 94 to ~40 named exports) violate the operator's non-negotiable exact scope or the keep-it-small constraint | S:70 R:75 A:80 D:70 |

4 assumptions (1 certain, 3 confident, 0 tentative).
