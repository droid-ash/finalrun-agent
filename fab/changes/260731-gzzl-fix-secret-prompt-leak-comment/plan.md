# Plan: Fix Secret-Leak Guarantee Comment and Assess the Prompt-Path Secret Leak

**Change**: 260731-gzzl-fix-secret-prompt-leak-comment
**Intake**: `intake.md`

## Requirements

### CLI: testCompiler secret-guarantee comment

#### R1: The comment states exactly what is guaranteed and what is not
The comment at `packages/cli/src/testCompiler.ts` (currently lines 3–11) MUST be rewritten so that it:

- scopes the guarantee to what the file controls: `${secrets.*}` tokens are never substituted into the **compiled objective**, so the compiled test text and the objective portion of every prompt carry placeholders, not values;
- keeps the true and load-bearing warning that widening `VARIABLE_REFERENCE_PATTERN` to secrets would substitute real values into every planner/grounder call;
- states plainly that resolved secret values DO reach the model provider at runtime — via the post-typing accessibility hierarchy (`node.text` of the typed field) and via screenshots of the same screen — naming the chain (`ActionExecutor._executeType` → captured hierarchy → `Hierarchy.toPromptElementsForGrounder`/`ForPlanner` → `AIAgent` prompt assembly) so the next maintainer can follow it;
- states where redaction IS wired (report artifacts, spans, error strings via `reportWriter.ts` and `ActionExecutor._redactRuntimeString`; plus whatever prompt-path redaction ships in this change) and where it is NOT (screenshots, non-exact renderings of a secret);
- warns that it is NOT safe to enable full prompt logging or treat provider-side logs as secret-free on the strength of this guarantee;
- describes the **post-change** state exactly — it MUST NOT overstate the shipped mitigation.

- **GIVEN** a maintainer reading `testCompiler.ts` to decide whether prompt logging is safe to enable
- **WHEN** they read the rewritten comment
- **THEN** they learn the guarantee covers only the compiled objective, that prompts still carry secrets via screenshots (and via any secret rendering that is not an exact value match), and where the redaction seams live

### Goal-Executor: prompt-path leak assessment

#### R2: A written, honest assessment of the leak legs exists and is reflected in the comments
The change MUST carry an explicit assessment of the three leak legs (hierarchy, screenshot, deeplink) with an honest verdict, recorded in this plan's `### Design Decisions` and reflected in the rewritten comment(s). The verdict MUST state that full remediation is impossible within this change's scope (the screenshot leg cannot be redacted cheaply and omitting screenshots would blind the planner), and MUST accurately describe what the shipped mitigation covers and what remains residual.

- **GIVEN** the shipped change
- **WHEN** the plan's Design Decisions and the source comments are read together
- **THEN** each leg's exposure, mitigation status, and residual risk are stated accurately, with no leg omitted or overstated

### Goal-Executor: exact-value prompt-text redaction (mitigation)

#### R3: AIAgent redacts resolved secret values from all outbound prompt text
`AIAgent` (packages/goal-executor/src/ai/AIAgent.ts) MUST accept optional `RuntimeBindings` and, when present, rewrite exact occurrences of resolved secret values back to their `${secrets.KEY}` placeholders in every prompt it assembles, reusing `redactResolvedValue` from `@finalrun/common` (no reimplementation):

- element records produced by `toPromptElementsForPlanner`/`toPromptElementsForGrounder` (and `availableApps` records) MUST have their string fields redacted **before** JSON serialization (so a secret containing JSON-escapable characters is still caught);
- every free-text input (testObjective, history, each `remember` entry, act, preContext, appKnowledge) MUST be redacted individually BEFORE assembly — covering model-echo legs where the model transcribed an on-screen secret into `remember`/`analysis`. There MUST be NO redaction pass over assembled text containing serialized JSON: a post-serialization pass rewrites structural values that equal a secret (numeric PIN vs bounds coordinate → corrupted ui_elements JSON) and misses exact secrets altered by JSON escaping;
- the debug detail blobs (`_detailPlannerRequest`/`_detailGrounderRequest`) MUST pass through the same redaction, since they print element content;
- the `Hierarchy` object MUST NOT be mutated — redaction applies to serialized copies only, so index-based grounding (`flattenedHierarchy[idx]` → bounds → tap point) is untouched;
- `packages/cli/src/sessionRunner.ts` `createSessionExecutor` MUST pass `config.runtimeBindings` into the `AIAgent` construction;
- absent bindings, behavior MUST be byte-identical to today (passthrough).

