---
type: memory
description: "compileTestObjective (packages/cli/src/testCompiler.ts) and the secret-value exposure chain it anchors: only `${variables.*}` is substituted, so the compile-time guarantee covers the compiled objective alone — once typed, a resolved secret reaches the provider through the captured hierarchy and screenshots. Prompt text is redacted per input at the AIAgent seam when runtime bindings are wired; screenshots, app-rendered values, sub-3-char secret values, and INFO planner output are not."
---
# Test Objective Compilation (cli)

**Domain**: cli

## Overview

`compileTestObjective` (`packages/cli/src/testCompiler.ts`) renders a `TestDefinition` into the
planner objective: named sections (`Test Name`, `Test Path`, `Description`, `Setup`, `Steps`,
`Expected State`) with `${variables.*}` references interpolated, plus a trailing `Execution Rules`
block that teaches the model to treat a `${secrets.*}` placeholder as a logical token and echo it
verbatim. `VARIABLE_REFERENCE_PATTERN` never matches `${secrets.*}`, which is the repo's one
compile-time secret guarantee — and that guarantee is a single link in a longer chain. This file
carries the whole chain: what the compile-time scope covers, how a resolved secret value reaches the
model provider at runtime anyway, where redaction is wired, and what stays exposed.

## Requirements

### Requirement: The compile-time guarantee covers the compiled objective and nothing else
`VARIABLE_REFERENCE_PATTERN` MUST match `${variables.*}` only, so `${secrets.*}` tokens survive
compilation as literal text and no secret VALUE enters the compiled test artifact or the objective
portion of any prompt through placeholder substitution. Widening the pattern to secrets is the one
**durable** leak — values would be baked into the compiled artifact and into every planner objective
— which is why the guard comment on the pattern is load-bearing and MUST NOT be deleted as
redundant.

The guarantee is exact, not general: an unresolved `${secrets.KEY}` (absent from
`bindings.secrets`) also stays a literal token, while a `${variables.*}` value that happens to equal
a secret value still lands in the compiled text, because this pattern cannot tell the two apart.

#### Scenario: a secret placeholder survives compilation
- **GIVEN** a test whose step reads `Enter ${secrets.TOKEN} on the login screen`
- **WHEN** `compileTestObjective` renders it
- **THEN** the compiled objective still contains the literal `${secrets.TOKEN}` token, and the
  appended `Execution Rules` instruct the model to echo it exactly

### Requirement: A typed secret reaches the model provider through the runtime prompt path
Once `ActionExecutor._executeType` or `_executeDeeplink` resolves a placeholder through
`resolveRuntimePlaceholders` (`packages/common/src/repoPlaceholders.ts`) and the value lands on
screen, the next captured accessibility hierarchy carries it, and both prompt legs can emit it:

- **Grounder leg** — `Hierarchy.toPromptElementsForGrounder` emits the typed field's `text`,
  `hintText` and `error` verbatim ([/common/hierarchy.md](/common/hierarchy.md)).
- **Planner leg** — `toPromptElementsForPlanner` carries only `contentDesc`, and only for
  image/button-class nodes, so it surfaces a value only where one was rendered into accessibility
  text.
- **Screenshots** — the planner's pre/post-action screenshots and the grounder's screenshot show the
  same screen regardless of either element serialization.

Android password fields often mask text at the accessibility layer, but that is app- and
platform-dependent and MUST NOT be relied on: a plain-text field holding an API key, OTP or token
carries the value verbatim. The deeplink leg has no exposure of its own — a secret resolved into an
opened URL re-enters through whatever the resulting screen renders, so it inherits exactly the
hierarchy and screenshot status above (the span detail logs the unresolved `rawDeeplink`).

### Requirement: Prompt text is redacted per input at the AIAgent seam
`AIAgent` (`packages/goal-executor/src/ai/AIAgent.ts`) accepts optional `bindings: RuntimeBindings`,
wired from `createSessionExecutor` (`packages/cli/src/sessionRunner.ts`) as
`config.runtimeBindings`. When bindings are present, `_buildPlannerPrompt` and
`_buildGrounderPrompt` MUST replace occurrences of resolved secret values with their
`${secrets.KEY}` placeholder — via `redactResolvedValue` from `@finalrun/common`, whose matching
semantics are reused rather than reimplemented, and whose bounds the prompt path therefore inherits
in full: unanchored longest-value-first matching, an existing placeholder token consumed whole rather
than rewritten, and no redaction of a value shorter than `MIN_REDACTABLE_SECRET_LENGTH` (3)
([/common/repo-placeholders.md](/common/repo-placeholders.md)). Redaction applies:

