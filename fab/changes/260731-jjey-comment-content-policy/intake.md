# Intake: Comment Content Policy

**Change**: 260731-jjey-comment-content-policy
**Created**: 2026-07-31

## Origin

One-shot `/fab-new` invocation. User's raw input:

> Write the project policy that governs comment content, into fab/project/code-quality.md and fab/project/code-review.md. Policy only -- do not edit any source file and do not perform any comment sweep. Current state: code-quality.md is 28 lines and never mentions comments at all; code-review.md is 52 lines and mentions them once. The audit found roughly 146 restatement comments, comments that restate what the code plainly says, and a separate later change will sweep them. This change writes the policy that stops them regrowing, so that the sweep happens under a stated rule rather than ad hoc judgement. REQUIRED: the policy must rule explicitly on non-obvious rationale comments in CI and workflow files. Decide this concrete live case and state the rule: PR #168 just added 67 comment lines against 18 functional lines in .github/workflows/drivers.yml, and that rationale cites a branch-protection ruleset ID and a specific build.gradle.kts line number to explain why a paths filter is safe on that workflow but would break ci.yml. That content is not restatement and a reader cannot recover it from the YAML. State whether such rationale blocks are exempt from the sweep, capped by some ratio, or in scope. If the policy stays silent on this, the later sweep will churn work that just landed on main.

Key decisions from intake (user explicitly delegated the CI-rationale ruling — "Decide this concrete live case and state the rule"):

- The delegated ruling was decided as: **non-obvious rationale blocks are exempt from the sweep, with no ratio cap** — recoverability of the content, not comment density, is the test. See Assumptions #2 and #3.
- The drivers.yml facts were verified against the live file at intake time: `.github/workflows/drivers.yml` (155 lines) carries rationale blocks citing repo ruleset `14531661` (lines 20, 41, 86, and the additive-check contract) and `drivers/android/app/build.gradle.kts:104` (the proto source-dir coupling, line 52) — none of which a reader can recover from the YAML itself.

## Why

1. **The pain point**: the codebase audit found ~146 restatement comments — comments that repeat what the adjacent code plainly says. Neither `fab/project/code-quality.md` (28 lines, no mention of comments) nor `fab/project/code-review.md` (52 lines, one incidental mention — the `review-ignore` suppression markers) states any rule about comment content. Without a stated rule, the apply and review stages have no standard to write to or flag against, so restatement comments regrow as fast as any sweep removes them.

2. **The consequence of not fixing it**: a separate, later change will sweep the ~146 restatement comments. If that sweep runs under ad hoc judgement instead of a stated rule, two failure modes are live: (a) the sweep deletes high-value rationale along with restatement — the immediate live risk being PR #168's `drivers.yml`, which landed on main with 67 comment lines against 18 functional lines, all of it non-recoverable rationale (ruleset IDs, cross-file line references, measured CI timings, rejected alternatives); (b) with no author-facing rule, new restatement comments keep appearing and the sweep must be repeated indefinitely.

3. **Why this approach**: policy-first, sweep-second. Writing the rule into the two project policy files means the sweep executes a stated, reviewable standard; the apply-stage agent (which reads `code-quality.md`) stops producing restatement comments at the source; and the review sub-agent (which reads `code-review.md`) flags regressions with a severity tier and an explicit carve-out protecting rationale blocks. The alternative — sweeping first and back-filling policy — was rejected by the user's framing: the sweep must "happen under a stated rule rather than ad hoc judgement."

## What Changes

Two policy files change. **No source file is edited and no comment sweep is performed** — this change is complete when the two markdown files state the rules below.

### fab/project/code-quality.md — author-facing comment content rules

