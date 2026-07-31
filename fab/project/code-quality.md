# Code Quality

<!-- Optional coding standards consumed during apply and review.
     Projects opt in by creating this file. All sections are independently optional.
     Delete or leave empty any section that doesn't apply to your project. -->

## Principles

<!-- Positive coding standards to follow during implementation. -->

- Readability and maintainability over cleverness
- Follow existing project patterns unless there's compelling reason to deviate
- Prefer composition over inheritance

## Anti-Patterns

<!-- Patterns to avoid. Flagged during review with file:line references on violation. -->

- God functions (>50 lines without clear reason)
- Duplicating existing utilities instead of reusing them
- Magic strings or numbers without named constants
- Restatement comments — comments that repeat what the adjacent code plainly says (fails the deletion test in ## Comments)

## Comments

<!-- Comment content policy. Consumed by apply (when writing comments) and
     review (when flagging them). Sweep scope and severity live in code-review.md. -->

**Core rule**: a comment must state what the code cannot show. Comments earn their place by carrying information a competent reader cannot recover from the code, its names, and its structure. Qualifying content includes:

- Rationale — why this and not the alternative
- Non-obvious constraints and couplings, especially cross-file ("changing X breaks Y")
- References to external systems — ruleset IDs, ticket numbers, vendor behavior
- Measured data — observed timings, billing rates

**Prohibition**: comments that restate what the code plainly says are prohibited. The decision procedure is the **deletion test**: if removing the comment leaves a competent reader able to recover everything it said from the code itself, it is restatement and must not be written.

**CI and workflow files**: non-obvious rationale comments in CI and workflow files (`.github/workflows/*.yml`, build scripts, and config files generally) are the desired use of comments — not merely tolerated — and are **exempt from any restatement sweep**. There is **no comment-to-code ratio cap**: density is not the test, recoverability is. The canonical positive example is `.github/workflows/drivers.yml` (PR #168): its comment blocks cite branch-protection ruleset `14531661` and `build.gradle.kts:104` to explain why a `paths` filter is safe on that workflow but would break `ci.yml` — every block passes the deletion test, so the file is fully compliant. Declarative files like workflow YAML have the *least* self-describing code and the *most* invisible external coupling, so they legitimately carry the highest comment density in the repo.

**Unit of judgement**: the individual claim, not the file or the block. A single block may mix both kinds — a rationale paragraph followed by a line restating the YAML key below it. Sweeping removes restatement sentences and keeps rationale sentences even when adjacent.

## Test Strategy

<!-- How tests relate to implementation.
     Values: test-alongside (default) | test-after | tdd -->

test-alongside
