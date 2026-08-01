# Plan: Fix Redaction Prompt Corruption

**Change**: 260731-gz13-fix-redaction-prompt-corruption
**Intake**: `intake.md`

## Requirements

### common: `redactResolvedValue` corruption fix

#### R1: Existing placeholder tokens survive redaction verbatim (Repro A)
`redactResolvedValue` (`packages/common/src/repoPlaceholders.ts`) MUST NOT rewrite the interior of an existing `${secrets.KEY}` / `${variables.KEY}` placeholder token. Implemented by appending the non-capturing alternative `\$\{(?:variables|secrets)\.[A-Za-z0-9_-]+\}` as the **LAST** branch of the redaction regex alternation, hoisted to a module-level constant declared beside `PLACEHOLDER_PATTERN` (adjacency makes the keep-in-sync instruction self-enforcing); the replacer body stays unchanged. The token alternative mirrors `PLACEHOLDER_PATTERN` but MUST NOT be derived from it via `.source` string surgery (the capture groups differ).

Branch-order rationale (the FIRST-branch variant shipped in rework cycle 0 and was rejected by review as a redaction regression): with the token branch tried **last**, a secret value whose text *begins with* a literal token (e.g. value `${secrets.BAR}hunter2`) is still matched by its own earlier value alternative and redacted whole; token-first preempts it at the `$` position and the raw tail leaks. Repro A stays fixed either way: a value occurring strictly *inside* a token cannot match at the token's start position, so the token branch consumes the token whole before the scan ever reaches the interior. Precedence rule (documented in the comment): a secret-value occurrence always wins over token protection when both match at the same position — leak-safety over token cosmetics.

Accepted edges (documented in the comment, claims verified against the shipped code): (a) a secret whose value is *exactly* a well-formed token is rewritten placeholder→placeholder via the map lookup — harmless (nothing raw on either side) and identical to pre-change behavior; (b) a token matched by the token branch never corresponds to any secret value (those matched earlier), so the replacer's `get(match) ?? match` falls through to `match` and passes it through verbatim.

- **GIVEN** bindings `{ secrets: { PASSWORD: 'PASSWORD' } }`
- **WHEN** `redactResolvedValue('Use ${secrets.PASSWORD} then type PASSWORD manually', bindings)` runs
- **THEN** the result is `Use ${secrets.PASSWORD} then type ${secrets.PASSWORD} manually` — the existing token untouched, the prose occurrence still redacted, no nested `${secrets.${secrets.PASSWORD}}` token

- **GIVEN** bindings `{ secrets: { FOO: '${secrets.BAR}hunter2' } }`
- **WHEN** `redactResolvedValue('creds=${secrets.BAR}hunter2 end', bindings)` runs
- **THEN** the result is `creds=${secrets.FOO} end` — the token-prefixed value is redacted whole, not preempted by token protection

#### R2: Secret values shorter than 3 characters are never redacted (Repro B)
`redactResolvedValue` MUST skip secret values shorter than a named constant `MIN_REDACTABLE_SECRET_LENGTH = 3` in its `replacements` filter. Rationale (documented in the comment, worded accurately — a 2-char secret is still a real secret): a 1–2 char value collides with ordinary text near-certainly, so substituting it corrupts arbitrary strings; the trade accepted here is that short secret values now reach prompts, report artifacts, and spans raw — an accepted, documented residual exposure, not "protecting nothing". 3 is the largest threshold that leaves every pinned fixture byte-untouched (3-char `abc` in `testRunner.test.ts`, 4-char `1080` in `AIAgent.test.ts`). Behavioral consequence (documented): 1–2 char secret values are now never redacted anywhere — prompts, report artifacts, spans, error strings. With only short-valued secrets bound, `replacements` is empty and the existing early return skips replacement entirely. Residual (accepted, documented): a ≥3-char value that is a common substring of prose still corrupts that prose.

- **GIVEN** bindings `{ secrets: { TOKEN: 's' } }`
- **WHEN** `redactResolvedValue('assemble the secrets list', bindings)` runs
- **THEN** the input is returned unchanged

