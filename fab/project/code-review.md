# Code Review

<!-- Optional review policy consumed by the validation sub-agent during review.
     Projects opt in by creating this file. All sections are independently optional.
     Delete or leave empty any section that doesn't apply to your project.

     This file guides the REVIEWING agent (critic). For the WRITING agent (author),
     see code-quality.md. Different cognitive modes, different concerns. -->

## Severity Definitions

<!-- How findings are prioritized. The review sub-agent classifies each finding
     into one of these tiers. Override the defaults below to match your project's
     quality bar. -->

- **Must-fix**: Spec mismatches, failing tests, checklist violations — always addressed during rework
- **Should-fix**: Code quality issues, pattern inconsistencies — addressed when clear and low-effort
- **Nice-to-have**: Style suggestions, minor improvements — may be skipped

Comment-content findings map as follows (policy in `code-quality.md` `## Comments`):

- **New restatement comments** introduced by a change → **Should-fix** — a code-quality issue; flag with file:line, addressed when clear and low-effort
- **Deleting a rationale comment that fails recoverability** (removing information the reader cannot get back from the code — the `drivers.yml` category) → **Must-fix** — information loss is expensive to reverse; the deleted knowledge may exist nowhere else

## Review Scope

<!-- What the review sub-agent inspects. Adjust to exclude generated code,
     vendor directories, or other paths that shouldn't be reviewed. -->

- Changed files only (files touched during apply)
- Skip generated code and vendor directories
- Skip binary files and assets

## False Positive Policy

<!-- How to suppress or override findings the reviewer flags incorrectly.
     Use inline comments in source code to mark intentional deviations. -->

- Inline `<!-- review-ignore: {reason} -->` in markdown files
- Inline `// review-ignore: {reason}` or `# review-ignore: {reason}` in code files
- Suppressed findings are noted in the review report but not counted as failures

## Rework Budget

<!-- Max auto-rework cycles before escalating to the user.
     Applies to /fab-fff and /fab-ff auto-rework loops. -->

- Max cycles: 3
- After 2 consecutive "fix code" attempts on the same issue, escalate to "revise tasks" or "revise spec"

## Project-Specific Review Rules

<!-- Add project-specific review rules here. Examples:
     - All public APIs need integration tests
     - No new dependencies without justification in the spec
     - Database migrations must be reversible
     - All user-facing strings must be internationalized -->

- Comment content is governed by `code-quality.md` `## Comments`; the reviewer applies the deletion test per claim, not per block or file
- **Sweep scope**: the planned restatement-comment sweep (~146 audit findings, executed as a separate later change) targets restatement comments only. **Non-obvious rationale blocks are out of the sweep's scope regardless of comment-to-code ratio** — explicitly including CI/workflow files such as `.github/workflows/drivers.yml` and `ci.yml`, whose rationale blocks (ruleset IDs, cross-file couplings, measured timings, rejected alternatives) landed recently and deliberately
- **Ambiguity bias**: when a comment is arguably either kind, keep it. A false keep costs a few lines; a false delete costs unrecoverable context
