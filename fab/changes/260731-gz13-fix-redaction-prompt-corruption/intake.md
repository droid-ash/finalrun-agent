# Intake: Fix Redaction Prompt Corruption

**Change**: 260731-gz13-fix-redaction-prompt-corruption
**Created**: 2026-07-31

## Origin

One-shot `/fab-new` invocation. The bug was found by CodeRabbit on PR #175 (change `260731-gzzl-fix-secret-prompt-leak-comment`) after it merged, and independently reproduced by the operator against the built dist. User's raw input:

> Fix a verified prompt-corruption bug in secret redaction, found by CodeRabbit on PR #175 after it merged and independently reproduced by the operator against the built dist. redactResolvedValue in packages/common/src/repoPlaceholders.ts replaces secret VALUES using UNANCHORED substring matching. PR #175 newly pointed it at the LLM prompt path (AIAgent._redactPromptText and _redactPromptElements), including testObjective which deliberately contains literal secrets placeholder tokens. Repro A: secret PASSWORD with value PASSWORD turns the literal token secrets.PASSWORD into a nested invalid token. Repro B, worse and not what CodeRabbit described: secret TOKEN with value s causes every letter s in ordinary prose to be substituted, mangling the whole string including the word secrets inside other tokens. So a single-character or common-substring secret value destroys arbitrary prompt text. A normal long value redacts correctly, so the flaw is specifically the unanchored match. CodeRabbit rated it Minor; operator assessment is must-fix because it can turn model input into garbage. JUDGEMENT REQUIRED: the same shared function is used by packages/cli/src/reportWriter.ts and by ActionExecutor for spans and error strings, where this has existed all along, so decide whether to fix the shared function (changes those paths too, probably correct) or only the prompt call sites, and justify. Do not reintroduce the substring-leak hazard the existing comment describes -- longest-value-first ordering is load-bearing and a test pins it. Add regression tests for value-equals-its-own-key-name, a single-character value, and a value that is a substring of prose. Do not weaken existing tests (constitution Test Integrity). Also fix two CodeRabbit doc findings on that change: intake.md line 16 wrongly says toPromptElementsForPlanner emits node.text (verify what it emits; keep node.text to the Grounder variant), and plan.md line 128 acceptance A-002 wrongly says redaction applies to the assembled text when AIAgent redacts each input BEFORE assembly. Do NOT commit fab/backlog.md.