Add a new `## Comments` section (after `## Anti-Patterns`, before `## Test Strategy` — the file's existing section order is Principles / Anti-Patterns / Test Strategy), and add one entry to the existing `## Anti-Patterns` list so the plan-generation checklist derivation (`_generation.md` step 6 derives Code Quality acceptance items from Principles + Anti-Patterns) picks it up.

The `## Comments` section must state, in substance:

1. **The core rule**: a comment must state what the code cannot show. Comments earn their place by carrying information a competent reader cannot recover from the code, its names, and its structure — rationale ("why this and not the alternative"), non-obvious constraints and couplings (especially cross-file: "changing X breaks Y"), references to external systems (ruleset IDs, ticket numbers, vendor behavior), and measured data (observed timings, billing rates) are all in this category.
2. **The prohibition**: comments that restate what the code plainly says are prohibited. A restatement comment is one whose deletion loses nothing — the deletion test: *if removing the comment leaves a competent reader able to recover everything it said from the code itself, it is restatement and must not be written.*
3. **The explicit CI/workflow ruling** (the REQUIRED ruling, decided at intake): non-obvious rationale comments in CI and workflow files (`.github/workflows/*.yml`, build scripts, and config files generally) are not merely tolerated — they are the desired use of comments, and they are **exempt from any restatement sweep**. There is **no comment-to-code ratio cap**: density is not the test, recoverability is. The canonical positive example is `.github/workflows/drivers.yml` (PR #168): 67 comment lines against 18 functional lines, citing branch-protection ruleset `14531661` and `build.gradle.kts:104` to explain why a `paths` filter is safe on that workflow but would break `ci.yml` — every block passes the deletion test, so the file is fully compliant. Declarative files like workflow YAML have the *least* self-describing code and the *most* invisible external coupling, so they legitimately carry the highest comment density in the repo.
4. **The boundary in both directions**: the same block may mix both kinds — a rationale paragraph followed by a line restating the YAML key below it. The unit of judgement is the individual claim, not the file or the block; sweeping removes restatement sentences and keeps rationale sentences even when adjacent.

The `## Anti-Patterns` addition (one bullet, matching the existing terse bullet style):

```markdown
- Restatement comments — comments that repeat what the adjacent code plainly says (fails the deletion test in ## Comments)
```

### fab/project/code-review.md — reviewer-facing sweep scope and severity

Two additions:

1. Under `## Severity Definitions` context (or as part of the Project-Specific rules — apply-stage discretion on exact placement, the mapping is what matters):
   - **New restatement comments** introduced by a change → **Should-fix** (code-quality issue: flag with file:line, addressed when clear and low-effort).
   - **Deleting a rationale comment that fails recoverability** (i.e., removing information the reader cannot get back from the code — the drivers.yml category) → **Must-fix** (information loss is expensive to reverse; the deleted knowledge may exist nowhere else).

2. Under `## Project-Specific Review Rules` (currently an empty placeholder section), add the sweep-governing rules:
   - Comment content is governed by `code-quality.md` `## Comments`; the reviewer applies the deletion test per claim.
   - **Sweep scope**: the planned restatement-comment sweep (~146 audit findings, executed as a separate later change) targets restatement comments only. **Non-obvious rationale blocks are out of the sweep's scope regardless of comment-to-code ratio** — explicitly including CI/workflow files such as `.github/workflows/drivers.yml` and `ci.yml`, whose rationale blocks (ruleset IDs, cross-file couplings, measured timings, rejected alternatives) landed recently and deliberately.
   - **Ambiguity bias**: when a comment is arguably either kind, keep it. A false keep costs a few lines; a false delete costs unrecoverable context.

### Explicit non-goals

- No source file (code, YAML, scripts) is touched.
- No comment is removed anywhere — the sweep is a separate later change.
- No lint/CI enforcement is added — this is policy text consumed by the fab pipeline's apply/review stages.

## Affected Memory

None. This change edits `fab/project/` policy files only — pipeline-configuration artifacts, not system behavior under `docs/memory/` domains. No memory file is created, modified, or removed.

## Impact

- `fab/project/code-quality.md` — new `## Comments` section + one `## Anti-Patterns` bullet (~25–35 lines added to a 28-line file).
- `fab/project/code-review.md` — severity mapping additions + `## Project-Specific Review Rules` content (~15–25 lines added to a 52-line file).
- Downstream (no edits in this change, behavior only): every future apply stage writes comments under the stated rule; every future review flags restatement as should-fix and rationale-deletion as must-fix; the later sweep change inherits its scope definition from these sections instead of ad hoc judgement — specifically protecting PR #168's `drivers.yml` rationale from churn.
- No code, tests, CI, or dependencies affected.

## Open Questions

None — the one contentious decision (the CI-rationale ruling) was explicitly delegated by the user and is decided and recorded in Assumptions #2–#3.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Core rule: a comment must carry information not recoverable from the code (rationale, constraints, external references, measured data); comments restating what the code plainly says are prohibited and are the sweep's sole target | Directly stated by the user ("comments that restate what the code plainly says"); the rule is the complement the user asked for | S:90 R:90 A:85 D:85 |
| 2 | Confident | The REQUIRED ruling: non-obvious rationale blocks in CI/workflow files (the PR #168 drivers.yml pattern) are **exempt from the sweep** — protected content, not merely tolerated | User delegated the decision but framed it decisively ("not restatement and a reader cannot recover it from the YAML"; silence "will churn work that just landed on main"); verified against the live file — every block cites non-recoverable facts (ruleset 14531661, build.gradle.kts:104, measured run times) | S:85 R:85 A:80 D:65 |
| 3 | Confident | No ratio cap — the "capped by some ratio" option is rejected; recoverability of content, not comment density, is the test (67:18 in drivers.yml is compliant) | A ratio cap would force deleting compliant rationale in exactly the declarative files that need it most; no principled threshold exists between 67:18 and any other ratio | S:75 R:85 A:80 D:70 |
| 4 | Certain | Placement split: author-facing content rules (## Comments section + anti-pattern bullet) in code-quality.md; reviewer-facing severity mapping + sweep scope in code-review.md | The files' own headers state the split ("This file guides the REVIEWING agent... For the WRITING agent... see code-quality.md"); user named both files as targets | S:80 R:95 A:95 D:85 |
| 5 | Confident | Severity mapping: new restatement comments → should-fix; deleting non-recoverable rationale → must-fix | Fits the existing severity definitions (should-fix = "code quality issues"; must-fix = expensive-to-reverse damage); asymmetry is deliberate — a false keep is cheap, a false delete loses unrecoverable context | S:60 R:85 A:75 D:70 |
| 6 | Certain | Decision procedure is the deletion test (a comment is restatement iff removing it loses nothing recoverable from the code), applied per claim not per block, with ambiguity resolved toward keeping | The user's own definition ("restate what the code plainly says") is the deletion test in other words; per-claim granularity follows from mixed blocks existing in the wild | S:70 R:90 A:85 D:75 |
| 7 | Certain | Scope: policy-only — the two markdown files are the entire diff; no source edits, no sweep, no lint/CI enforcement added | Explicit user constraint ("Policy only -- do not edit any source file and do not perform any comment sweep") | S:95 R:90 A:95 D:95 |

7 assumptions (4 certain, 3 confident, 0 tentative, 0 unresolved).