Screenshots are explicitly NOT redacted (see R2 / Non-Goals).

- **GIVEN** bindings `{ secrets: { PASSWORD: 'hunter2-secret' } }` and a captured hierarchy whose typed field has `text: 'hunter2-secret'`
- **WHEN** `AIAgent` builds the next grounder or planner prompt
- **THEN** the outbound prompt text contains `${secrets.PASSWORD}` and never the raw value, while the element's `index`, `bounds`, `id`, and `class` fields are unchanged

#### R4: Grounding demonstrably survives redaction
The mitigation ships ONLY with proof that grounding still works: the existing `packages/goal-executor`, `packages/cli`, and `packages/common` test suites pass, plus targeted tests showing (a) an element whose `text` was redacted to a placeholder is still locatable — `index`/`bounds`/`id` intact in the prompt and the un-mutated `Hierarchy` still resolves `flattenedHierarchy[idx]` to real bounds — and (b) the no-bindings path is unchanged.

- **GIVEN** the targeted tests and existing suites
- **WHEN** they run after the mitigation lands
- **THEN** all pass, proving element location and typing flows are structurally unaffected

### Process: repo hygiene constraint

#### R5: `fab/backlog.md` is never staged or committed
This change MUST NOT `git add` or commit `fab/backlog.md` at any stage. Apply commits nothing at all; ship MUST stage explicit paths rather than `git add fab/`.

- **GIVEN** the apply and ship stages of this change
- **WHEN** any git staging happens
- **THEN** `fab/backlog.md` remains untracked and unstaged

### Non-Goals

- Screenshot redaction — requires OCR-grade field-region detection; unreliable and expensive, and blurring/omitting the screenshot would blind the planner whose primary signal it is. Documented as residual exposure instead.
- A prompt-logging feature or opt-in flag — no full-prompt logging path exists today (`Logger.d` detail blobs carry element excerpts and prompt lengths, not the full prompt; `runner.log` writes are already redacted by `reportWriter`). The rewritten comment's warning is the deliverable for intake §3(b).
- Redaction inside `Hierarchy` (packages/common) — it has no access to runtime bindings; the seam belongs in goal-executor prompt assembly (intake assumption 4).
- Redacting non-exact renderings of a secret (truncated, reformatted, partially masked by the app) — impossible with value-match redaction; documented as residual.

### Design Decisions