- to every free-text input individually (`testObjective`, `act`, `history`, each `remember` entry,
  `preContext`, `appKnowledge`);
- to every string field of every element record and `availableApps` record, **before**
  `JSON.stringify`;
- to the DEBUG detail blobs (`_detailPlannerRequest`, `_detailGrounderRequest`) and the INFO-level
  grounder `act` output (`formatGrounderRequest`, `_summarizeGrounderRequest`), which print element
  and prompt content to a console that no write-path redaction covers.

There MUST be no redaction pass over assembled prompt text. The `Hierarchy` MUST NOT be mutated —
only serialized copies are rewritten — so index-based grounding (`flattenedHierarchy[idx]` → bounds
→ tap point) still resolves against the real on-screen values. Absent bindings, every path is a
strict no-op and prompt assembly is byte-identical.

The "Prompt-path secret redaction" block in `packages/goal-executor/src/ai/test/AIAgent.test.ts` pins
this behaviour case by case, including one test for each failure mode a pass over assembled text would
introduce (see Design Decisions) and one for each way unanchored value matching can corrupt prompt
text rather than protect it.

#### Scenario: the typed field is redacted and still locatable
- **GIVEN** bindings `{ secrets: { PASSWORD: 'hunter2-secret' } }` and a captured hierarchy whose
  typed field has `text: 'hunter2-secret'`
- **WHEN** `AIAgent` builds the grounder prompt
- **THEN** the emitted `ui_elements` carries `${secrets.PASSWORD}` and never the raw value, while
  `index`, `bounds`, `id` and `class` are unchanged and `flattenedHierarchy[idx]` still returns the
  original text and bounds

#### Scenario: a numeric secret colliding with a coordinate leaves structure intact
- **GIVEN** `secrets.PIN = '1080'` and an element with `bounds: [0, 0, 1080, 240]`
- **WHEN** the grounder prompt is built
- **THEN** the emitted `ui_elements` still parses as JSON, `bounds` is `[0, 0, 1080, 240]`, and only
  the field whose string value equals the secret becomes `${secrets.PIN}`

#### Scenario: the objective's own placeholder token survives its value's redaction
- **GIVEN** bindings `{ secrets: { PASSWORD: 'PASSWORD' } }` and a `testObjective` reading
  `Type ${secrets.PASSWORD} into the field, then type PASSWORD again`
- **WHEN** the planner prompt is built
- **THEN** the prompt carries `Type ${secrets.PASSWORD} into the field, then type ${secrets.PASSWORD}
  again` and never a nested `${secrets.${secrets.PASSWORD}}` token

#### Scenario: a secret value too short to redact leaves the prompt untouched
- **GIVEN** bindings `{ secrets: { TOKEN: 's' } }` and any planner request
- **WHEN** the planner prompt is built
- **THEN** the assembled text is byte-identical to a bindings-less agent's assembly of the same
  request — the value reaches the provider raw rather than mangling every `s` in the prompt

### Requirement: Residual exposure is stated, not closed
Prompts, provider-side logs and report artifacts MUST still be treated as secret-bearing. What
remains exposed after prompt-text redaction:

- **Screenshots** — sent to the provider unredacted, carried in the `llmCall` observability records,
  and written to the run report as `tests/<testId>/screenshots/NNN.jpg`. Masking needs visual
  field-region detection; dropping them would blind the planner.
- **App-rendered transformations** — a value the app truncates, reformats or partially masks is no
  longer an exact match and passes through.
- **Secret values shorter than three characters** — never redacted anywhere, so they reach the
  provider (and the report, and spans) raw. The trade is deliberate: substituting a 1–2 character
  value rewrites every incidental occurrence of that character sequence and turns the prompt into
  garbage, which corrupts model input rather than protecting anything
  ([/common/repo-placeholders.md](/common/repo-placeholders.md)).
- **Structural strings** — exact matching also rewrites an element's `id`, `class` or `contentDesc`
  when its content equals a secret value. That degrades the text the grounder reads; it cannot
  corrupt the emitted JSON, because `index` and `bounds` are non-string fields.
