# Plan: Exempt Test Lengths, Clear `common`

**Change**: 260729-24wz-exempt-test-lengths-refactor-common
**Intake**: `intake.md`

## Requirements

### Lint Config: Test-file length exemption

#### R1: Test files are exempt from `max-lines-per-function` only
`eslint.config.mjs` MUST gain a later config object that turns off ONLY
`max-lines-per-function` for test files. `complexity` and `max-depth` MUST remain active for
test files — this is a deliberate line (length is a claim about shape; branching is a claim
about whether a test can pass for the wrong reason). The glob set MUST cover both test layouts
this repo uses: per-subfolder `test/` directories (`**/test/**/*.{ts,tsx}`) AND suffix-named
files (`**/*.test.{ts,tsx}`, `**/*.spec.{ts,tsx}` — `.spec` included because
`fab/project/config.yaml` `test_paths` lists it, even though no `.spec` file exists today).

- **GIVEN** the baseline of 78 warnings / 0 errors (measured: 23 source `max-lines-per-function`
  + 20 source `complexity` + 29 test `max-lines-per-function` + 6 test `complexity`)
- **WHEN** the exemption config object is added and `npm run lint` runs with no other change
- **THEN** the count is exactly **49 warnings / 0 errors** (43 source + 6 surviving test
  `complexity`), with **zero** `max-lines-per-function` findings in any test file
- **AND** this intermediate count is recorded before any refactor work starts, so the
  refactor's own delta stays independently attributable

### common: Characterize `Hierarchy.ts` before restructuring

#### R2: Characterization tests pin `Hierarchy`'s parse contract against the unmodified source
`packages/common/src/models/Hierarchy.ts` has zero coverage of `fromJson`, `fromJsonString`,
and `fromFlatJson` (verified: the only test mention of "Hierarchy" is the unrelated
`GetHierarchyAction` in `DeviceAction.test.ts`). A new characterization test file MUST pin,
against the **unmodified** source, passing there **first**:

- **Alias precedence per chain, in order** (`_parseFlatNode`): `text` ← `text` ?? `title` ??
  `value`; `accessibilityText` ← `content_desc` ?? `contentDesc` ?? `accessibilityText` ??
  `label`; `id` ← `id` ?? `identifier`; `clazz` ← `class` ?? `clazz`; `isScrollable` ←
  `isScrollable` ?? `is_scrollable`; `isFocused` ← `isFocused` ?? `is_focused`; `isEditable` ←
  `isEditable` ?? `is_editable`; `isSelected` ← `isSelected` ?? `is_selected` ?? `is_checked`.
  A later alias is used only when every earlier one is absent.
- **`??` semantics, not truthiness — per chain with an explicit falsy-but-present case**:
  `text: ''` is kept as `''` (not replaced by `title`/`value`); `isScrollable: false` is kept
  as `false` (not replaced by `is_scrollable: true`); likewise for the other boolean chains.
- **`id` post-processing**: an id containing `:id/` is reduced to its last segment; ids
  without `:id/` pass through; absent id stays `null`; post-processing also applies when the
  id came from the `identifier` alias.
- **`isImage`**: `(json.isImage ?? false) || clazz includes ImageView | ImageButton | SvgView`
  — the explicit-flag path AND each class-substring path pinned individually.
- **`_parseBounds`**: 4-element array form (with `Number` coercion of string digits), the
  `{left,top,right,bottom}` object form, and null for wrong-length arrays / non-object garbage
  / absent bounds.
- **`_parseNode` (tree path)**: its own chains (`contentDesc` ?? `accessibilityText`,
  `class` ?? `clazz`), `''`/`false` kept per `??`, and DFS pre-order index assignment.
- **`fromFlatJson` vs `fromJson` vs `fromJsonString`**: flat array → `flattenedHierarchy` in
  array order with `root === null` and empty children; object JSON → tree; array JSON string →
  flat path; malformed JSON string → `new Hierarchy(null)` with empty `flattenedHierarchy`.
- **`HierarchyNode` constructor defaults**: omitted fields default (`null`/`false`/`[]`);
  explicitly passed `false`/`''` are kept.

