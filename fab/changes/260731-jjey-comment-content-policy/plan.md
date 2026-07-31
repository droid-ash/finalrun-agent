# Plan: Comment Content Policy

**Change**: 260731-jjey-comment-content-policy
**Intake**: `intake.md`

## Requirements

### Author Policy: fab/project/code-quality.md

#### R1: Comments section with core rule and deletion test
`fab/project/code-quality.md` MUST gain a new `## Comments` section placed after `## Anti-Patterns` and before `## Test Strategy` (preserving the file's existing Principles / Anti-Patterns / Test Strategy order). The section MUST state (a) the core rule — a comment must state what the code cannot show; comments earn their place by carrying information a competent reader cannot recover from the code, its names, and its structure, with rationale, non-obvious constraints and couplings (especially cross-file), references to external systems (ruleset IDs, ticket numbers, vendor behavior), and measured data (observed timings, billing rates) named as the qualifying categories — and (b) the prohibition — comments that restate what the code plainly says are prohibited, decided by the deletion test: if removing the comment leaves a competent reader able to recover everything it said from the code itself, it is restatement and must not be written.

- **GIVEN** `fab/project/code-quality.md` after this change
- **WHEN** an author (or the apply-stage agent) reads it before writing a comment
- **THEN** a `## Comments` section exists between `## Anti-Patterns` and `## Test Strategy` stating the core rule, the qualifying information categories, the prohibition on restatement, and the deletion test as the decision procedure

#### R2: Explicit CI/workflow rationale-exemption ruling
The `## Comments` section MUST state the explicit CI/workflow ruling: non-obvious rationale comments in CI and workflow files (`.github/workflows/*.yml`, build scripts, and config files generally) are the desired use of comments — not merely tolerated — and are **exempt from any restatement sweep**. It MUST state there is **no comment-to-code ratio cap** (recoverability, not density, is the test). It MUST name `.github/workflows/drivers.yml` (PR #168) as the canonical positive example — 67 comment lines against 18 functional lines, citing branch-protection ruleset `14531661` and `build.gradle.kts:104` to explain why a `paths` filter is safe on that workflow but would break `ci.yml` — and declare that file fully compliant because every block passes the deletion test. It MUST state the rationale that declarative files (workflow YAML) have the least self-describing code and the most invisible external coupling, so they legitimately carry the highest comment density in the repo.

- **GIVEN** the `## Comments` section
- **WHEN** a future sweep (or reviewer) evaluates a dense rationale block in a workflow file
- **THEN** the policy explicitly exempts non-obvious rationale in CI/workflow files from the sweep, rejects any ratio cap, and cites `drivers.yml` (67:18, ruleset `14531661`, `build.gradle.kts:104`) as compliant

#### R3: Per-claim judgement boundary
The `## Comments` section MUST state that the unit of judgement is the individual claim, not the file or the block: a single block may mix rationale and restatement (e.g., a rationale paragraph followed by a line restating the YAML key below it), and sweeping removes restatement sentences while keeping rationale sentences even when adjacent.

- **GIVEN** a comment block containing both a rationale paragraph and a restatement line
- **WHEN** the policy is applied to it
- **THEN** the policy directs judgement per individual claim — the restatement line is removable, the rationale paragraph is kept

#### R4: Anti-Patterns bullet
The existing `## Anti-Patterns` list in `fab/project/code-quality.md` MUST gain one bullet in the existing terse style: `- Restatement comments — comments that repeat what the adjacent code plainly says (fails the deletion test in ## Comments)`. (This is what the plan-generation checklist derivation picks up, since `_generation.md` derives Code Quality acceptance items from Principles + Anti-Patterns.)

- **GIVEN** `fab/project/code-quality.md` `## Anti-Patterns` after this change
- **WHEN** plan generation derives Code Quality acceptance items for a future change
- **THEN** a restatement-comments bullet exists in the list, matching the surrounding terse bullet style and pointing at the `## Comments` deletion test

### Reviewer Policy: fab/project/code-review.md

#### R5: Severity mapping for comment findings
`fab/project/code-review.md` MUST state the severity mapping for comment-content findings: **new restatement comments** introduced by a change → **Should-fix** (code-quality issue, flagged with file:line, addressed when clear and low-effort); **deleting a rationale comment that fails recoverability** (removing information the reader cannot get back from the code — the drivers.yml category) → **Must-fix** (information loss is expensive to reverse; the deleted knowledge may exist nowhere else).

- **GIVEN** `fab/project/code-review.md` after this change
- **WHEN** the review sub-agent classifies a comment-content finding
- **THEN** a new restatement comment maps to Should-fix and a deletion of non-recoverable rationale maps to Must-fix, with both mappings stated in the file

#### R6: Sweep-scope rules and ambiguity bias
The `## Project-Specific Review Rules` section of `fab/project/code-review.md` (currently an empty placeholder) MUST gain the sweep-governing rules: (a) comment content is governed by `code-quality.md` `## Comments` and the reviewer applies the deletion test per claim; (b) **sweep scope** — the planned restatement-comment sweep (~146 audit findings, a separate later change) targets restatement comments only, and non-obvious rationale blocks are out of the sweep's scope regardless of comment-to-code ratio, explicitly including CI/workflow files such as `.github/workflows/drivers.yml` and `ci.yml`, whose rationale blocks (ruleset IDs, cross-file couplings, measured timings, rejected alternatives) landed recently and deliberately; (c) **ambiguity bias** — when a comment is arguably either kind, keep it: a false keep costs a few lines, a false delete costs unrecoverable context.

- **GIVEN** `fab/project/code-review.md` after this change
- **WHEN** the later sweep change (or any reviewer) reads `## Project-Specific Review Rules`
- **THEN** the governance pointer, the sweep-scope exclusion of rationale blocks (naming `drivers.yml` and `ci.yml`), and the keep-on-ambiguity bias are all stated

### Scope: policy-only diff

#### R7: Only the two policy files change
The change's diff MUST be confined to `fab/project/code-quality.md`, `fab/project/code-review.md`, and this change's own `plan.md`. No source file (code, YAML, scripts) is edited, no comment is removed anywhere, and no lint/CI enforcement is added.

- **GIVEN** the completed change
- **WHEN** `git status --porcelain` is inspected
- **THEN** only the two policy files and `fab/changes/260731-jjey-comment-content-policy/plan.md` appear as modified/added

### Non-Goals

- No comment sweep — the ~146 audit findings are a separate later change; no comment is removed anywhere in this change
- No source edits — code, workflow YAML, and scripts are untouched
- No lint/CI enforcement — this is policy text consumed by the fab pipeline's apply/review stages, not automation

## Tasks

### Phase 2: Core Implementation

- [x] T001 Add the `## Comments` section to `fab/project/code-quality.md` (after `## Anti-Patterns`, before `## Test Strategy`): core rule + qualifying categories, prohibition + deletion test, the CI/workflow rationale-exemption ruling with no ratio cap and the `drivers.yml` canonical example, and the per-claim boundary for mixed blocks <!-- R1 R2 R3 -->
- [x] T002 Add the restatement-comments bullet to the existing `## Anti-Patterns` list in `fab/project/code-quality.md`, matching the surrounding terse bullet style <!-- R4 -->
- [x] T003 [P] Add the comment-finding severity mapping (new restatement → Should-fix; deleting non-recoverable rationale → Must-fix) to `fab/project/code-review.md` under `## Severity Definitions` <!-- R5 -->
- [x] T004 [P] Populate `## Project-Specific Review Rules` in `fab/project/code-review.md` with the governance pointer, sweep-scope rules (rationale blocks out of scope regardless of ratio, naming `drivers.yml` and `ci.yml`), and the ambiguity bias toward keeping <!-- R6 -->

### Phase 3: Integration & Edge Cases

- [x] T005 Verify both edited files are well-formed markdown consistent with their existing structure (section order preserved, heading levels intact) and `git status --porcelain` shows only the two policy files plus this change's plan.md <!-- R7 -->

## Acceptance

### Functional Completeness

- [x] A-001 R1: `fab/project/code-quality.md` has a `## Comments` section between `## Anti-Patterns` and `## Test Strategy` stating the core rule (a comment must state what the code cannot show), the qualifying information categories (rationale, non-obvious constraints/couplings, external references, measured data), the prohibition on restatement, and the deletion test
- [x] A-002 R2: the `## Comments` section exempts non-obvious rationale in CI/workflow files from any restatement sweep, states there is no comment-to-code ratio cap, and cites `.github/workflows/drivers.yml` (PR #168, 67:18, ruleset `14531661`, `build.gradle.kts:104`) as the canonical compliant example
- [x] A-003 R3: the `## Comments` section states per-claim judgement — mixed blocks are swept per sentence, keeping rationale even when adjacent to restatement
- [x] A-004 R4: `## Anti-Patterns` in `fab/project/code-quality.md` contains the restatement-comments bullet in the existing terse style, referencing the `## Comments` deletion test
- [x] A-005 R5: `fab/project/code-review.md` maps new restatement comments to Should-fix and deletion of non-recoverable rationale to Must-fix
- [x] A-006 R6: `## Project-Specific Review Rules` in `fab/project/code-review.md` states the governance pointer to `code-quality.md` `## Comments`, the sweep-scope exclusion of rationale blocks regardless of ratio (naming `drivers.yml` and `ci.yml`), and the ambiguity bias toward keeping

### Behavioral Correctness

- [x] A-007 R2: the policy's ruling is exemption-based, not ratio-based — no ratio threshold appears anywhere in either file, and density is explicitly rejected as the test in favor of recoverability

### Scenario Coverage

- [x] A-008 R6: reading `fab/project/code-review.md` alone, a reviewer can determine both the sweep's scope (restatement only; rationale out of scope) and the severity of both failure directions (adding restatement vs. deleting rationale)

### Edge Cases & Error Handling

- [x] A-009 R3: a mixed rationale-plus-restatement block is handled by the stated per-claim rule, not judged as a whole
- [x] A-010 R6: an ambiguous comment (arguably either kind) resolves to keep under the stated bias

### Code Quality

- [x] A-011 Pattern consistency: new policy text matches each file's existing structure and style (terse bullets, bold lead-ins, section ordering; existing HTML guidance comments preserved)
- [x] A-012 No unnecessary duplication: the two files divide cleanly — author-facing content rules in code-quality.md, reviewer-facing severity/scope in code-review.md, with cross-reference rather than repetition
- [x] A-013 Scope discipline (R7): `git status --porcelain` shows only `fab/project/code-quality.md`, `fab/project/code-review.md`, and this change's `plan.md` — no source file, workflow YAML, or comment sweep

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Severity mapping placement: extend the existing `## Severity Definitions` bullet list in code-review.md with the two comment-specific mappings (rather than burying them in Project-Specific rules) | Intake grants apply-stage discretion ("the mapping is what matters"); Severity Definitions is where the review sub-agent looks for tier classification, and the Project-Specific section cross-references it | S:70 R:90 A:85 D:75 |
| 2 | Certain | Preserve each file's existing HTML `<!-- -->` guidance comments and section scaffolding; add policy text around them without restructuring | Files are consumed by pipeline stages that expect the existing section contract; nothing in the intake asks for restructuring | S:85 R:95 A:95 D:90 |
| 3 | Certain | Verification for a markdown-policy-only change is structural (well-formed markdown, section order, `git status --porcelain` scope check) — no test suite is run | No test path matches `fab/project/*.md`; the intake's non-goals rule out code/CI changes, so there is nothing executable to test | S:80 R:95 A:95 D:90 |

3 assumptions (2 certain, 1 confident, 0 tentative).
