import type { TestDefinition, RuntimeBindings } from '@finalrun/common';

// Secret-leak guard — COMPILE-TIME SCOPE ONLY. This pattern deliberately
// matches ${variables.*} tokens and never ${secrets.*}: secret placeholders
// stay literal tokens in the compiled objective (the Execution Rules appended
// below instruct the model to echo them verbatim), so neither the compiled
// test text nor the objective portion of any prompt receives a secret VALUE
// through placeholder substitution. (A ${variables.*} value that happens to
// equal a secret still lands in the compiled text — this pattern cannot tell.)
// Widening this pattern to secrets would bake real values into the compiled
// test artifact and the planner objective — the durable leak: grounder
// prompts carry no objective, and the AIAgent redaction seam below catches
// prompt text only when runtime bindings are wired.
//
// That is the WHOLE guarantee; it does not keep secret values out of LLM
// prompts at runtime. Once ActionExecutor._executeType (or _executeDeeplink)
// resolves a placeholder (resolveRuntimePlaceholders in
// packages/common/src/repoPlaceholders.ts) and the value lands on screen, the
// next captured accessibility hierarchy carries it — grounder prompts emit
// the typed field's text/hintText/error verbatim
// (Hierarchy.toPromptElementsForGrounder); planner prompts carry only
// contentDesc for image/button-class nodes, which can still surface a value
// rendered into accessibility text — and screenshots show the same screen.
// The prompt-assembly seam
// (AIAgent._buildPlannerPrompt/_buildGrounderPrompt in
// packages/goal-executor/src/ai/AIAgent.ts) redacts exact occurrences of
// resolved secret values from prompt TEXT back to their ${secrets.*}
// placeholders, but screenshots reach the model provider UNREDACTED, and any
// rendering of a secret that is not an exact value match (truncated,
// reformatted, partially masked by the app) passes through.
// redactResolvedValue also guards the write paths — report artifacts, spans,
// error strings (reportWriter.ts, ActionExecutor._redactRuntimeString) — but
// report screenshots are raw too. Do NOT enable full prompt logging or treat
// provider-side logs as secret-free on the strength of this guard.
const VARIABLE_REFERENCE_PATTERN = /\$\{variables\.([A-Za-z0-9_-]+)\}/g;

export function compileTestObjective(
  test: TestDefinition,
  bindings: RuntimeBindings,
): string {
  const sections: string[] = [
    `Test Name: ${interpolateVariables(test.name, bindings)}`,
    `Test Path: ${test.relativePath!}`,
  ];

  if (test.description) {
    sections.push(`Description: ${interpolateVariables(test.description, bindings)}`);
  }

  if (test.setup.length > 0) {
    sections.push(
      formatNumberedSection(
        'Setup',
        test.setup.map((item) => interpolateVariables(item, bindings)),
      ),
    );
  }

  sections.push(
    formatNumberedSection(
      'Steps',
      test.steps.map((item) => interpolateVariables(item, bindings)),
    ),
  );

  if (test.expected_state.length > 0) {
    sections.push(
      formatBulletSection(
        'Expected State (verify after all steps are complete)',
        test.expected_state.map((item) => interpolateVariables(item, bindings)),
      ),
    );
  }

  sections.push(
    [
      'Execution Rules:',
      '- Treat any ${secrets.*} placeholder as a logical token. Do not invent or expose the real value.',
      '- If a secret token is needed in a typing or deeplink action, echo the token exactly as written.',
      '- Keep the action descriptions grounded in the current screen and follow the test sections above.',
    ].join('\n'),
  );

  return sections.join('\n\n');
}

function interpolateVariables(
  value: string,
  bindings: RuntimeBindings,
): string {
  return value.replace(VARIABLE_REFERENCE_PATTERN, (_match, key: string) => {
    const variableValue = bindings.variables[key];
    return variableValue === undefined ? `\${variables.${key}}` : String(variableValue);
  });
}

function formatBulletSection(title: string, items: string[]): string {
  return [title + ':', ...items.map((item) => `- ${item}`)].join('\n');
}

function formatNumberedSection(title: string, items: string[]): string {
  return [
    title + ':',
    ...items.map((item, index) => `${index + 1}. ${item}`),
  ].join('\n');
}