- **GIVEN** the unmodified `Hierarchy.ts`
- **WHEN** the characterization tests run
- **THEN** all pass
- **AND** each test is mutation-verified: one behaviour is corrupted in the source, exactly
  the test pinning it fails, the source is restored — with the observed failure recorded

#### R3: `Hierarchy.ts` refactored to zero warnings with zero behaviour change
The 4 warnings (constructor complexity 14, `_parseNode` complexity 16, `_parseFlatNode`
61 lines + complexity 36) MUST be cleared by collapsing the alias chains with one small helper
that preserves `??` semantics exactly (first key **present** — not truthy — wins; falls
through on `null`/`undefined` only; the lying `as T` cast behaviour preserved). `id` (its
`:id/` post-processing) and `isImage` (its extra disjunction over `clazz`) keep their own
logic — they are NOT forced through the helper to satisfy DRY.

- **GIVEN** the R2 characterization tests green on the unmodified source
- **WHEN** the refactor lands
- **THEN** the same tests pass **unmodified** (if a characterization test needs editing to
  accommodate the refactor, the refactor is wrong — fix the refactor)
- **AND** `packages/common/src/models/Hierarchy.ts` produces zero lint warnings
- **AND** the lying-cast defect is not fixed: the per-field `as string`/`as boolean` reads are *relocated* into `_pick`'s single `value as T`, still with no runtime validation, and recorded as a follow-up
  (fixing them changes behaviour on malformed input and would void the equivalence proof)

### common: Refactor the three already-tested functions

#### R4: `runCheck`, `CliEnv.load`, `resolveEnvironmentFile` refactored under existing coverage
The three remaining `common` warnings (`checkRunner.ts::runCheck` 66 lines, `env.ts::load`
complexity 17, `workspace.ts::resolveEnvironmentFile` 62 lines) MUST be cleared by extraction
refactors. Existing tests are the equivalence proof, but their reliance MUST first be
confirmed (which tests actually exercise each function) and then mutation-verified per
function ("a test imports this" is not "a test would catch this"). Verified during planning:
`workspace.test.ts` exercises `runCheck` directly (dozens of tests from :112 on) and, through
it, `resolveEnvironmentFile` (dev default, sole-file fallback, ambiguity error, explicit
match, missing-env errors, empty-bindings paths) and `CliEnv.load` (`.env.<env>` loading at
:742/:777, process.env precedence at :112). **`env.test.ts` does NOT cover `CliEnv.load`** —
it tests only `parseModel`/`parseReasoningLevel` — so `load`'s equivalence proof rests on the
`runCheck` tests; any `load` behaviour the refactor touches that mutation shows uncovered gets
a targeted test added.

- **GIVEN** the existing `packages/common/src/test/` suite green
- **WHEN** each function is refactored (extraction only, no behaviour change)
- **THEN** the same tests pass unmodified, mutation of each refactored function's behaviour
  is caught by a named existing (or newly added, where mutation exposed a gap) test
- **AND** `packages/common` produces zero source lint warnings

### Gate: Full verification

#### R5: All five gate stages pass with the expected end-state numbers
- **GIVEN** all tasks complete
- **WHEN** `npm ci`, `npm run build --workspaces`, `npm run typecheck`,
  `npm run test:workspaces`, `npm run lint` run
- **THEN** all exit 0; tests report 469 + N pass / 0 fail; lint reports **42 warnings /
  0 errors** with zero warnings from `packages/common` sources, and `max-depth` and
  `no-unused-vars` still at **0**

### Non-Goals

- Exempting tests from `complexity` or `max-depth` — the 6 test `complexity` warnings survive
  and stay visible
- Fixing the `as string` / `as boolean` casts in `Hierarchy.ts` — recorded as follow-up below
- The other packages' 36 remaining source warnings (`report-web` 13, `cli` 13,
  `device-node` 6, `goal-executor` 2, `cloud-core` 2)
- Promoting any rule from `warn` to `error`

### Design Decisions