Key decisions from the invocation: the corruption fix is must-fix (operator overrode CodeRabbit's Minor rating); the shared-vs-call-site scope decision is judgment-delegated with an explicit lean toward the shared function ("probably correct"); the longest-value-first ordering and its pinning test are load-bearing and must survive; three specific regression tests are required; existing tests must not be weakened (constitution Test Integrity); `fab/backlog.md` must never be committed.

## Why

**The pain point.** `redactResolvedValue` (`packages/common/src/repoPlaceholders.ts:27-65`) rewrites every occurrence of every secret *value* to its `${secrets.KEY}` placeholder using a single unanchored regex alternation over the raw values. PR #175 (change `260731-gzzl`) newly wired this into the LLM prompt path — `AIAgent._redactPromptText` (`packages/goal-executor/src/ai/AIAgent.ts:259-262`) and `_redactPromptElements` (`:265-278`) — including `testObjective`, which *deliberately* contains literal `${secrets.KEY}` placeholder tokens (the compile-time guard in `testCompiler.ts` leaves them unsubstituted by design). Two verified failure modes:

- **Repro A (token nesting):** secret `PASSWORD` with value `PASSWORD`. The unanchored match finds `PASSWORD` *inside* the literal token `${secrets.PASSWORD}` and rewrites it to `${secrets.${secrets.PASSWORD}}` — a nested, invalid token the model has never been taught.
- **Repro B (prose destruction — worse, and not what CodeRabbit described):** secret `TOKEN` with value `s`. Every letter `s` in ordinary prose is substituted with `${secrets.TOKEN}`, mangling the entire string — including the word `secrets` inside *other* placeholder tokens.

A normal long value redacts correctly, so the flaw is specifically the unanchored substring match applied to (a) text that legitimately contains placeholder tokens and (b) secret values short/common enough to occur incidentally in prose.

**The consequence of not fixing.** A single short or self-referential secret value silently turns the planner/grounder prompt into garbage — the model receives corrupted objectives, history, and UI-element text, and every downstream action degrades. CodeRabbit rated this Minor; the operator assessment is must-fix precisely because it corrupts *model input*, not just display output. The same corruption has existed all along on the report/span paths (`reportWriter.ts`, `ActionExecutor._redactRuntimeString`), where report artifacts also contain literal placeholder tokens (e.g. test steps like `Enter ${secrets.email}`), so Repro A applies there today too — it just went unnoticed because reports are read by humans, not fed back to a model.

**Why this approach.** Fix the shared function, not the prompt call sites: the corruption is inherent to the algorithm, not the call site; the report/span paths exhibit the identical defect; and forking redaction semantics per call site would create two divergent security-relevant implementations to keep in sync. The fix must be surgical: protect existing placeholder tokens from rewriting (fixes Repro A at any value length) and stop attempting redaction of values too short to be meaningfully redactable (fixes Repro B), while leaving unanchored matching in place for real-length values — anchoring (e.g. `\b` word boundaries) would *miss* secrets embedded in concatenated text (`x{secret}y`) and reopen the leak the redaction exists to close.

## What Changes

### 1. `redactResolvedValue` — protect placeholder tokens from rewriting (fixes Repro A)

`packages/common/src/repoPlaceholders.ts`. Current pattern construction (lines 55-64):

```ts
const secretPattern = new RegExp(
  replacements
    .map(([, secretValue]) => escapeRegExp(secretValue))
    .join('|'),
  'g',
);

return value.replace(secretPattern, (match) => {
  return placeholderBySecretValue.get(match) ?? match;
});
```

Append a non-capturing placeholder-token alternative as the **last** branch of the alternation *(revised in review cycle 1 — the token-FIRST mechanism originally specified here preempted redaction of a secret value that begins with a literal token, leaking its raw tail)*, so the value alternatives are tried first at every position and an existing `${secrets.KEY}` / `${variables.KEY}` token is consumed whole when no value matches there:

```ts
const secretPattern = new RegExp(
  [
    ...replacements.map(([, secretValue]) => escapeRegExp(secretValue)),
    PLACEHOLDER_TOKEN_ALTERNATIVE,
  ].join('|'),
  'g',
);
```

The replacer body is **unchanged**. A secret value occurring strictly *inside* a token (the Repro-A shape) cannot match at the token's start position, so absent a value match there the token branch consumes the token whole and its interior is never visible to the value alternatives; a value occurrence that *does* match at the same position wins over token protection — leak-safety over token cosmetics. Longest-value-first ordering among the value alternatives is untouched — the substring-leak guard and its pinning test (`packages/cli/src/test/testRunner.test.ts:144-154`, `redactResolvedValue preserves complete placeholders when secrets overlap`) remain byte-identical.

Edge cases (accepted, document in the comment; verified against the shipped code): a secret whose *value* is *exactly* a well-formed token is matched by its own value alternative and rewritten placeholder→placeholder via the map — harmless (nothing raw on either side) and identical to pre-change behavior; consequently a token matched by the token branch matches no secret value, so the replacer's `placeholderBySecretValue.get(match) ?? match` falls through and passes it through verbatim.

The token alternative mirrors `PLACEHOLDER_PATTERN` (line 3) but non-capturing; keep them adjacent and cross-reference in a comment rather than deriving one from the other with string surgery on `.source` (the capture groups differ).

### 2. `redactResolvedValue` — minimum redactable value length (fixes Repro B)

Extend the existing filter (line 42) to skip secret values shorter than **3 characters**:

```ts
const MIN_REDACTABLE_SECRET_LENGTH = 3;
// ...
const replacements = Object.entries(bindings.secrets)
  .filter(
    ([, secretValue]) =>
      Boolean(secretValue) && secretValue.length >= MIN_REDACTABLE_SECRET_LENGTH,
  )
  .sort(([, left], [, right]) => right.length - left.length);
```

Rationale for the threshold value: a 1–2 character "secret" occurs incidentally throughout arbitrary text, so substituting it destroys the string while providing no protection (the value remains trivially inferable). Threshold 3 is the **largest value that leaves every existing pinned test byte-untouched**: the substring-leak test uses a 3-char secret (`abc`, `testRunner.test.ts:147`) and the structural-JSON test uses a 4-char secret (`1080`, `AIAgent.test.ts:650`). Raising the threshold to 4 would require editing the pinned overlap-ordering fixture, which the instruction ("do not weaken existing tests") and constitution Test Integrity both counsel against. Residual (accepted, must be documented in the comment): a ≥3-char value that happens to be a common substring of prose still corrupts that prose — inherent to value-based substring redaction and now bounded to values long enough that a collision is a genuine (mis)configuration rather than a statistical certainty.

Behavioral consequence to document: secrets with 1–2 char values are now **never redacted anywhere** (prompts, report artifacts, spans, error strings). Previously they were "redacted" by mangling every occurrence of that character sequence in the surrounding text — strictly worse. With only short-valued secrets bound, `replacements` is empty and the existing early return (lines 44-46) skips replacement entirely.

### 3. No word-boundary anchoring for surviving values

Deliberate non-change: values ≥3 chars keep **unanchored** matching. Adding `\b`-style anchors would stop matching secrets embedded in concatenated text (`user=xabcd1234y` with secret `abcd1234`) — a leak regression on the report path, the exact hazard class the existing comment warns about. Add a pinning test (see §4) so a future "cleanup" cannot silently anchor the pattern.

### 4. Regression tests

New unit-test file `packages/common/src/test/repoPlaceholders.test.ts` (node:test + `node:assert/strict`, matching sibling tests in that directory), covering the shared function directly:

1. **Value equals its own key name** (Repro A): secrets `{ PASSWORD: 'PASSWORD' }`, input `Use ${secrets.PASSWORD} then type PASSWORD manually` → `Use ${secrets.PASSWORD} then type ${secrets.PASSWORD} manually` — the existing token is untouched; the prose occurrence of the value is still redacted.
2. **Single-character value** (Repro B): secrets `{ TOKEN: 's' }`, prose input (e.g. `assemble the secrets list`) is returned **unchanged**.
3. **Value that is a substring of prose**: a 2-char value (e.g. `{ AB: 'es' }`), input `these tests pass` returned unchanged.
4. **Embedded long value still redacted** (anti-anchoring pin): secret `{ KEY: 'abcd1234' }`, input `x=zabcd1234q` → `x=z${secrets.KEY}q`.
5. **Token protection composes with overlap ordering**: overlapping secrets (≥3 chars each) plus a literal token in the same input — longest wins outside the token, token survives verbatim.

Prompt-path integration tests appended to `packages/goal-executor/src/ai/test/AIAgent.test.ts` (existing redaction block starts at line 526):

6. `testObjective` containing a literal `${secrets.PASSWORD}` token with secret value `PASSWORD` reaches the planner prompt with the token intact (no nesting).
7. A single-char secret value leaves the assembled planner prompt text byte-identical to the unredacted assembly.

All existing tests pass **unmodified** — no fixture edits, no assertion changes (constitution Test Integrity; explicit instruction).

### 5. Comment updates falsified by the fix

Per the descriptive-claims discipline (dominant defect class in this repo), update the comments whose claims the fix changes — and only those:

- `packages/common/src/repoPlaceholders.ts:35-40` (substring-leak guard comment): still true, but extend to state the two new behaviors — existing placeholder tokens are protected by the trailing token branch (value occurrences win at the same position — see §1 as revised in review cycle 1), and values under `MIN_REDACTABLE_SECRET_LENGTH` are never redacted (with the why).
- `packages/goal-executor/src/ai/AIAgent.ts:233-258` (`_redactPromptText` doc): the "Exact-match is also the ceiling" paragraph gains the second ceiling — values shorter than 3 chars are never redacted, because substituting them corrupts arbitrary text without protecting anything.
- `packages/cli/src/testCompiler.ts:31` area ("redactResolvedValue also guards the write paths…"): verify at apply whether its claims survive; amend only if the min-length skip falsifies a stated guarantee.

### 6. Two doc corrections on change `260731-gzzl` artifacts (CodeRabbit findings, verified at intake)

Both verified against current code:

- **`fab/changes/260731-gzzl-fix-secret-prompt-leak-comment/intake.md:16`** claims "`Hierarchy.toPromptElementsForGrounder` … and `toPromptElementsForPlanner` emit `node.text` verbatim." False for the planner: `toPromptElementsForPlanner` (`packages/common/src/models/Hierarchy.ts:180-200`) emits only `index`, `contentDesc` (from `accessibilityText`), `class`, and `bounds` — no `text` field. Only the Grounder variant (`:213-230`, specifically `:216`) emits `node.text`. Correct the sentence to attribute `node.text` emission to the Grounder variant alone (the planner's slim payload can still echo a value via `contentDesc`, but that is a different field and the line must not claim `node.text`).
- **`fab/changes/260731-gzzl-fix-secret-prompt-leak-comment/plan.md:127`, acceptance A-002** (CodeRabbit cited line 128; the verified current location is 127) says redaction covers "element fields pre-serialization **plus the assembled text**." False: `AIAgent` redacts each input individually *before* assembly, and the shipped doc comment (`AIAgent.ts:244-246`) states there is deliberately NO pass over the assembled prompt text. Rewrite the parenthetical to "(element fields pre-serialization and each free-text input before assembly; deliberately no pass over the assembled text)".

These are text-only corrections to a completed change's artifacts (same class as PR #176's false-claim corrections); checkbox states and everything else stay untouched.

### Non-change: `resolveRuntimePlaceholders` and `containsSecretPlaceholder`

Both untouched — the bug is exclusively in the value→placeholder reverse direction.

## Affected Memory

- `common/repo-placeholders`: (new) the `redactResolvedValue` contract — unanchored substring semantics, longest-value-first substring-leak guard, placeholder-token pass-through, minimum redactable length and its residuals (short values never redacted anywhere; ≥3-char prose collisions still corrupt)
- `cli/report-writer`: (modify) the secret-redaction contract it documents gains the two new bounds (token pass-through, min-length skip applies to report artifacts/spans too)
- `cli/test-compiler`: (modify) its description of prompt-path redaction residuals gains the min-length exclusion alongside screenshots/re-rendered values/INFO output

## Impact

- `packages/common/src/repoPlaceholders.ts` — the fix (filter + pattern; replacer and sort untouched)
- `packages/common/src/test/repoPlaceholders.test.ts` — new unit-test file
- `packages/goal-executor/src/ai/test/AIAgent.test.ts` — added prompt-path regression tests
- `packages/goal-executor/src/ai/AIAgent.ts`, `packages/cli/src/testCompiler.ts` — comment-only updates
- `fab/changes/260731-gzzl-fix-secret-prompt-leak-comment/intake.md`, `plan.md` — two text-only corrections
- Behavior shift for **all** `redactResolvedValue` consumers (AIAgent prompts, reportWriter artifacts, ActionExecutor spans/errors): inputs containing literal placeholder tokens no longer corrupt; 1–2 char secret values are no longer redacted (previously they mangled the text instead)
- No API/signature changes; no changes to placeholder resolution
- `fab/backlog.md` is never staged or committed

## Open Questions

*(none — the invocation resolved scope, constraints, and required tests; the delegated judgment calls are recorded as graded assumptions below)*

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Fix the shared `redactResolvedValue`, not just the prompt call sites | Judgment delegated with an explicit lean ("probably correct"); verified the identical defect exists on report/span paths (report content carries literal `${secrets.*}` tokens from test steps), and forking redaction semantics would duplicate a security-relevant function | S:85 R:60 A:80 D:75 |
| 2 | Confident | Fix Repro A via a placeholder-token alternative in the redaction regex (revised to the LAST branch in review cycle 1 — token-FIRST leaked the raw tail of token-prefixed values); replacer unchanged | Minimal, mechanism-precise: a value strictly inside a token cannot match at the token's start, so the trailing token branch consumes tokens whole; preserves longest-first ordering and the pinned overlap test byte-identically | S:70 R:75 A:85 D:70 |
| 3 | Confident | Fix Repro B via `MIN_REDACTABLE_SECRET_LENGTH = 3` (skip 1–2 char values) | Threshold chosen as the largest value leaving pinned fixtures (`abc` 3-char, `1080` 4-char) untouched per Test Integrity; 1–2 char values are unprotectable by substitution; residual ≥3-char prose collision documented and accepted | S:50 R:80 A:55 D:40 |
| 4 | Certain | Doc-fix targets verified: gzzl `intake.md:16` (planner emits `contentDesc`/`class`/`bounds`, never `text`) and `plan.md:127` A-002 (redaction is per-input pre-assembly; CodeRabbit's cited line 128 is off by one) | Both claims re-verified against `Hierarchy.ts:180-230` and `AIAgent.ts:244-246` at intake | S:90 R:90 A:95 D:90 |
| 5 | Confident | New unit tests live in `packages/common/src/test/repoPlaceholders.test.ts`; prompt-path tests in `AIAgent.test.ts`; existing tests untouched | The function is owned by `packages/common` (sibling test dir exists); the lone existing unit test sits in cli's `testRunner.test.ts` and stays there untouched | S:45 R:90 A:75 D:60 |
| 6 | Confident | No word-boundary anchoring for values ≥3 chars; add an embedded-value pinning test | Anchoring would miss secrets embedded in concatenated text — a leak regression of the hazard class the load-bearing comment warns about | S:60 R:70 A:80 D:65 |
| 7 | Certain | `fab/backlog.md` is never committed or staged | Explicit instruction, repeated across recent changes | S:100 R:90 A:100 D:100 |
| 8 | Certain | Update the shipped comments whose claims the fix falsifies (repoPlaceholders guard comment, AIAgent redaction doc, testCompiler write-path note if affected) | Descriptive-claims rot is this repo's dominant defect class; the fix changes the documented redaction contract | S:70 R:85 A:85 D:80 |

8 assumptions (3 certain, 5 confident, 0 tentative, 0 unresolved).
