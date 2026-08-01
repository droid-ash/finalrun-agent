# Intake: Fix Secret-Leak Guarantee Comment and Assess the Prompt-Path Secret Leak

**Change**: 260731-gzzl-fix-secret-prompt-leak-comment
**Created**: 2026-07-31

## Origin

One-shot `/fab-new` invocation, originating from an independent adversarial review of PRs #168–#172 (the comment in question was written by the comment-content sweep, PR #171 / change `260731-vxq1-comment-content-sweep`). User's raw input:

> Fix a security comment that is factually wrong, and assess the real leak it conceals. THE COMMENT: packages/cli/src/testCompiler.ts lines 6 to 7 claims that secret VALUES never enter the LLM prompt, the model provider logs, or compiled test artifacts. That is TRUE for the compiled objective and FALSE for the prompt. Verified chain: ActionExecutor.ts line 365 resolves a secrets placeholder and types the real value into a field; on the next action Hierarchy.toPromptElementsForGrounder emits node.text VERBATIM at packages/common/src/models/Hierarchy.ts line 215; AIAgent.ts lines 500 to 502 sends that to the provider unredacted; AIAgent.ts line 417 additionally attaches a post-action screenshot of the same screen. A grep for redact across packages/goal-executor/src/ai returns nothing — redactResolvedValue exists but is wired only into reportWriter.ts and ActionExecutor._redactRuntimeString for spans and errors, never the prompt path. REQUIRED, and the part that must ship: rewrite the comment so it states what is actually guaranteed. Scope the claim to the compiled objective and state plainly that resolved secret values DO reach the model provider via the post-typing accessibility hierarchy and via screenshots. A confident wrong guarantee is worse than no comment because it tells the next maintainer the invariant is already enforced and it is safe to enable full prompt logging. SECOND, assess whether the leak itself can be mitigated, and use real judgement rather than forcing a fix: redacting the field text in the hierarchy may break the grounder ability to locate or verify the element it just typed into, and a screenshot cannot be redacted cheaply, so full remediation may be impossible. If it is, say so explicitly and document the residual exposure accurately instead of pretending. If a safe partial mitigation exists — for example redacting only exact secret-value matches in node text while leaving structure intact, or making prompt logging opt-in with a warning — propose it, weigh it against grounding accuracy, and implement only if you can show grounding still works. Do NOT overstate the guarantee in whatever new comment you write. Context: this came out of an independent adversarial review of PRs #168 to #172. Do NOT commit or git add fab/backlog.md under any circumstance — it is intentionally untracked scratch and the user wants it kept that way; note that the git-pr expected-area guard would otherwise stage untracked files under fab/.

Key decisions from the invocation: the comment rewrite is REQUIRED and must ship; the leak mitigation is judgment-delegated — assess honestly, implement only if a safe partial mitigation demonstrably preserves grounding, and if full remediation is impossible, say so and document the residual exposure accurately.

## Why