#### Length-only test exemption
**Decision**: Turn off `max-lines-per-function` for test globs in a later flat-config object;
keep `complexity` and `max-depth` on for tests.
**Why**: A long test body is usually inlined arrange (fixtures, hand-built harness); hoisting
it into helpers moves setup away from the assertions it explains. Branching logic inside a
test is a different, real defect signal — a test that branches can pass for the wrong reason.
**Rejected**: Exempting tests from all three code-quality rules — that silently sweeps up the
6 test `complexity` findings that are each worth eventual attention.
*Introduced by*: 260729-24wz-exempt-test-lengths-refactor-common

#### Characterize-then-refactor for `Hierarchy.ts`
**Decision**: Write characterization tests against the unmodified source, mutation-verify
each, then refactor with the tests as an unmodified equivalence proof.
**Why**: `Hierarchy` is consumed by 16 files across `goal-executor`/`device-node` and no test
exercises any parse path; a silent behaviour change would surface as a runtime grounding
failure, not a test failure.
**Rejected**: Refactor-then-test — tests written after the refactor pin the refactor's
behaviour, not the original's, proving nothing about equivalence.
*Introduced by*: 260729-24wz-exempt-test-lengths-refactor-common

### Follow-Ups (recorded, deliberately not done here)

- **`Hierarchy.ts` lying casts**: field reads use `json['text'] as string` /
  `json['isScrollable'] as boolean` — a number-valued `text` yields a number typed as
  `string`, the same defect class as `SimctlClient._trimmed` (fixed in #164). Left
  not fixed here (the casts are consolidated into `_pick`'s single `as T`, not validated) because fixing it changes behaviour on malformed input and
  would void the equivalence proof. The characterization suite this change adds is the
  safety net a future fix needs.
- **`CliEnv.load` direct coverage**: `env.test.ts` does not test `load` at all; its coverage
  is indirect via `runCheck`. Direct unit tests for `load` (plain `.env` fallback precedence,
  `includeDotEnv: false`, `processEnv` injection) would make future `env.ts` work safer.

## Tasks

### Phase 1: Lint exemption + intermediate baseline

- [x] T001 Add a later config object to `eslint.config.mjs` turning off ONLY
  `max-lines-per-function` for `['**/test/**/*.{ts,tsx}', '**/*.test.{ts,tsx}',
  '**/*.spec.{ts,tsx}']`, with the shape-vs-branching comment from the intake <!-- R1 -->
- [x] T002 Run `npm run lint`; verify exactly 49 warnings / 0 errors and zero
  `max-lines-per-function` findings in test files; record the measured intermediate count in
  this plan's Notes before starting any refactor <!-- R1 -->

### Phase 2: Characterize `Hierarchy.ts` (unmodified source)

- [x] T003 Write `packages/common/src/models/test/Hierarchy.test.ts` pinning every behaviour
  listed in R2 against the unmodified source; build and confirm all pass (44/44 green on
  unmodified source) <!-- R2 -->
- [x] T004 Mutation-verify each characterization family: corrupt one behaviour in
  `Hierarchy.ts` (chain order swap, `??`→`||`, drop `:id/` post-processing, drop an `isImage`
  class marker, break `_parseBounds` object form, break the malformed-JSON catch, break DFS
  index assignment, drop `is_checked` from `isSelected`), confirm exactly the pinning test
  fails, restore, record the observed failure per mutation <!-- R2 -->

  Mutation evidence (11 mutations, all caught, source restored and re-verified green after
  each):
  1. M1 swap `text`/`title` alias order in `_parseFlatNode` → FAIL "flat text: text beats
     title beats value, in order" (+ the ''-kept test, since `{text:'', title:'b'}` then
     yields 'b')
  2. M2 first `??`→`||` in the flat text chain → FAIL exactly "flat text: empty string is
     kept, not replaced by a later alias"
  3. M3 `??`→`||` in the flat isScrollable chain → FAIL exactly "flat isScrollable: explicit
     false is kept, not replaced by is_scrollable true"
  4. M4 drop `is_checked` from the isSelected chain → FAIL exactly "flat isSelected:
     isSelected beats is_selected beats is_checked, defaults false"
  5. M5 remove the `:id/` post-processing block → FAIL exactly "flat id: \":id/\" resource
     ids are shortened to the last segment"
  6. M6 drop the `ImageButton` marker from the isImage disjunction → FAIL exactly "flat
     isImage: ImageButton class makes the node an image"
  7. M7 `'left' in rawBounds`→`'width' in rawBounds` in `_parseBounds` → FAIL "bounds:
     {left, top, right, bottom} object form is accepted" + "fromJson: bounds object form
     works on the tree path too"
  8. M8 `fromJsonString` catch rethrows instead of returning `new Hierarchy(null)` → FAIL
     exactly "fromJsonString: malformed JSON yields an empty hierarchy, not a throw"
  9. M9 child start index `currentIndex + 1`→`+ 2` in `_parseNode` → FAIL exactly "fromJson:
     DFS pre-order index assignment across nested children"
  10. M10 swap `contentDesc`/`accessibilityText` order in `_parseNode` → FAIL "fromJson:
      accessibilityText prefers contentDesc over accessibilityText" + the tree ''-kept test
  11. M11 constructor `params.text ?? null`→`params.text || null` → FAIL "HierarchyNode
      constructor: explicitly passed falsy values are kept" + both ''-kept tests (flat and
      tree flow through the constructor)

