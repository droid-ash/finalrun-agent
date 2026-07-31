---
type: memory
description: "`repoPlaceholders.ts` (`packages/common`) — both directions of `${variables.*}`/`${secrets.*}` handling, and the `redactResolvedValue` contract every prompt, report and span write crosses: unanchored substring matching sorted longest-value-first (the substring-leak guard), an existing placeholder token consumed whole by the alternation's LAST branch so a value occurrence still wins there, and no redaction below `MIN_REDACTABLE_SECRET_LENGTH` (3) — with the residuals that leaves."
---
# Repo Placeholders (common)

**Domain**: common

## Overview

`packages/common/src/repoPlaceholders.ts` is the repo's whole handling of
`${variables.KEY}` / `${secrets.KEY}` tokens, in both directions:

- `resolveRuntimePlaceholders(value, bindings)` — forward: substitutes each token with its bound
  value (`String(...)` for a variable, the raw string for a secret) and re-emits the literal token
  for a key absent from the bindings.
- `containsSecretPlaceholder(value)` — a non-global `${secrets.KEY}` test.
- `redactResolvedValue(value, bindings)` — reverse: rewrites resolved secret *values* back to their
  `${secrets.KEY}` placeholder. Only this direction is security-relevant, and it is the only one
  with non-obvious semantics.

Three call sites consume `redactResolvedValue` through the `@finalrun/common` barrel, and one
algorithm serves all of them — so every bound and residual below holds equally for prompts, report
artifacts and spans:

- `AIAgent._redactPromptText` / `_redactPromptElements` (`packages/goal-executor/src/ai/AIAgent.ts`)
  — the LLM prompt path ([/cli/test-compiler.md](/cli/test-compiler.md)).
- `ReportWriter` (`packages/cli/src/reportWriter.ts`) — every string written beneath a run directory,
  including the copied device log ([/cli/report-writer.md](/cli/report-writer.md)).
- `ActionExecutor._redactRuntimeString` (`packages/goal-executor/src/ActionExecutor.ts`) — trace-span
  `detail` strings and the messages of `TimedActionPhaseFailure`.

## Requirements

### Requirement: Secret values match unanchored, longest value first
`redactResolvedValue` MUST match every eligible secret value through a **single** regex alternation
whose value branches are ordered by the longest-value-first sort
(`.sort(([, left], [, right]) => right.length - left.length)`), and the ordering MUST be preserved:
because the alternation picks the first branch that matches at a position, a shorter secret that is a
substring of a longer one would otherwise match inside the longer one's occurrence and leave the rest
of the longer secret raw in the output. That is the substring-leak guard, and
`packages/cli/src/test/testRunner.test.ts` pins it with an `abc`/`abcd` fixture. The source comment
cites that test by path — as the fixture that also fixes `MIN_REDACTABLE_SECRET_LENGTH` — so
relocating the test carries the citation with it.

Matching MUST stay **unanchored**. `\b`-style word boundaries would stop matching a secret embedded
in concatenated text (`user=xabcd1234y`), which is the same leak class the sort order guards against;
`packages/common/src/test/repoPlaceholders.test.ts` pins the embedded case so a later "cleanup"
cannot silently anchor the pattern.

Two lesser contract details hold at the boundaries: a falsy `value` (including `undefined` and `''`)
is returned as-is, and when two keys share one secret value the first key in longest-value-first
order owns the placeholder (`placeholderBySecretValue` is filled only where the value is absent).

#### Scenario: the longer of two overlapping secrets wins
- **GIVEN** bindings `{ secrets: { short: 'abc', long: 'abcd' } }`
- **WHEN** `redactResolvedValue('primary=abcd secondary=abc', bindings)` runs
- **THEN** the result is `primary=${secrets.long} secondary=${secrets.short}` — neither occurrence
  leaves a partial value behind

#### Scenario: an embedded value is still redacted
- **GIVEN** bindings `{ secrets: { KEY: 'abcd1234' } }`
- **WHEN** `redactResolvedValue('x=zabcd1234q', bindings)` runs
- **THEN** the result is `x=z${secrets.KEY}q`

### Requirement: An existing placeholder token is consumed whole, and a value occurrence still wins
`PLACEHOLDER_TOKEN_ALTERNATIVE` — a module-level, non-capturing mirror of `PLACEHOLDER_PATTERN`,
declared directly beside it — MUST be the **last** branch of the redaction alternation, after every
secret-value branch. Two properties follow, and both are load-bearing:

- **Tokens survive.** A secret value occurring strictly *inside* a literal `${secrets.KEY}` /
  `${variables.KEY}` token cannot match at the token's start position, so absent a value match there
  the token branch consumes the token whole and its interior is never exposed to the value branches.
  No nested, invalid `${secrets.${secrets.KEY}}` token can be produced. This matters because
  placeholder tokens are *expected* content on every consuming path: `testObjective` carries them by
  design (the compile-time guard leaves `${secrets.*}` unsubstituted —
  [/cli/test-compiler.md](/cli/test-compiler.md)), and report artifacts carry them from authored test
  steps such as `Enter ${secrets.email}`.
- **Value occurrences take precedence.** Where a secret value and a token both match at the same
  position, the value branch wins — leak-safety over token cosmetics. A secret value that *begins
  with* a literal token (e.g. `${secrets.BAR}hunter2`) is therefore redacted whole instead of having
  its raw tail left in the output.

The two patterns MUST be kept in sync by hand rather than derived from `PLACEHOLDER_PATTERN.source`:
that pattern captures, and splicing capturing groups into a composed alternation shifts group
numbering for any future branch that captures.