#### R3: Unanchored matching and longest-value-first ordering are preserved
Values ≥ 3 chars MUST keep unanchored substring matching — no `\b`-style anchoring (anchors would miss secrets embedded in concatenated text like `x=zabcd1234q`, a leak regression of the hazard class the existing guard comment warns about). The longest-value-first `.sort(([, left], [, right]) => right.length - left.length)` MUST remain byte-identical, and the pinned overlap test (`packages/cli/src/test/testRunner.test.ts:144-154`) MUST pass unmodified. A new pinning test MUST cover the embedded-long-value case so a future "cleanup" cannot silently anchor the pattern.

- **GIVEN** bindings `{ secrets: { KEY: 'abcd1234' } }`
- **WHEN** `redactResolvedValue('x=zabcd1234q', bindings)` runs
- **THEN** the result is `x=z${secrets.KEY}q`

### common: unit-test coverage of the shared function

#### R4: New unit-test file pins the fixed contract
A new test file `packages/common/src/test/repoPlaceholders.test.ts` (node:test + `node:assert/strict`, matching sibling tests in that directory) MUST cover the shared function directly with six cases: (1) value-equals-its-own-key-name (R1 scenario), (2) single-character value returns prose unchanged (R2 scenario), (3) a 2-char value that is a substring of prose returns input unchanged, (4) embedded long value still redacted (R3 anti-anchoring pin), (5) token protection composes with overlap ordering — overlapping ≥3-char secrets plus a literal token in one input, where the token MUST be **discriminating**: its interior must contain one of the overlapping values (e.g. token `${secrets.abc}` with secrets `abc`/`abcd`), so the case fails against the pre-fix implementation (pre-fix → nested `${secrets.${secrets.…}}`, post-fix → token intact, longest still wins outside the token), (6) token-prefix regression pin (R1 second scenario): a secret value beginning with a literal token (`${secrets.BAR}hunter2`) is redacted whole, never left raw.

- **GIVEN** the new test file
- **WHEN** the `packages/common` suite runs
- **THEN** all six cases pass against the fixed implementation; cases (1) and (5) fail against the pre-change implementation (nested-token corruption), and case (6) fails against the rejected token-FIRST variant (raw-tail leak)

### goal-executor: prompt-path integration coverage

#### R5: Prompt-path regression tests in AIAgent.test.ts
Two tests appended to the existing redaction block in `packages/goal-executor/src/ai/test/AIAgent.test.ts` MUST verify the fix end-to-end at the prompt seam: (6) a `testObjective` containing a literal `${secrets.PASSWORD}` token with secret value `PASSWORD` reaches the planner prompt with the token intact (no nesting), and (7) a single-char secret value leaves the assembled planner prompt text byte-identical to the unredacted assembly. All existing tests pass unmodified — no fixture edits, no assertion changes (constitution Test Integrity).

- **GIVEN** an `AIAgent` with bindings `{ secrets: { PASSWORD: 'PASSWORD' } }` and a `testObjective` containing `${secrets.PASSWORD}`
- **WHEN** the planner prompt is built
- **THEN** the prompt contains the literal token and never `${secrets.${secrets.PASSWORD}}`

### docs: comments falsified by the fix