### Phase 3: Refactor `Hierarchy.ts`

- [x] T005 Refactor `packages/common/src/models/Hierarchy.ts`: add the `_pick` helper
  (first-present-key wins, `??` semantics, lying cast preserved), collapse the
  `_parseFlatNode` and `_parseNode` alias chains through it, keep `id` post-processing and
  the `isImage` disjunction as their own logic (disjunction moved verbatim into
  `_isImageNode`), and clear the constructor's complexity with an equivalent
  nullish-defaulting helper (`orDefault`) — casts untouched <!-- R3 -->
- [x] T006 Verify: characterization tests pass **unmodified** (44/44, zero edits to the test
  file since creation), `Hierarchy.ts` produces zero eslint findings, typecheck green
  <!-- R3 -->

### Phase 4: Refactor the three tested `common` functions

- [x] T007 Confirm and mutation-verify existing coverage per function: corrupt a behaviour in
  `runCheck`, `CliEnv.load`, and `resolveEnvironmentFile` that the planned refactor touches;
  confirm a named test in `packages/common/src/test/` fails; restore. Add a targeted test only
  where mutation exposes an uncovered behaviour the refactor would move <!-- R4 -->

  Coverage-reliance evidence (all restored and re-verified green after each):
  - C1 `runCheck`: drop `{ cwd: workspace.rootDir }` from the env `load` call → FAIL
    "runCheck loads workspace-root .env.<env> when cwd is nested under the workspace" +
    "runCheck resolves secrets from workspace-root .env.<env> without process.env"
  - C2 `runCheck`: drop the `resolvedIdentifier` enrichment on app overrides → FAIL exactly
    "runCheck fails when an iOS app override bundle ID does not match config"
  - E1 `CliEnv.load`: rename the `.env.${envName}` lookup → FAIL the same two
    workspace-root-dotenv tests as C1 (load is covered only through runCheck)
  - E2 `CliEnv.load`: remove the plain-.env no-overwrite rule (`!this._values.has(key)`) →
    **UNCAUGHT by the pre-existing suite (63/63 still passed)** — confirming the intake's
    coverage table was wrong for `env.test.ts` (it never touched `load`). Four targeted
    `CliEnv.load` unit tests added to `env.test.ts` (precedence .env.<env> > .env >
    (below) process env top, plain-.env-without-envName, includeDotEnv:false); re-applying
    E2 then FAILS exactly "CliEnv.load: .env.<env> wins over plain .env for shared keys;
    both files contribute"
  - W1 `resolveEnvironmentFile`: default lookup `'dev'`→`'development'` → FAIL exactly
    "runCheck defaults to dev when envName is omitted and dev.yaml exists"
  - W2 `resolveEnvironmentFile`: disable the sole-file fallback → FAIL exactly "runCheck
    falls back to the sole env file when envName is omitted and dev.yaml is absent"
- [x] T008 Refactor `packages/common/src/checkRunner.ts::runCheck` under 60 lines by
  extraction (`loadRuntimeEnv`, `resolveRequestedAppOverride`); existing tests pass
  unmodified <!-- R4 -->