- **INFO planner reasoning** — `formatPlannerReasoning` prints the planner's `thought`, `action` and
  `reason` to stdout raw.

No full-prompt logging path exists: the detail blobs carry prompt lengths and three-element
excerpts, and `runner.log` writes cross `ReportWriter`'s redaction
([/cli/report-writer.md](/cli/report-writer.md)). Enabling full prompt logging, or treating provider
logs as secret-free, is exactly the conclusion the guard comment forbids.

## Design Decisions

### The guarantee comment states its scope and its residuals
**Decision**: The comment on `VARIABLE_REFERENCE_PATTERN` names its own boundary — compile-time
scope only — then states the runtime exposure with the concrete chain
(`ActionExecutor._executeType` → captured hierarchy → `Hierarchy.toPromptElements*` → `AIAgent`
prompt assembly), which redaction seam covers what, and which residuals stay open. It describes the
shipped state, never an aspirational one.
**Why**: A confident wrong guarantee is worse than no comment: a reader who believes the invariant
is enforced end-to-end makes decisions premised on it — enabling prompt logging, treating provider
logs as secret-free, skipping redaction on a new prompt surface — and each is a silent disclosure.
Because the comment exists so a future reader does not delete the control, its accuracy standard is
the highest in the file.
**Rejected**: A short unqualified claim that secret values never enter LLM prompts — true only of
the compiled objective, and false in the direction that costs the most.
*Introduced by*: 260731-gzzl-fix-secret-prompt-leak-comment

### Prompt-path redaction lives at the AIAgent seam, per input, before serialization
**Decision**: Redaction sits in `AIAgent`, applied to each free-text input and each record string
field before assembly and `JSON.stringify`, with no pass over the assembled prompt and no mutation
of the `Hierarchy`.
**Why**: This is the only seam where both the hierarchy and the runtime bindings are in scope, and
it covers every hierarchy-carrying prompt regardless of caller — planner, all grounder features,
post-action hierarchy. Per-input application is what makes redaction structure-blind: it never sees
serialized JSON, so it cannot rewrite it. Leaving the `Hierarchy` untouched keeps device-side
grounding provably unaffected, since taps resolve through `flattenedHierarchy[idx]` rather than
through prompt text.
**Rejected**: (a) redaction inside `Hierarchy.toPromptElements*` — `packages/common` has no access
to runtime bindings; (b) a pass over the assembled prompt text — it fails in both directions,
rewriting structural values that happen to equal a secret (a numeric PIN equal to a bounds
coordinate corrupts the `ui_elements` JSON) and missing exact secrets that serialization escaped
(`"` → `\"`, `\` → `\\`); (c) no mitigation at all — the structural half of the risk is
unit-provable, so documentation alone would under-deliver.
*Introduced by*: 260731-gzzl-fix-secret-prompt-leak-comment

### A redacted value becomes its placeholder, not an opaque mask
**Decision**: `redactResolvedValue` substitutes the `${secrets.KEY}` token, the same logical token
the compiled objective's `Execution Rules` already define.
**Why**: A verify-flow that reads "the field now contains `${secrets.PASSWORD}`" reads a token whose
semantics the model was already taught, so the redacted prompt stays reasonable-about rather than
merely censored.
**Rejected**: An opaque mask (`***`) — carries no meaning the Execution Rules define, and gives the
model no way to reason about what the field holds.
*Introduced by*: 260731-gzzl-fix-secret-prompt-leak-comment

### Screenshots stay unredacted and the residual is documented
**Decision**: No screenshot masking is attempted, in the prompt path or in the report. The exposure
is recorded in the source comment and here instead.
**Why**: Masking requires OCR-grade field-region detection — expensive and unreliable — and blurring
or omitting the screenshot destroys the planner's primary signal. An honest residual leaves the next
maintainer able to reason about the actual risk; a partial fix presented as closure recreates the
original defect at larger scale. `ReportWriter`'s whole-`runDir` sweep is a byte-level check, so it
proves no secret *string* reaches the report and can say nothing about pixels.
**Rejected**: (a) OCR/region-based masking — cost and reliability; (b) omitting screenshots from
prompts or reports — blinds the planner and removes the report's most useful failure evidence.
*Introduced by*: 260731-gzzl-fix-secret-prompt-leak-comment