#### R6: Update exactly the comments the fix falsifies
Three comment sites, and only those: (a) the substring-leak guard comment in `repoPlaceholders.ts` gains the two new behaviors — the token branch tried last (with the precedence rule and both accepted edges from R1, exactly as verified: token-valued secrets rewrite placeholder→placeholder; only tokens matching no secret value fall through `?? match`) and values under `MIN_REDACTABLE_SECRET_LENGTH` never redacted (with R2's accurately-worded residual-exposure rationale — no "protecting nothing" absolutes); (b) the `_redactPromptText` doc in `packages/goal-executor/src/ai/AIAgent.ts` gains the second ceiling in its "Exact-match is also the ceiling" paragraph — values shorter than 3 chars are never redacted and reach the provider raw, the accepted trade for not corrupting arbitrary text; (c) the `packages/cli/src/testCompiler.ts:31` area is amended only if the min-length skip actually falsifies a stated guarantee (verified at apply: it does — one residual clause added). Every comment claim states what the code cannot show (deletion test) and none is falsified by the shipped code — this is the criterion review cycle 1 failed on.

- **GIVEN** the fixed implementation
- **WHEN** each updated comment is read against the shipped code
- **THEN** no claim is falsified by the fix and no unrelated comment is touched

#### R7: Two text-only corrections in change `260731-gzzl`'s artifacts
(a) `fab/changes/260731-gzzl-fix-secret-prompt-leak-comment/intake.md:16` MUST attribute `node.text` emission to the Grounder variant only — `toPromptElementsForPlanner` emits `index`/`contentDesc`/`class`/`bounds`, no `text` field — and the same sentence's citation `Hierarchy.ts:214-215` MUST be corrected to `:216`, where `node.text` is actually emitted (review nice-to-have 2: the corrected sentence must not keep a stale line number). (b) `fab/changes/260731-gzzl-fix-secret-prompt-leak-comment/plan.md:127` acceptance A-002 MUST state that redaction is per-input BEFORE assembly with deliberately no pass over the assembled text. Nothing else in those files changes — checkbox states stay. (c) This change's own `intake.md` accepted-edge sentence (the "nothing raw leaks" claim in § What Changes item 1, ~line 60) MUST be corrected to the verified R1 accepted edges — the intake is the state-transfer document and must not carry a claim review proved false.

- **GIVEN** the two corrected lines
- **WHEN** compared against `Hierarchy.ts:180-230` and `AIAgent.ts:244-246`
- **THEN** both claims are true of the shipped code and the rest of both files is byte-identical

### Non-Goals

- No changes to `resolveRuntimePlaceholders` or `containsSecretPlaceholder` — the bug is exclusively in the value→placeholder reverse direction
- No word-boundary anchoring — a leak regression, deliberately excluded (R3)
- No modification of any existing test (constitution Test Integrity)
- No commits during apply; `fab/backlog.md` is never staged or committed

### Design Decisions

#### Fix the shared function, not the prompt call sites
**Decision**: Both fixes land in the shared `redactResolvedValue`, changing behavior for all consumers (AIAgent prompts, reportWriter artifacts, ActionExecutor spans/errors).
**Why**: The corruption is inherent to the algorithm, not the call site; the report/span paths exhibit the identical Repro-A defect today (report artifacts carry literal `${secrets.*}` tokens from test steps); forking redaction semantics per call site would create two divergent security-relevant implementations.
**Rejected**: Prompt-call-site-only wrappers — leaves the report path corrupting and duplicates a security-relevant function.
*Introduced by*: 260731-gz13-fix-redaction-prompt-corruption

#### Token branch last, not first
**Decision**: The placeholder-token alternative is the LAST branch of the redaction alternation; secret-value alternatives (longest-first) are tried before it at every position.
**Why**: Token protection must never preempt redaction of a real secret-value occurrence. A value beginning with a literal token (`${secrets.BAR}hunter2`) matches its own alternative before the token branch and is redacted whole; Repro A is unaffected because a value strictly inside a token cannot match at the token's start position, so the token branch still consumes the token whole. Leak-safety over token cosmetics.
**Rejected**: Token-FIRST (rework cycle 0's implementation) — reviewed and rejected: it left the raw tail of token-prefixed values in the output, a redaction regression relative to the pre-change code, and forced comment claims the code falsifies.
*Introduced by*: 260731-gz13-fix-redaction-prompt-corruption

#### Threshold 3, chosen by the pinned fixtures
**Decision**: `MIN_REDACTABLE_SECRET_LENGTH = 3`.
**Why**: The largest value that leaves every existing pinned test byte-untouched (3-char `abc` overlap fixture, 4-char `1080` structural-JSON fixture); 1–2 char values are unprotectable by substitution anyway.
**Rejected**: Threshold 4 — would require editing the pinned overlap-ordering fixture, prohibited by Test Integrity and the explicit do-not-weaken instruction.
*Introduced by*: 260731-gz13-fix-redaction-prompt-corruption

## Tasks

### Phase 1: Core Implementation

- [x] T001 Add `MIN_REDACTABLE_SECRET_LENGTH = 3` and extend the `replacements` filter in `packages/common/src/repoPlaceholders.ts` to skip shorter values; sort stays byte-identical <!-- R2 -->
- [x] T002 Move the non-capturing placeholder-token alternative `\$\{(?:variables|secrets)\.[A-Za-z0-9_-]+\}` to the LAST branch of `secretPattern` in `packages/common/src/repoPlaceholders.ts` and hoist it to a module-level constant beside `PLACEHOLDER_PATTERN`; replacer body unchanged <!-- R1 --> <!-- rework: cycle 1 — token-FIRST preempts token-prefixed secret values (raw-tail leak, review must-fix 1); requirement revised to token-LAST -->
- [x] T003 Rewrite the substring-leak guard comment in `packages/common/src/repoPlaceholders.ts` per revised R6(a): token branch last with the precedence rule and the two verified accepted edges, min-length skip with the residual-exposure wording; delete the falsified "never a key of placeholderBySecretValue" and "nothing raw leaks" claims <!-- R6 --> <!-- rework: cycle 1 — shipped comment made two claims the code falsifies (review must-fix 1) -->

### Phase 2: Tests

- [x] T004 [P] Update `packages/common/src/test/repoPlaceholders.test.ts` to the six unit cases of revised R4: make case 5's token discriminating (`${secrets.abc}` — interior contains an overlapping value) and add case 6 (token-prefixed value `${secrets.BAR}hunter2` redacted whole) <!-- R4 --> <!-- rework: cycle 1 — case 5 fixture passed byte-identically against the pre-fix code (review should-fix 1); case 6 pins the token-FIRST leak -->
- [x] T005 [P] Append the two prompt-path regression tests (token-intact objective; single-char value byte-identical assembly) to the redaction block in `packages/goal-executor/src/ai/test/AIAgent.test.ts` <!-- R5 -->

### Phase 3: Comment & Doc Corrections

- [x] T006 [P] Add the min-length second ceiling to the `_redactPromptText` doc "Exact-match is also the ceiling" paragraph in `packages/goal-executor/src/ai/AIAgent.ts` <!-- R6 -->
- [x] T007 [P] Verify the `packages/cli/src/testCompiler.ts:31` area claims against the fixed code; amend only the clause the min-length skip falsifies <!-- R6 -->
- [x] T008 [P] Correct `fab/changes/260731-gzzl-fix-secret-prompt-leak-comment/intake.md:16` — attribute `node.text` emission to the Grounder variant only (planner emits `index`/`contentDesc`/`class`/`bounds`, no `text`) and fix the same sentence's citation `Hierarchy.ts:214-215` → `:216`; touch nothing else <!-- R7 --> <!-- rework: cycle 1 — corrected sentence kept a stale line citation (review nice-to-have 2) -->
- [x] T009 [P] Correct `fab/changes/260731-gzzl-fix-secret-prompt-leak-comment/plan.md:127` A-002 — redaction is per-input before assembly, deliberately no pass over the assembled text; checkbox state stays <!-- R7 -->
- [x] T011 [P] Correct this change's own `intake.md` accepted-edge sentence (§ What Changes item 1, ~line 60): replace the falsified "passes through unredacted — nothing raw leaks" claim with the verified R1 accepted edges (exact-token value rewrites placeholder→placeholder; token-prefixed value redacted whole under token-LAST) <!-- R7 --> <!-- rework: cycle 1 — intake carried the same falsified claim as the shipped comment (review must-fix 1) -->

### Phase 4: Verification

- [x] T010 Build + typecheck the workspaces and run the `packages/common`, `packages/cli`, and `packages/goal-executor` test suites; confirm every pre-existing test passes unmodified and `fab/backlog.md` is unstaged <!-- R3 --> <!-- rework: cycle 1 — re-verify after the token-LAST rework -->

## Execution Order

- T001 and T002 block T004/T005 (tests exercise the fixed function) and T003 (the comment describes the final shipped behavior)
- T010 runs last

## Acceptance

### Functional Completeness

- [x] A-001 R1: The redaction regex's **last** alternation branch is the non-capturing placeholder-token pattern, hoisted to a module-level constant beside `PLACEHOLDER_PATTERN`; an input containing a literal `${secrets.KEY}` token is never rewritten inside the token; a secret value beginning with a literal token is redacted whole; and the replacer body is unchanged
- [x] A-002 R2: `MIN_REDACTABLE_SECRET_LENGTH = 3` exists as a named constant and the `replacements` filter skips shorter values; a binding set containing only short values takes the existing empty-`replacements` early return
- [x] A-003 R4: `packages/common/src/test/repoPlaceholders.test.ts` exists with the six specified cases, all passing; case 5's token is discriminating (fails pre-fix) and case 6 pins the token-prefix leak (fails token-FIRST)
- [x] A-004 R5: The two new AIAgent prompt-path tests exist in the existing redaction block and pass
- [x] A-005 R7: The gzzl `intake.md:16` sentence attributes `node.text` to the Grounder variant only with the citation corrected to `Hierarchy.ts:216`, and gzzl `plan.md:127` A-002 describes per-input pre-assembly redaction with no assembled-text pass; this change's own `intake.md` accepted-edge sentence states the verified edges; no other line in any of the three files changed

### Behavioral Correctness

- [x] A-006 R1: `redactResolvedValue('Use ${secrets.PASSWORD} then type PASSWORD manually', { secrets: { PASSWORD: 'PASSWORD' }, variables: {} })` returns `Use ${secrets.PASSWORD} then type ${secrets.PASSWORD} manually`
- [x] A-007 R2: A single-char and a 2-char secret value leave arbitrary prose byte-identical through `redactResolvedValue`
- [x] A-008 R3: The longest-value-first sort is byte-identical to before the change and the pinned overlap test (`testRunner.test.ts:144-154`) passes unmodified

### Scenario Coverage

- [x] A-009 R5: A `testObjective` carrying a literal `${secrets.PASSWORD}` token with secret value `PASSWORD` reaches the planner prompt token-intact (no `${secrets.${secrets.` nesting), proven by test
- [x] A-010 R5: With a single-char secret bound, the assembled planner prompt is byte-identical to a bindings-less agent's assembly of the same request, proven by test

### Edge Cases & Error Handling

- [x] A-011 R3: An embedded long value (`x=zabcd1234q`, secret `abcd1234`) is still redacted — the anti-anchoring pin exists as a test
- [x] A-012 R1: Token protection composes with overlap ordering — overlapping ≥3-char secrets plus a **discriminating** literal token (`${secrets.abc}`, interior contains an overlapping value) in one input: longest wins outside the token, token verbatim, and the case fails against the pre-fix implementation (rework of cycle-1 should-fix 1: the original `${secrets.short}` fixture passed pre-fix byte-identically and pinned nothing)

### Code Quality

- [x] A-013 Pattern consistency: New test file matches sibling `packages/common/src/test` conventions (node:test, `node:assert/strict`, `.js` import specifiers); implementation matches surrounding style
- [x] A-014 No unnecessary duplication: The token alternative is a module-level constant declared directly beside `PLACEHOLDER_PATTERN` (physical adjacency, not just a comment pointer — rework of the cycle-1 nice-to-have), not derived via `.source` surgery, and no redaction logic is duplicated per call site
- [x] A-015 No magic numbers: The length threshold is the named constant `MIN_REDACTABLE_SECRET_LENGTH`
- [x] A-016 Comment content: Every added/updated comment passes the deletion test (rationale, cross-file couplings, accepted residuals — nothing restating adjacent code); no existing rationale claim was deleted; no comment claim is falsified by the shipped code (cycle-1 failure criterion: the "never a key of placeholderBySecretValue" / "nothing raw leaks" claims — both must be gone, replaced by the verified R1 edges and R2's residual-exposure wording)

### Security

- [x] A-017 R3: No word-boundary anchoring was introduced; unanchored matching for ≥3-char values is preserved and pinned; the cycle-1 token-prefix leak (value `${secrets.OLD}tail` surviving raw under token-FIRST) is gone under token-LAST and pinned by unit case 6; and no redaction regression exists beyond the two intended R1/R2 trades — 1–2 char values pass through raw (R2's accepted residual), and a value occurrence starting strictly inside a literal token is skipped when no value alternative matches at that position (R1's token protection working as specified) — *cycle-1 re-review*: verified by 26-case differential probe + 200k-input fuzz against the pre-change implementation; wording narrowed from "no regression of any kind" per that review's should-fix 3

### Removal Verification

- [x] A-018 **N/A**: No requirements are deprecated by this change

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- `packages/cli/src/test/testRunner.test.ts:144-154` (`redactResolvedValue preserves complete placeholders when secrets overlap`) — the overlap-ordering pin now has an equivalent in the owning package (`packages/common/src/test/repoPlaceholders.test.ts:44-57`, which composes the same `abc`/`abcd` fixture with a discriminating literal token), so the cli copy is a cross-package test of a `@finalrun/common` function. **Do not delete in this change**: constitution Test Integrity forbids touching it, and `repoPlaceholders.ts:37-38` cites it by path as the fixture that fixes `MIN_REDACTABLE_SECRET_LENGTH = 3` — any relocation must move that citation too.
- No production code became redundant: both fixes are additive guards inside `redactResolvedValue`; the replacer body, the sort, `resolveRuntimePlaceholders`, and `containsSecretPlaceholder` are all still reached.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | The `testCompiler.ts:31`-area comment IS amended: its claim that the prompt seam "redacts exact occurrences of resolved secret values" is falsified by the min-length skip (a 1–2 char occurrence is an exact match yet now passes through), so a minimal residual clause is added | The comment's own design decision (test-compiler memory) sets its accuracy standard as the highest in the file; the amendment is one clause, not a rewrite | S:70 R:85 A:80 D:70 |
| 2 | Confident | Test 7's "byte-identical to the unredacted assembly" is asserted by comparing the redacting agent's `textPrompt` against a bindings-less agent's `textPrompt` for the same request | Strongest available formulation — pins the whole assembled text, not selected substrings; prompt assembly is deterministic for a fixed request | S:60 R:90 A:80 D:70 |
| 3 | Certain | The two new AIAgent tests are appended at the end of the existing "Prompt-path secret redaction" block (before the retry section), reusing `makeAgent`/`buildPlannerPrompt` helpers | Purely structural; the intake names the block and the helpers exist | S:75 R:95 A:95 D:90 |
| 4 | Confident | Unit test 5 composes the pinned overlap fixture's secret pair (`abc`/`abcd`) with a literal token in one input | Reuses the exact overlap semantics the load-bearing cli test pins, making the composition test directly comparable to it | S:55 R:90 A:80 D:70 |
| 5 | Certain | A-005's "no other line changed" is read as: the two gzzl files change exactly one line each (verified via diff), while this change's own intake additionally updates the § What Changes item-1 mechanism paragraph and snippet — the explicitly mandated cycle-1 revision, not an "other" change | The rework dispatch orders the snippet update by name; both gzzl diffs are +1/−1 | S:75 R:90 A:85 D:80 |
| 6 | Certain | The plan's Deletion Candidates citation `repoPlaceholders.test.ts:44-54` is updated to `:44-57` (case 5 grew by its discriminating-token comment) | Descriptive-claims discipline: the rework shifted the cited block's line span; leaving it stale reintroduces the repo's dominant defect class | S:65 R:95 A:90 D:85 |

6 assumptions (3 certain, 3 confident, 0 tentative).