- [x] T009 [P] Refactor `packages/common/src/env.ts::load` to complexity ≤ 12 by extracting
  the dotenv-file merge (`_mergeDotEnvFile` with a `keepExisting` mode); existing tests pass
  unmodified <!-- R4 -->
- [x] T010 [P] Refactor `packages/common/src/workspace.ts::resolveEnvironmentFile` under 60
  lines by extracting the no-requested-name tail (`selectDefaultEnvironmentFile`); existing
  tests pass unmodified <!-- R4 -->

### Phase 5: Full gate

- [x] T011 Run all five gate stages (`npm ci`, `npm run build --workspaces`,
  `npm run typecheck`, `npm run test:workspaces`, `npm run lint`), record each exit code;
  verify 42 warnings / 0 errors, zero `common` source warnings, 469 + N tests / 0 fail,
  `max-depth` and `no-unused-vars` at 0 <!-- R5 -->

  Gate results: `npm ci` exit 0 · `npm run build --workspaces` exit 0 · `npm run typecheck`
  exit 0 · `npm run test:workspaces` exit 0 with **517 tests / 517 pass / 0 fail**
  (469 baseline + 44 Hierarchy characterization + 4 CliEnv.load unit tests) · `npm run lint`
  exit 0 with **42 warnings / 0 errors**.

## Execution Order

- T001 → T002 (the 49-count measurement) MUST complete before T003 — the ordering is
  load-bearing: the intermediate baseline is what makes the refactor's delta attributable
- T003 → T004 → T005 → T006 strictly sequential (characterize on unmodified source, prove the
  tests can fail, then refactor, then re-prove)
- T007 before T008–T010 (coverage reliance verified before it is relied on)
- T011 last

## Acceptance

### Functional Completeness

- [x] A-001 R1: `eslint.config.mjs` contains a later config object disabling only
  `max-lines-per-function` for `**/test/**/*.{ts,tsx}`, `**/*.test.{ts,tsx}`, and
  `**/*.spec.{ts,tsx}`; `complexity` and `max-depth` still apply to test files
  *(review: verified via `eslint --print-config` — test file resolves
  `max-lines-per-function` severity **0**, `max-depth` `[1,4]`, `complexity` `[1,12]`;
  source file resolves `max-lines-per-function` severity **1** with `max: 60` unchanged)*
- [x] A-002 R2: `packages/common/src/models/test/Hierarchy.test.ts` exists and pins every
  behaviour family in R2 (alias precedence per chain, `??`-not-truthiness per chain, `id`
  post-processing, `isImage` paths, `_parseBounds` forms, `_parseNode` tree indexing, all
  three entry points, constructor defaults)
  *(review: 44 tests, all eight families present)*
- [x] A-003 R3: `Hierarchy.ts` has zero lint warnings; the `_pick` helper preserves `??`
  semantics; `id` and `isImage` keep their own logic
  *(review: `_pick`'s presence test is the explicit `value !== null && value !== undefined`,
  NOT truthiness — confirmed at source and by mutation)*
- [x] A-004 R4: `runCheck` ≤ 60 lines, `load` complexity ≤ 12, `resolveEnvironmentFile` ≤ 60
  lines; `packages/common` has zero source lint warnings
  *(review: only `common` warning is the pre-existing `workspace.test.ts` `complexity` — a
  test file, expected to survive)*

### Behavioral Correctness

- [x] A-005 R1: After T001 alone, `npm run lint` measured exactly 49 warnings / 0 errors
  (43 source + 6 test `complexity`), recorded before any refactor
  *(review: independently reconstructed both intermediate states — all sources at
  `origin/main` + new test file removed gave exactly **78** (23 src max-lines + 20 src
  complexity + 29 test max-lines + 6 test complexity); adding only the exemption object gave
  exactly **49**)*