**The pain point.** The comment at `packages/cli/src/testCompiler.ts:3-11` (written by PR #171's security-control documentation pass) claims that because `VARIABLE_REFERENCE_PATTERN` never matches `${secrets.*}` tokens, "secret VALUES never enter the LLM prompt, the model provider's logs, or compiled test artifacts." That guarantee is true only for the **compiled objective text**. It is false for the prompt as a whole: once `ActionExecutor._executeType` resolves a `${secrets.*}` placeholder (`resolveRuntimePlaceholders`, `packages/goal-executor/src/ActionExecutor.ts:363-365`) and types the real value into a field, the very next planner/grounder call captures a fresh accessibility hierarchy in which that field's `node.text` **is the secret value**. `Hierarchy.toPromptElementsForGrounder` (`packages/common/src/models/Hierarchy.ts:216`) emits `node.text` verbatim (`toPromptElementsForPlanner` emits only `index`/`contentDesc`/`class`/`bounds` — no `text` field); `AIAgent.ts` serializes those elements into the prompt (`~500-502` grounder, `~410-421` planner) and additionally attaches screenshots (`request.screenshot` / `request.postActionScreenshot`) showing the same screen. Nothing in `packages/goal-executor/src/ai/` redacts anything — `redactResolvedValue` is wired only into `reportWriter.ts` and `ActionExecutor._redactRuntimeString` (spans/errors/report artifacts), never the prompt path. All of this was independently re-verified at intake.

**The consequence of not fixing.** A confident wrong guarantee is worse than no comment: it tells the next maintainer the invariant is already enforced end-to-end, so decisions premised on it (e.g., enabling full prompt logging, treating provider-side logs as secret-free, skipping redaction when adding a new prompt surface) become silent secret-disclosure incidents. The comment is also load-bearing documentation of a "security control" (it was written expressly so a future reader doesn't delete the control), so its accuracy standard is highest.

**Why this approach.** Fix the documentation to state exactly what is guaranteed (compile-time scope) and what is not (runtime prompt path), then assess mitigation with real engineering judgment rather than forcing a fix that breaks grounding. Masking the typed value in the hierarchy may prevent the grounder/planner from locating or verifying the field it just typed into (e.g., verifying "the field now contains the password" or re-focusing the field by its content); a screenshot cannot be cheaply redacted (would require OCR/region detection). So the honest outcome may be: accurate comment + partial mitigation (or none) + accurately documented residual exposure. Pretending full remediation exists would recreate the original defect at a bigger scale.

## What Changes

### 1. Comment rewrite in `packages/cli/src/testCompiler.ts` (REQUIRED — must ship)

Current text (lines 3–11):

```ts
// Secret-leak guard: this pattern deliberately matches ONLY ${variables.*}
// tokens, never ${secrets.*}. Secret placeholders are left as literal tokens in
// the compiled prompt — the Execution Rules appended below instruct the model to
// echo them verbatim — so secret VALUES never enter the LLM prompt, the model
// provider's logs, or compiled test artifacts. Secrets are substituted only
// downstream at the point of use (resolveRuntimePlaceholders in
// packages/common/src/repoPlaceholders.ts, called from ActionExecutor when
// typing or opening a deeplink). Widening this pattern to secrets would leak
// their values into every plan/grounder call.
```

Replace with a comment that:

- **Scopes the guarantee to what this file controls**: `${secrets.*}` tokens are never substituted into the *compiled objective* — so the compiled test text, and every prompt containing only the objective, carries placeholders, not values. Keep the "widening this pattern would leak values into every plan/grounder call" warning — that part is true and load-bearing.
- **States the runtime exposure plainly**: once ActionExecutor resolves a placeholder and types the real value into a field, subsequent planner/grounder calls DO send the secret value to the model provider — via the captured accessibility hierarchy (`node.text` of the typed field, emitted verbatim by `Hierarchy.toPromptElementsForGrounder`/`ForPlanner`) and via screenshots of the same screen. Name the concrete files so the next maintainer can follow the chain (`ActionExecutor._executeType` → `Hierarchy.toPromptElements*` → `AIAgent` request assembly).
- **States the redaction wiring accurately**: `redactResolvedValue` protects report artifacts, spans, and error strings (reportWriter.ts, `ActionExecutor._redactRuntimeString`) — not the prompt path.
- **Warns against the specific premature conclusion**: it is NOT safe to assume prompts are secret-free (e.g., when enabling prompt logging or provider-side log retention).
- **Does not overstate** whatever mitigation (if any) ships in this same change — the comment must describe the post-change state exactly, including residual exposure.

If mitigation from §3 ships, the comment (and any comment added at the mitigation site) must reflect the mitigated + residual state, not an aspirational one.

### 2. Leak assessment (REQUIRED — a written, honest verdict)

Produce an explicit assessment, carried in the plan/PR body and reflected in the rewritten comment(s) and affected memory:

- **Hierarchy leg**: after `_executeType` types a resolved secret, the next capture's `node.text` (and possibly `hintText`/`error` fields) contains the value; both grounder and planner element serializations emit it. Password fields on Android often mask text at the accessibility layer (`•••`), but this is app/platform-dependent and NOT a guarantee — plain-text fields (API keys, OTP codes, tokens typed into non-password inputs) leak verbatim.
- **Screenshot leg**: `request.screenshot` / `request.postActionScreenshot` capture the same screen; masking would require visual detection of the field region — not cheaply or reliably achievable. Treat as residual exposure unless evidence otherwise.
- **Deeplink leg**: `resolveRuntimePlaceholders` is also called for deeplink opens; a secret embedded in a URL may subsequently appear in address bars / on-screen text captured by hierarchy and screenshots. Assess and document; same residual logic.
- **Verdict shape**: full remediation is likely impossible (screenshot leg); say so explicitly if confirmed, and document the residual exposure accurately.

### 3. Partial mitigation (CONDITIONAL — implement only if grounding demonstrably survives)

Candidate mitigations to weigh, in the user's suggested space:

- **(a) Exact-match redaction in the element serialization path**: in `Hierarchy.toPromptElementsForGrounder`/`ForPlanner` (or at the AIAgent assembly seam, which has access to runtime bindings), replace exact occurrences of resolved secret *values* in `text`/`hintText`/`error` fields with the corresponding `${secrets.KEY}` placeholder (reusing `redactResolvedValue` semantics — longest-value-first substitution already exists in `packages/common/src/repoPlaceholders.ts`). Structure (index, bounds, class, id, isEditable, isFocused) stays intact, so element *location* should be unaffected; the risk is *verification* steps ("confirm the field shows X") and the model re-typing from what it reads. The plumbing question is real: `Hierarchy` (packages/common) has no knowledge of runtime bindings today — redaction likely belongs where both the hierarchy and the bindings are in scope (goal-executor's prompt assembly), not inside `Hierarchy` itself.
- **(b) No silent prompt logging**: verify whether any prompt-logging/tracing path exists today; if one exists or is trivially enabled, make it opt-in with an explicit secrets warning. If none exists, the rewritten comment's warning is the deliverable.
- **Gate for implementing (a)**: only if it can be shown that grounding still works — at minimum the existing goal-executor/grounder test suites pass, plus a targeted test showing an element whose `text` was redacted to a placeholder is still locatable by index/bounds/id and that typing-then-verifying flows are not broken. If that cannot be shown within this change's scope, ship the assessment + comment only, and record mitigation as consciously deferred with the reasoning.
- **Screenshots**: no mitigation attempted — document as residual exposure (cannot be redacted cheaply; blurring/omitting the screenshot would blind the planner).

### 4. Constraint: `fab/backlog.md` must never be staged or committed

`fab/backlog.md` is intentionally untracked scratch. The `/git-pr` expected-area guard would otherwise stage untracked files under `fab/` — this change's ship step MUST NOT `git add` it under any circumstance (stage specific paths explicitly rather than `git add fab/`).

## Affected Memory

- `cli/test-compiler`: (new) The compile-time secret-placeholder guarantee in `testCompiler.ts` — its actual scope (compiled objective only), the runtime prompt-path exposure it does NOT cover (post-typing hierarchy `node.text`, screenshots), where redaction IS wired (report artifacts, spans, errors) vs. is not (prompt assembly), and the residual-exposure verdict from this change's assessment.
- `common/hierarchy`: (modify — only if mitigation (a) lands in or around `toPromptElements*`) Note the redaction seam and that emitted `text`/`hintText`/`error` may carry placeholder substitutions; if no code change lands in common, no modification needed.
- `cli/report-writer`: (modify) One-line cross-reference: the secret-redaction contract it documents covers write paths only, not the LLM prompt path — pointer to `cli/test-compiler` for the prompt-path exposure.

## Impact

- `packages/cli/src/testCompiler.ts` — comment rewrite (no behavior change).
- `packages/goal-executor/src/ai/AIAgent.ts`, `packages/goal-executor/src/ActionExecutor.ts` — mitigation seam candidates (conditional); at minimum referenced by the new comment.
- `packages/common/src/models/Hierarchy.ts`, `packages/common/src/repoPlaceholders.ts` — conditional mitigation touch-points (`redactResolvedValue` reuse); at minimum referenced.
- Tests: existing suites in `packages/goal-executor` and `packages/cli` must stay green; conditional mitigation requires a new targeted test proving grounding survives redaction.
- No API, dependency, or CI changes. Git hygiene constraint on `fab/backlog.md` at ship time.

## Open Questions

- None blocking. The one genuine judgment call — whether to implement mitigation (a) — was explicitly delegated by the user with a decision criterion (implement only if grounding demonstrably still works; otherwise document honestly). Apply resolves it against that criterion and records the outcome.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | The comment rewrite ships regardless of the mitigation outcome, scopes the guarantee to the compiled objective, and states plainly that resolved secret values DO reach the provider via post-typing hierarchy text and screenshots | Explicit user requirement ("REQUIRED, and the part that must ship"); exact required content enumerated in the invocation | S:95 R:90 A:95 D:95 |
| 2 | Certain | The leak chain as described is real: `_executeType` resolves placeholders (ActionExecutor.ts:363-365), `toPromptElementsForGrounder` emits `node.text` verbatim (Hierarchy.ts:214-215), AIAgent sends hierarchy + screenshots unredacted, and `grep redact packages/goal-executor/src/ai` returns nothing | Independently re-verified at intake by reading each cited site; user's line numbers matched | S:90 R:90 A:95 D:95 |
| 3 | Confident | Mitigation is decided by apply against the user's stated gate: implement exact-value redaction only if grounding demonstrably survives (tests + targeted proof); otherwise ship assessment + honest documentation of residual exposure, and treat screenshots as unmitigable within this change | User explicitly delegated with criteria ("use real judgement rather than forcing a fix… implement only if you can show grounding still works") | S:85 R:65 A:75 D:70 |
| 4 | Confident | If redaction is implemented, it belongs at a seam with access to runtime bindings (goal-executor prompt assembly), not inside `Hierarchy` (packages/common), which has no bindings today; `redactResolvedValue`'s longest-first substitution is reused rather than reimplemented | Verified `Hierarchy` has no bindings access; reuse mandated by code-quality anti-pattern "duplicating existing utilities" | S:70 R:70 A:80 D:70 |
| 5 | Certain | `fab/backlog.md` is never staged or committed; ship stages explicit paths instead of directory-level `git add fab/` | Explicit user constraint with stated reason (git-pr expected-area guard would stage untracked fab/ files) | S:95 R:75 A:90 D:90 |
| 6 | Confident | Affected memory: new `cli/test-compiler` file (the exposure/guarantee contract), `cli/report-writer` gets a scope cross-reference, `common/hierarchy` modified only if code lands in common | Domain mapping inferred from memory index; hydrate may reasonably fold the new content into an existing cli file instead | S:60 R:80 A:65 D:55 |
| 7 | Certain | change_type is `fix` | Description begins "Fix a security comment…"; keyword inference matches; a factually wrong security comment is a defect | S:90 R:95 A:95 D:90 |

7 assumptions (4 certain, 3 confident, 0 tentative, 0 unresolved).