#### Leak assessment: hierarchy leg — real, and mitigated by exact-value prompt redaction
**Decision**: Confirmed the leak chain end-to-end and mitigate it at the `AIAgent` prompt-assembly seam. `ActionExecutor._executeType` resolves `${secrets.*}` via `resolveRuntimePlaceholders` (ActionExecutor.ts:363-366) and types the real value; the next capture's `node.text` (and possibly `hintText`/`error`/`accessibilityText`) carries it; `Hierarchy.toPromptElementsForGrounder` (Hierarchy.ts:212-229) emits `text`/`hintText`/`error` verbatim and `toPromptElementsForPlanner` emits `contentDesc`; `AIAgent._buildGrounderPrompt`/`_buildPlannerPrompt` serialize those into the prompt and `_callLLM` sends them to the provider. Nothing in `packages/goal-executor/src/ai/` redacted anything before this change. Android password fields often mask text at the accessibility layer (`•••`) but that is app/platform-dependent — plain-text fields (API keys, OTPs, tokens) leak verbatim. The mitigation substitutes exact value occurrences with the `${secrets.KEY}` placeholder — the same logical token the compiled objective's Execution Rules already teach the model — so verify-flows ("the field now contains the password") read a token the model already understands, and structure (index/bounds/id/class/flags) is untouched.
**Why**: The seam has bindings in scope (wired from `sessionRunner`), covers every hierarchy-carrying prompt regardless of caller (planner, all grounder features, post-action hierarchy), and never mutates the `Hierarchy`, so device-side grounding (index → bounds → tap point) is provably unaffected. Every input is redacted individually before assembly and serialization — element/app record fields before `JSON.stringify` (escaping cannot hide a secret containing `"` or `\`), and each free-text input (objective, act, history, remember entries, preContext, appKnowledge) on its own — so redaction never touches serialized structure.
**Rejected**: (a) redaction inside `Hierarchy.toPromptElements*` — packages/common has no bindings access; (b) masking with an opaque string (`***`) — breaks the token semantics the Execution Rules define and gives the model no way to reason about the field's content; (c) no mitigation — the gate (existing suites + targeted structural proof) is satisfiable, so shipping assessment-only would under-deliver against the intake's criterion; (d) a whole-text pass over the assembled prompt (the first-cut design, failed in review cycle 1) — reproduced defects: a numeric secret equal to a bounds coordinate rewrote serialized structure and corrupted the ui_elements JSON, and a `"`/`\`-bearing secret inside the stringified `remember` array survived unredacted because escaping broke the exact match.
*Introduced by*: 260731-gzzl-fix-secret-prompt-leak-comment

#### Leak assessment: screenshot leg — real, NOT mitigated (residual exposure)
**Decision**: `request.preActionScreenshot`/`postActionScreenshot` (planner) and `request.screenshot` (grounder, visual grounder) capture the same screen that shows the typed value unless the app masks it visually; they are sent to the provider unredacted, ride in the `llmCall` observability records (`prompt: messages`), and are written to the run report (`screenshots/NNN.jpg`). No mitigation is attempted: masking requires visual detection of the field region (OCR-grade, unreliable, expensive) and omitting or blurring the screenshot would blind the planner. This is documented residual exposure — in this plan and in the rewritten `testCompiler.ts` comment.
**Why**: An honest residual beats a fake fix; the intake explicitly directs "no mitigation — document as residual exposure".
**Rejected**: OCR/region-based masking — cost and reliability; screenshot omission — destroys the planner's primary signal.
*Introduced by*: 260731-gzzl-fix-secret-prompt-leak-comment

#### Leak assessment: deeplink leg — real, partially mitigated via the hierarchy leg
**Decision**: `_executeDeeplink` resolves `${secrets.*}` into the URL it opens (ActionExecutor.ts:689-698). If the resulting screen renders the URL (browser address bar, error dialog), the value re-enters the captured hierarchy — now covered by the same prompt-text redaction — and the screenshot, which remains residual. The span detail logs `rawDeeplink` (the unresolved form), so the trace path was already safe.
**Why**: The deeplink leg has no seam of its own — its exposure IS the hierarchy + screenshot legs on the next capture, so it inherits exactly their mitigation status.
**Rejected**: refusing to resolve secrets in deeplinks — a behavior regression for legitimate authenticated-URL flows, out of scope.
*Introduced by*: 260731-gzzl-fix-secret-prompt-leak-comment

#### Verdict: full remediation is impossible; prompt-text leg is closed, screenshots stay open
**Decision**: After this change, resolved secret values no longer reach the provider through prompt TEXT for exact-value occurrences; they still reach the provider through screenshots, and through any on-screen rendering that is not an exact value match (truncation, reformatting, partial masking by the app). Provider-side logs and full prompt logging must therefore still be treated as secret-bearing.
**Why**: This is the accurate post-change state; both the comment and memory must carry it rather than an aspirational "fixed" claim — a confident wrong guarantee was the original defect.
**Rejected**: describing the change as closing the leak — overstatement, recreates the defect at bigger scale.
*Introduced by*: 260731-gzzl-fix-secret-prompt-leak-comment

## Tasks

### Phase 2: Core Implementation

- [x] T001 Add optional `bindings?: RuntimeBindings` to `AIAgent` (packages/goal-executor/src/ai/AIAgent.ts): store it, add private redaction helpers (per-record-field and per-free-text-input, all applied BEFORE assembly/serialization, no assembled-text pass), apply them in `_buildPlannerPrompt` (objective, history, remember entries, preContext, appKnowledge, elements, post-action elements) and `_buildGrounderPrompt` (act, elements, availableApps), and route `_detailPlannerRequest`/`_detailGrounderRequest` payload fields plus the INFO-level act log sites (`formatGrounderRequest` call, `_summarizeGrounderRequest` snippet) through the same redaction; reuse `redactResolvedValue` from `@finalrun/common`; add a rationale comment stating the leak chain, the non-mutation property, why post-serialization redaction is forbidden, and the screenshot residual <!-- R3 --> <!-- rework: whole-text pass corrupts serialized element JSON (numeric secret vs bounds) and misses JSON-escaped secrets in remember; redact fields pre-serialization instead -->
- [x] T002 Wire `bindings: config.runtimeBindings` into the `createAiAgent` call in `createSessionExecutor` (packages/cli/src/sessionRunner.ts) <!-- R3 -->
- [x] T003 Add targeted tests in packages/goal-executor/src/ai/test/AIAgent.test.ts: grounder prompt redacts a typed secret to `${secrets.KEY}` while `index`/`bounds`/`id` stay intact and the `Hierarchy` is not mutated (`flattenedHierarchy[idx]` still returns real text/bounds); planner prompt redacts pre/post-action elements and history/remember; a secret containing JSON-escapable characters (`"`, `\`) is still redacted; no-bindings construction leaves prompts unchanged <!-- R4 --> <!-- rework: add regression tests for the two confirmed defects: numeric secret colliding with bounds, and quote/backslash secret in remember -->

### Phase 3: Integration & Edge Cases

- [x] T004 Run the `packages/common`, `packages/goal-executor`, and `packages/cli` test suites plus workspace typecheck; fix any failures without weakening existing assertions <!-- R4 --> <!-- rework: re-run suites after the redaction fix -->

### Phase 4: Polish

- [x] T005 Rewrite the comment at packages/cli/src/testCompiler.ts:3-11 per R1, describing the post-change state exactly: compile-time scope of the guarantee, the runtime hierarchy/screenshot exposure with the concrete chain, where redaction is wired (report artifacts/spans/errors + the new AIAgent prompt seam) and not wired (screenshots, non-exact renderings), the prompt-logging warning, and the retained pattern-widening warning <!-- R1 --> <!-- rework: comment overstates prompt-text coverage; also fix planner attribution (planner emits contentDesc only, text leg is grounder-only) -->
- [x] T006 Cross-check every factual claim in the rewritten comment(s) and this plan's Design Decisions against the shipped code (file paths, behavior, residuals) so nothing overstates the mitigation; confirm `fab/backlog.md` is untouched and unstaged <!-- R2, R5 --> <!-- rework: re-verify all comment claims against the fixed code -->

## Execution Order

- T001 blocks T002 (constructor param must exist before wiring) and T003 (tests exercise the new helpers)
- T005 and T006 run last — the comment must describe the final shipped state

## Acceptance

### Functional Completeness

- [x] A-001 R1: The rewritten `testCompiler.ts` comment scopes the guarantee to the compiled objective, states the runtime hierarchy + screenshot exposure with the concrete file chain, states where redaction is and is not wired, warns against enabling full prompt logging, and keeps the pattern-widening warning
- [x] A-002 R3: `AIAgent` accepts optional bindings and redacts exact resolved-secret occurrences from grounder and planner prompt text (element fields pre-serialization and each free-text input before assembly; deliberately no pass over the assembled text), replacing them with `${secrets.KEY}` placeholders via the reused `redactResolvedValue`
- [x] A-003 R3: `sessionRunner.createSessionExecutor` passes `config.runtimeBindings` to the `AIAgent`, and constructing `AIAgent` without bindings leaves prompt assembly byte-identical to the pre-change behavior
- [x] A-004 R2: The three-leg leak assessment (hierarchy mitigated, screenshot residual, deeplink inheriting both) is recorded in this plan's Design Decisions and reflected accurately in the shipped comments

### Behavioral Correctness

- [x] A-005 R3: Redaction never mutates the `Hierarchy` object — after building a redacted prompt, `flattenedHierarchy[idx]` still returns the original `text` and `bounds`, so index-based grounding and tap coordinates are unaffected
- [x] A-006 R4: A targeted test proves an element whose `text` was redacted to a placeholder keeps `index`/`bounds`/`id` intact in the emitted prompt — *re-review cycle 1: now holds generally. The whole-text pass is gone; only `_redactPromptElements` (per string field, pre-`JSON.stringify`) and `_redactPromptText` (per free-text input) run. Re-probed against dist with `secrets.PIN='1080'` and `bounds:[0,0,1080,240]`: emitted `ui_elements` parses, `bounds` is `[0,0,1080,240]`, `text` is `${secrets.PIN}`. Covered by the regression test at AIAgent.test.ts "redaction leaves structural JSON intact when a secret equals a coordinate".*

### Scenario Coverage

- [x] A-007 R4: Existing `packages/goal-executor`, `packages/cli`, and `packages/common` suites pass unmodified (typing and grounding flows unbroken)

### Edge Cases & Error Handling

- [x] A-008 R3: A secret value containing JSON-escapable characters (`"`, `\`) is redacted (per-field redaction happens before `JSON.stringify`), and empty-string secrets are skipped without error

### Code Quality

- [x] A-009 Pattern consistency: New code follows the surrounding AIAgent/test patterns (private helpers, bracket-notation private access in tests, node:test + assert/strict)
- [x] A-010 No unnecessary duplication: `redactResolvedValue` is reused, not reimplemented; no new utility duplicates an existing one
- [x] A-011 No restatement comments: every new comment passes the deletion test (states rationale, cross-file coupling, or residual risk the code cannot show)

### Security

- [x] A-012 R2: No new secret-bearing surface is introduced, and every residual exposure (screenshots, non-exact renderings) is documented rather than hidden; the comment does not overstate the shipped mitigation — *re-review cycle 1: gap closed. `remember` entries are redacted per entry BEFORE `JSON.stringify` (AIAgent.ts:462). Re-probed against dist with `secrets.WEIRD='alpha"beta\\gamma'` in `remember`/`history`/`preContext`/`appKnowledge`: all four emit `${secrets.WEIRD}`, neither the raw nor the escaped form appears. Comment claims re-verified against current code.*
- [x] A-013 R5: `fab/backlog.md` was never staged or committed during this change

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- None — this change adds new functionality without making existing code redundant. The pre-existing redaction seams stay load-bearing: `ActionExecutor._redactRuntimeString` still covers spans/errors, and `reportWriter`'s per-field + device-log redaction still covers write paths the prompt seam never touches.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Implement mitigation (a): the intake's gate is satisfiable — the AIAgent prompt-assembly seam has bindings in scope via sessionRunner, redaction is structure-preserving and non-mutating, and both properties are unit-provable alongside green existing suites | User delegated with an explicit criterion ("implement only if you can show grounding still works"); the seam analysis and non-mutation property make the structural half provable, though the model's semantic response to placeholders is inherently empirical | S:85 R:70 A:80 D:70 |
| 2 | Confident | Redact every input individually before assembly/serialization — element and app record fields before `JSON.stringify`, each free-text input (objective, act, history, remember entries, preContext, appKnowledge) on its own — with NO pass over the assembled prompt | Revised in rework cycle 1: the original whole-text pass corrupted serialized structure when a numeric secret equaled a coordinate and missed JSON-escaped secrets in `remember`; per-input redaction has neither failure mode | S:80 R:80 A:85 D:75 |
| 3 | Confident | Replace values with their `${secrets.KEY}` placeholder rather than an opaque mask | The compiled objective's Execution Rules already teach the model to treat that token as the logical secret, so verify-flows read a token with known semantics; an opaque mask would not carry that meaning | S:75 R:75 A:80 D:70 |
| 4 | Certain | Screenshots ship unredacted and are documented as residual exposure in both the plan and the comment | Explicit intake directive: "no mitigation attempted — document as residual exposure" | S:95 R:90 A:95 D:95 |
| 5 | Confident | The debug detail blobs (`_detail*Request`) are routed through the same redaction since AIAgent now holds bindings | Same leak class at the same seam for two lines of change; console output was the one write path not covered by reportWriter's redaction | S:60 R:85 A:80 D:70 |
| 6 | Confident | No prompt-logging opt-in flag is built (intake §3(b)): no full-prompt logging path exists today, so the comment's warning is the deliverable | Verified: detail blobs log prompt length and 3-element excerpts, not the full prompt; `runner.log` writes are redacted by reportWriter | S:70 R:85 A:80 D:75 |

6 assumptions (1 certain, 5 confident, 0 tentative).