- [x] A-006 R3: The characterization tests pass unmodified before AND after the Hierarchy
  refactor; the lying-cast defect is unfixed, consolidated into `_pick`'s single `as T`
  *(review: decisive — `origin/main`'s pre-refactor `Hierarchy.ts` checked into place with the
  test file sha-verified unchanged ran **44/44, exit 0**. The casts are NOT fixed: the lying
  read is now the single unvalidated `value as T` in `_pick` (:392), documented as deferred.
  See nice-to-have NTH-2 — "byte-for-byte untouched" is imprecise wording; the cast
  behaviour is preserved, but the casts were relocated into `_pick` rather than left in
  place. R3's normative phrasing, "the lying `as T` cast behaviour preserved", is met.)*
- [x] A-007 R4: The pre-existing `packages/common/src/test/` tests pass unmodified after the
  three extraction refactors
  *(review: full `common` suite 123/123)*

### Scenario Coverage

- [x] A-008 R2: Every characterization test family was mutation-verified — the corrupted
  behaviour, the exact failing test, and the observed failure are recorded
  *(review: 5 of the 11 recorded mutations re-derived independently, each restored to a
  sha-verified byte-identical source: (A) `_pick` presence test → truthiness ⇒ exactly the
  **9** falsy-but-present tests fail, one per chain; (B) `text`/`title` order swap ⇒ M1's two
  tests; (C) drop `is_checked` ⇒ M4's one test; (D) drop `:id/` post-processing ⇒ M5's one
  test; (E) DFS child index `+1`→`+2` ⇒ M9's one test. All matched the recorded evidence
  exactly.)*
- [x] A-009 R4: Coverage reliance for `runCheck`, `load`, and `resolveEnvironmentFile` was
  mutation-verified against named tests (not inferred from imports)
  *(review: E2 re-derived — dropping the plain-`.env` no-overwrite rule from
  `_mergeDotEnvFile` fails exactly the new "CliEnv.load: .env.<env> wins over plain .env"
  test and **nothing else in the whole 122-test `common` suite**, confirming the gap was real.
  `origin/main`'s `env.test.ts` contains zero occurrences of `CliEnv` — the intake's coverage
  table was indeed wrong, as R4 already recorded.)*

### Edge Cases & Error Handling

- [x] A-010 R2: Falsy-but-present values are pinned per chain (`text: ''` kept,
  `isScrollable: false` kept over `is_scrollable: true`, `isSelected: false` kept over
  `is_checked: true`); malformed JSON string yields an empty hierarchy, not a throw
  *(review: mutation A proves the pinning is load-bearing — 9 tests, one per chain)*
- [x] A-011 R1: No test file reports `max-lines-per-function` while
  `packages/common/src/test/workspace.test.ts` still reports its `complexity` warning (the
  exemption did not over-reach)
  *(review: 0 test `max-lines-per-function` findings; 6 test `complexity` findings survive
  across 4 files — `common/src/test/workspace.test.ts`, `cli/src/test/finalrun.test.ts`,
  `device-node/.../DeviceDiscoveryService.test.ts` ×3, `goal-executor/.../AIAgent.test.ts`)*

### Code Quality

- [x] A-012 Pattern consistency: New helpers follow the file's existing naming/structure
  conventions (private static `_`-prefixed members in `Hierarchy.ts`, module-level `function`
  helpers in `workspace.ts`/`checkRunner.ts`)
  *(review: `_pick`/`_isImageNode` private static `_`-prefixed; `_mergeDotEnvFile` private
  `_`-prefixed on `CliEnv`; `loadRuntimeEnv`/`resolveRequestedAppOverride`/
  `selectDefaultEnvironmentFile` module-level. `orDefault` is module-level rather than a
  `HierarchyNode` private static because it is consumed by a different class than `_pick`'s
  owner — acceptable.)*
- [x] A-013 No unnecessary duplication: One shared `_pick` helper for the alias chains rather
  than per-field variants; extraction helpers are single-purpose, not speculative
  *(review: parsimony pass — every new symbol has ≥1 call site; no pre-existing repo utility
  is duplicated (grep found no `pick`/`orDefault`/`coalesce`/`firstDefined` helper anywhere);
  net non-test source delta is **+84 lines** for 7 warnings cleared plus a policy change)*
- [x] A-014 Readability over cleverness: no `eslint-disable` directives added anywhere; the
  warnings are cleared by restructuring, not suppression
  *(review: diff grepped for `eslint-disable` / `ignores` / `@ts-` — none. No rule downgraded,
  no `max` raised: `max-lines-per-function` `max: 60`, `max-depth` `4`, `complexity` `12` all
  byte-identical to `origin/main`. See NTH-1 on `orDefault`.)*

### Security

- [x] A-015 **N/A**: lint-config and pure-refactor change; no security surface

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

### Measured checkpoints (filled during apply)

- Start baseline (measured before T001): **78 warnings / 0 errors** — 23 source
  `max-lines-per-function`, 20 source `complexity`, 29 test `max-lines-per-function`, 6 test
  `complexity`. Matches the intake's table exactly.
- After T001 (exemption only): **49 warnings / 0 errors** — 23 source
  `max-lines-per-function`, 20 source `complexity`, 6 test `complexity`, **0** test
  `max-lines-per-function`. Exactly the intake's predicted intermediate baseline (78 − 29).
- After T005 + T008–T010 (refactors): **42 warnings / 0 errors** — 20 source
  `max-lines-per-function`, 16 source `complexity`, 6 test `complexity`; `packages/common`
  sources at **0**; `max-depth` **0**; `no-unused-vars` (core + @typescript-eslint) **0**.
  Exactly the intake's expected end state (49 − 7).
- The three measured points: **78 → 49 → 42**.
- One post-equivalence-proof edit to the characterization file, disclosed: the tree-defaults
  test tripped the (deliberately retained) test `complexity` rule via 13 `node?.` optional
  chains; it was restyled to `assert.ok(node)` + plain property access AFTER the
  before/after equivalence proof completed. Assertions are semantically identical (arguably
  stronger — non-null is now asserted explicitly); all 44 re-verified green against the
  refactored source. No pinned behaviour was weakened and no assertion value changed.

## Deletion Candidates

- `plan.md` § Follow-Ups → "**`CliEnv.load` direct coverage**" — now **stale**: this change
  added the four direct `CliEnv.load` unit tests it asks for, covering exactly the three
  cases it names (plain `.env` fallback precedence, `includeDotEnv: false`, `processEnv`
  injection). The entry should be deleted rather than carried forward as an open follow-up.
- `packages/common/src/models/Hierarchy.ts:74-77` `HierarchyNode.isElementTypeButton()` —
  a pure delegation to `classContainsButton()` (:82), whose own first line repeats the
  identical `if (!this.clazz) return false` guard. **Pre-existing and NOT made redundant by
  this change** — recorded only because the review read this file closely; it is out of
  scope here and both methods have external consumers.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | The constructor's complexity-14 warning is cleared with a small nullish-defaulting helper (`value ?? fallback` moved into a function), not by forcing typed params through the `Record`-shaped `_pick` | The intake prescribes `_pick` for the alias chains only; the constructor is defaulting over a typed params object, and `??`-in-a-function is byte-equivalent semantics with zero behaviour change | S:75 R:90 A:90 D:85 |
| 2 | Certain | `_parseNode`'s field reads go through `_pick` too (single-key and two-key chains) | Intake assumption 5 already covers collapsing `_parseNode`'s chains; its reads are structurally identical to `_parseFlatNode`'s, and mutation-verified characterization tests pin both paths | S:80 R:90 A:90 D:85 |
| 3 | Confident | `isImage`'s disjunction is extracted verbatim into its own private helper rather than left inline | `_parseFlatNode` must land ≤ complexity 12; the id post-processing plus the 9-point isImage expression alone exceed it. Moving the expression unchanged preserves both the "keep own logic" instruction and equivalence | S:65 R:85 A:80 D:75 |
| 4 | Confident | `CliEnv.load`'s equivalence proof is the `runCheck` integration tests plus targeted unit tests added only where mutation exposes a gap the refactor touches | `env.test.ts` turned out not to cover `load` at all (contradicting the intake's coverage table); the intake's own rule — mutation-verify before relying — resolves this: rely on what mutation proves, add tests only for what it disproves | S:70 R:85 A:80 D:75 |
| 5 | Certain | The new characterization test file lives at `packages/common/src/models/test/Hierarchy.test.ts` | Mirrors the existing convention exactly (`models/test/DeviceAction.test.ts`), is covered by the new lint exemption globs, and is auto-discovered by the node test runner | S:85 R:95 A:95 D:90 |

5 assumptions (3 certain, 2 confident, 0 tentative).