Two accepted edges follow from the replacer body (`placeholderBySecretValue.get(match) ?? match`):
a secret whose value is *exactly* a well-formed token is matched by its own value branch and rewritten
placeholder-to-placeholder through the map — harmless, since nothing raw appears on either side; and
consequently a token matched by the *token* branch corresponds to no secret value, so the `?? match`
fallthrough passes it through verbatim.

#### Scenario: a secret value equal to its own key name leaves the token intact
- **GIVEN** bindings `{ secrets: { PASSWORD: 'PASSWORD' } }`
- **WHEN** `redactResolvedValue('Use ${secrets.PASSWORD} then type PASSWORD manually', bindings)` runs
- **THEN** the result is `Use ${secrets.PASSWORD} then type ${secrets.PASSWORD} manually` — the token
  untouched, the prose occurrence redacted, and no nested token

#### Scenario: a token-prefixed secret value is redacted whole
- **GIVEN** bindings `{ secrets: { FOO: '${secrets.BAR}hunter2' } }`
- **WHEN** `redactResolvedValue('creds=${secrets.BAR}hunter2 end', bindings)` runs
- **THEN** the result is `creds=${secrets.FOO} end` — token protection does not preempt the value

### Requirement: Values shorter than MIN_REDACTABLE_SECRET_LENGTH are never redacted
The `replacements` filter MUST drop any secret value shorter than the named constant
`MIN_REDACTABLE_SECRET_LENGTH` (3) alongside falsy values, so such a value contributes no branch to
the alternation. A 1–2 character value collides with ordinary text near-certainly: substituting it
rewrites every incidental occurrence of that character sequence and destroys the surrounding string —
in the prompt case, turning model input into garbage. When only short-valued secrets are bound,
`replacements` is empty and the existing early return skips replacement entirely, so the input is
returned byte-identical.

#### Scenario: a single-character secret value leaves prose alone
- **GIVEN** bindings `{ secrets: { TOKEN: 's' } }`
- **WHEN** `redactResolvedValue('assemble the secrets list', bindings)` runs
- **THEN** the input is returned unchanged — every `s`, and the word `secrets` inside other tokens,
  survives

### Requirement: The residual exposures are stated, not closed
Callers MUST treat prompts, provider-side logs and report artifacts as secret-bearing. Three
residuals are accepted and deliberate:

- **Short values reach every sink raw.** A 1–2 character secret value is never redacted anywhere —
  prompts, report artifacts, spans, error strings. That is a real (documented) exposure, traded
  against corrupting arbitrary text; a value that short is also close to inference-proof by nature.
- **Long-enough prose collisions still corrupt.** A value of 3 characters or more that happens to be
  a common substring of surrounding prose still rewrites that prose. This is inherent to value-based
  substring redaction, now bounded to lengths where a collision indicates a genuine
  (mis)configuration rather than a statistical certainty.
- **A value inside a token is skipped.** Where a secret-value occurrence starts strictly inside a
  literal placeholder token and no value branch matches at the token's start, that occurrence is
  consumed as token protection instead of being redacted.

Redaction is also exact-match only, so an app-rendered transformation of a value (truncated,
reformatted, partially masked) passes through, and it operates on strings alone — screenshots are
outside this path entirely ([/cli/test-compiler.md](/cli/test-compiler.md),
[/cli/report-writer.md](/cli/report-writer.md)).

## Design Decisions

### Redaction semantics live in one shared function, never per call site
**Decision**: Both guards — token pass-through and the minimum redactable length — sit inside
`redactResolvedValue` itself, so all three consumers (prompt path, report writes, spans and error
strings) get identical semantics.
**Why**: The corruption these guards prevent is a property of the matching algorithm, not of any one
call site: every consumer feeds the function text that legitimately contains placeholder tokens, and
every consumer is equally exposed to a short or prose-colliding value. Forking the semantics would
leave two security-relevant implementations of the same rewrite to keep in sync, and the report path
would keep corrupting silently because reports are read by humans rather than parsed.
**Rejected**: Prompt-call-site-only wrappers — they leave the report and span paths producing nested
invalid tokens, and duplicate a security-relevant function.
*Introduced by*: 260731-gz13-fix-redaction-prompt-corruption

### The placeholder-token branch is last, not first
**Decision**: `PLACEHOLDER_TOKEN_ALTERNATIVE` is appended after every secret-value branch, so value
branches (longest first) are tried before it at each position.
**Why**: Token protection must never preempt redaction of a real secret-value occurrence. With the
token branch first, a value that begins with a literal token (`${secrets.BAR}hunter2`) is consumed as
token protection at the `$` position and its raw tail survives into the output — worse than having no
token protection at all. Placing it last costs nothing for the case token protection exists to fix,
because a value occurring strictly inside a token cannot match at the token's start position anyway.
**Rejected**: Token-branch-first — reads as the natural "protect tokens before touching anything"
ordering, and leaks the tail of every token-prefixed value.
*Introduced by*: 260731-gz13-fix-redaction-prompt-corruption

### The minimum redactable length is 3, fixed by the pinned fixtures
**Decision**: `MIN_REDACTABLE_SECRET_LENGTH = 3`.
**Why**: 3 is the largest threshold that leaves every pinned fixture byte-untouched — the 3-char
`abc` overlap-ordering secret in `packages/cli/src/test/testRunner.test.ts` and the 4-char `1080`
structural-JSON secret in `packages/goal-executor/src/ai/test/AIAgent.test.ts` — while still
excluding the 1–2 character values that make substitution destructive. The threshold is a named
constant precisely because its value is argued from those fixtures rather than from first principles.
**Rejected**: A threshold of 4 — it would force an edit to the pinned overlap-ordering fixture, which
the constitution's Test Integrity rule forbids; and 1 or 2, which leave the prose-destruction failure
mode open for exactly the values most likely to trigger it.
*Introduced by*: 260731-gz13-fix-redaction-prompt-corruption
