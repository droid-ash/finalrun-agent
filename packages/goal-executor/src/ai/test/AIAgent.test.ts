import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FEATURE_GROUNDER,
  FEATURE_PLANNER,
  FEATURE_SCROLL_INDEX_GROUNDER,
  Hierarchy,
  PLANNER_ACTION_ROTATE,
  PLANNER_ACTION_TAP,
  type FeatureName,
  type FeatureOverrides,
  type ModelDefaults,
  type RuntimeBindings,
} from '@finalrun/common';
import {
  AIAgent,
  GrounderRequest,
  GrounderResponse,
  PlannerRequest,
  PlannerResponse,
} from '../AIAgent.js';
import { FatalProviderError } from '../providerFailure.js';

function makeAgent(overrides?: {
  defaults?: Partial<ModelDefaults>;
  features?: FeatureOverrides;
  apiKeys?: Record<string, string>;
  bindings?: RuntimeBindings;
}): AIAgent {
  const defaults: ModelDefaults = {
    provider: overrides?.defaults?.provider ?? 'google',
    modelName: overrides?.defaults?.modelName ?? 'gemini-test',
    ...(overrides?.defaults?.reasoning !== undefined
      ? { reasoning: overrides.defaults.reasoning }
      : {}),
  };
  return new AIAgent({
    apiKeys: overrides?.apiKeys ?? {
      google: 'test-key',
      openai: 'test-key',
      anthropic: 'test-key',
    },
    defaults,
    ...(overrides?.features !== undefined ? { features: overrides.features } : {}),
    ...(overrides?.bindings !== undefined ? { bindings: overrides.bindings } : {}),
  });
}

function buildGrounderPrompt(
  agent: AIAgent,
  request: GrounderRequest,
): { userParts: unknown[]; text: string } {
  return (
    agent as unknown as {
      _buildGrounderPrompt: (req: GrounderRequest) => {
        userParts: unknown[];
        text: string;
      };
    }
  )._buildGrounderPrompt(request);
}

function buildPlannerPrompt(
  agent: AIAgent,
  request: PlannerRequest,
): { userParts: unknown[]; textPrompt: string } {
  return (
    agent as unknown as {
      _buildPlannerPrompt: (req: PlannerRequest) => {
        userParts: unknown[];
        textPrompt: string;
      };
    }
  )._buildPlannerPrompt(request);
}

function parsePlannerResponse(output: unknown, rawText = ''): PlannerResponse {
  const agent = makeAgent();
  return (
    agent as unknown as {
      _parsePlannerResponse: (output: unknown, rawText: string) => PlannerResponse;
    }
  )._parsePlannerResponse(output, rawText);
}

function parseGrounderResponse(output: unknown, rawText = ''): GrounderResponse {
  const agent = makeAgent();
  return (
    agent as unknown as {
      _parseGrounderResponse: (output: unknown, rawText: string) => GrounderResponse;
    }
  )._parseGrounderResponse(output, rawText);
}

function getProviderOptions(params: {
  provider: string;
  modelName: string;
  feature: FeatureName;
  defaultReasoning?: ModelDefaults['reasoning'];
  features?: FeatureOverrides;
}): Record<string, unknown> | undefined {
  const agent = makeAgent({
    defaults: {
      provider: params.provider,
      modelName: params.modelName,
      ...(params.defaultReasoning !== undefined ? { reasoning: params.defaultReasoning } : {}),
    },
    ...(params.features !== undefined ? { features: params.features } : {}),
  });

  const resolved = (
    agent as unknown as {
      _resolveFeatureConfig: (feature: FeatureName) => {
        provider: string;
        modelName: string;
        reasoning: string;
      };
    }
  )._resolveFeatureConfig(params.feature);

  return (
    agent as unknown as {
      _getProviderOptions: (
        resolved: { provider: string; modelName: string; reasoning: string },
        feature: FeatureName,
      ) => Record<string, unknown> | undefined;
    }
  )._getProviderOptions(resolved, params.feature);
}

test('AIAgent uses medium Google reasoning defaults for planner feature', () => {
  const providerOptions = getProviderOptions({
    provider: 'google',
    modelName: 'gemini-3.1-pro-preview',
    feature: FEATURE_PLANNER,
  });

  assert.deepEqual(providerOptions, {
    google: {
      thinkingConfig: {
        thinkingLevel: 'medium',
        includeThoughts: false,
      },
    },
  });
});

test('AIAgent uses low Google reasoning defaults for grounder feature', () => {
  const providerOptions = getProviderOptions({
    provider: 'google',
    modelName: 'gemini-3.1-pro-preview',
    feature: FEATURE_GROUNDER,
  });

  assert.deepEqual(providerOptions, {
    google: {
      thinkingConfig: {
        thinkingLevel: 'low',
        includeThoughts: false,
      },
    },
  });
});

test('AIAgent applies Google reasoning defaults without model-family gating', () => {
  const providerOptions = getProviderOptions({
    provider: 'google',
    modelName: 'gemini-2.0-flash',
    feature: FEATURE_PLANNER,
  });

  assert.deepEqual(providerOptions, {
    google: {
      thinkingConfig: {
        thinkingLevel: 'medium',
        includeThoughts: false,
      },
    },
  });
});

test('AIAgent uses medium OpenAI reasoning defaults for planner feature', () => {
  const providerOptions = getProviderOptions({
    provider: 'openai',
    modelName: 'gpt-5',
    feature: FEATURE_PLANNER,
  });

  assert.deepEqual(providerOptions, {
    openai: {
      reasoningEffort: 'medium',
    },
  });
});

test('AIAgent uses low OpenAI reasoning defaults for grounder feature', () => {
  const providerOptions = getProviderOptions({
    provider: 'openai',
    modelName: 'gpt-5',
    feature: FEATURE_GROUNDER,
  });

  assert.deepEqual(providerOptions, {
    openai: {
      reasoningEffort: 'low',
    },
  });
});

test('AIAgent applies OpenAI reasoning defaults without model-family gating', () => {
  const providerOptions = getProviderOptions({
    provider: 'openai',
    modelName: 'gpt-5.4-mini',
    feature: FEATURE_PLANNER,
  });

  assert.deepEqual(providerOptions, {
    openai: {
      reasoningEffort: 'medium',
    },
  });
});

test('AIAgent uses medium Anthropic effort defaults for planner feature', () => {
  const providerOptions = getProviderOptions({
    provider: 'anthropic',
    modelName: 'claude-sonnet-4-6',
    feature: FEATURE_PLANNER,
  });

  assert.deepEqual(providerOptions, {
    anthropic: {
      effort: 'medium',
      structuredOutputMode: 'outputFormat',
    },
  });
});

test('AIAgent uses low Anthropic effort defaults for grounder feature', () => {
  const providerOptions = getProviderOptions({
    provider: 'anthropic',
    modelName: 'claude-sonnet-4-6',
    feature: FEATURE_GROUNDER,
  });

  assert.deepEqual(providerOptions, {
    anthropic: {
      effort: 'low',
      structuredOutputMode: 'outputFormat',
    },
  });
});

test('AIAgent applies Anthropic effort defaults without model-family gating', () => {
  const providerOptions = getProviderOptions({
    provider: 'anthropic',
    modelName: 'claude-3-7-sonnet-latest',
    feature: FEATURE_PLANNER,
  });

  assert.deepEqual(providerOptions, {
    anthropic: {
      effort: 'medium',
      structuredOutputMode: 'outputFormat',
    },
  });
});

test('AIAgent respects workspace-wide reasoning default across features', () => {
  const providerOptions = getProviderOptions({
    provider: 'openai',
    modelName: 'gpt-5.4-mini',
    feature: FEATURE_GROUNDER,
    defaultReasoning: 'high',
  });

  assert.deepEqual(providerOptions, {
    openai: {
      reasoningEffort: 'high',
    },
  });
});

test('AIAgent per-feature reasoning override beats workspace default', () => {
  const providerOptions = getProviderOptions({
    provider: 'openai',
    modelName: 'gpt-5.4-mini',
    feature: FEATURE_PLANNER,
    defaultReasoning: 'low',
    features: { planner: { reasoning: 'high' } },
  });

  assert.deepEqual(providerOptions, {
    openai: {
      reasoningEffort: 'high',
    },
  });
});

test('AIAgent per-feature model override re-routes to the named provider', () => {
  const providerOptions = getProviderOptions({
    provider: 'openai',
    modelName: 'gpt-5.4-mini',
    feature: FEATURE_SCROLL_INDEX_GROUNDER,
    features: {
      'scroll-index-grounder': {
        model: 'google/gemini-2.0-flash',
        reasoning: 'medium',
      },
    },
  });

  assert.deepEqual(providerOptions, {
    google: {
      thinkingConfig: {
        thinkingLevel: 'medium',
        includeThoughts: false,
      },
    },
  });
});

test('AIAgent rejects minimal reasoning on non-OpenAI provider', () => {
  assert.throws(
    () =>
      getProviderOptions({
        provider: 'google',
        modelName: 'gemini-3.1-pro-preview',
        feature: FEATURE_GROUNDER,
        defaultReasoning: 'minimal',
      }),
    /Reasoning level "minimal" is only supported for OpenAI/,
  );
});

test('AIAgent accepts minimal reasoning on OpenAI', () => {
  const providerOptions = getProviderOptions({
    provider: 'openai',
    modelName: 'gpt-5.4-mini',
    feature: FEATURE_GROUNDER,
    defaultReasoning: 'minimal',
  });

  assert.deepEqual(providerOptions, {
    openai: {
      reasoningEffort: 'minimal',
    },
  });
});

test('AIAgent normalizes rotate planner actions', () => {
  const response = parsePlannerResponse({
    output: {
      action: { action_type: 'rotate' },
      remember: [],
    },
  });

  assert.equal(response.act, PLANNER_ACTION_ROTATE);
  assert.equal(response.reason, 'Rotate the device orientation.');
});

test('AIAgent normalizes nested planner output from planner prompt schema', () => {
  const response = parsePlannerResponse({
    output: {
      thought: {
        plan: '[-> Type Hindi]',
        think: 'The language picker is focused and ready.',
        act: 'Type "Hindi" into the search field.',
      },
      action: {
        action_type: 'input_text',
        text: 'Hindi',
        clear_text: true,
      },
      remember: ['At step 2, Hindi search has started.'],
    },
  });

  assert.equal(response.act, 'type');
  assert.equal(response.reason, 'Type "Hindi" into the search field.');
  assert.equal(response.text, 'Hindi');
  assert.equal(response.clearText, true);
  assert.deepEqual(response.remember, ['At step 2, Hindi search has started.']);
  assert.equal(response.thought?.plan, '[-> Type Hindi]');
});

test('AIAgent maps terminal status responses to completed and keeps analysis as the message', () => {
  const response = parsePlannerResponse({
    output: {
      thought: {
        plan: '[✓ Verify language added]',
        think: 'Hindi is visible in the added languages list.',
        act: 'This should not override the final analysis.',
      },
      action: {
        action_type: 'status',
        result: 'Success',
        analysis: 'Hindi is visible in the selected languages list.',
      },
      remember: [],
    },
  });

  assert.equal(response.act, 'completed');
  assert.equal(response.reason, 'Hindi is visible in the selected languages list.');
  assert.equal(response.result, 'Success');
  assert.equal(response.analysis, 'Hindi is visible in the selected languages list.');
  assert.deepEqual(response.remember, []);
});

test('AIAgent accepts unwrapped planner output without the output key', () => {
  const response = parsePlannerResponse({
    thought: { plan: '[-> Tap]', think: 'Target visible.', act: 'Tap button' },
    action: { action_type: 'tap' },
    remember: [],
  });

  assert.equal(response.act, 'tap');
  assert.equal(response.reason, 'Tap button');
});

test('AIAgent parses standard grounder output', () => {
  const response = parseGrounderResponse({
    output: { index: 42, reason: 'Exact text match.' },
  });

  assert.deepEqual(response.output, {
    index: 42,
    reason: 'Exact text match.',
  });
});

test('AIAgent parses scroll grounder output with snake_case coordinates', () => {
  const response = parseGrounderResponse({
    output: {
      start_x: 540,
      start_y: 1800,
      end_x: 540,
      end_y: 400,
      durationMs: 600,
      reason: 'Computed swipe up vector.',
    },
  });

  assert.deepEqual(response.output, {
    start_x: 540,
    start_y: 1800,
    end_x: 540,
    end_y: 400,
    durationMs: 600,
    reason: 'Computed swipe up vector.',
  });
});

test('AIAgent parses launch-app grounder output', () => {
  const response = parseGrounderResponse({
    output: {
      packageName: 'com.whatsapp',
      allowAllPermissions: false,
      reason: 'Matched by exact app name.',
    },
  });

  assert.deepEqual(response.output, {
    packageName: 'com.whatsapp',
    allowAllPermissions: false,
    reason: 'Matched by exact app name.',
  });
});

test('AIAgent parses set-location grounder output', () => {
  const response = parseGrounderResponse({
    output: {
      lat: '37.7749',
      long: '-122.4194',
      reason: 'Resolved San Francisco to city center coordinates.',
    },
  });

  assert.deepEqual(response.output, {
    lat: '37.7749',
    long: '-122.4194',
    reason: 'Resolved San Francisco to city center coordinates.',
  });
});

test('AIAgent parses grounder output without the output wrapper', () => {
  const response = parseGrounderResponse({
    index: 7,
    reason: 'Direct match.',
  });

  assert.deepEqual(response.output, {
    index: 7,
    reason: 'Direct match.',
  });
});

test('AIAgent rejects planner responses that are not JSON objects', () => {
  assert.throws(
    () => parsePlannerResponse('not an object', 'not an object'),
    /Planner response is not a JSON object/,
  );
});

test('AIAgent rejects planner responses missing an actionable action_type', () => {
  assert.throws(
    () =>
      parsePlannerResponse(
        { output: { thought: { plan: '[]' }, remember: [] } },
        '',
      ),
    /missing actionable action_type/,
  );
});

test('AIAgent rejects grounder responses that are not JSON objects', () => {
  assert.throws(
    () => parseGrounderResponse(null, ''),
    /Grounder response is not a JSON object/,
  );
});

// ----------------------------------------------------------------------------
// Prompt-path secret redaction
// ----------------------------------------------------------------------------

const SECRET_VALUE = 'hunter2-secret-value';
const SECRET_BINDINGS: RuntimeBindings = {
  secrets: { PASSWORD: SECRET_VALUE },
  variables: {},
};

function hierarchyWithTypedSecret(text: string): Hierarchy {
  return Hierarchy.fromFlatJson([
    {
      text,
      id: 'password_field',
      class: 'android.widget.EditText',
      bounds: [10, 20, 300, 80],
      isEditable: true,
      isFocused: true,
    },
    {
      text: 'Login',
      id: 'login_button',
      class: 'android.widget.Button',
      bounds: [10, 100, 300, 160],
    },
  ]);
}

test('AIAgent redacts a typed secret from the grounder prompt but keeps the element locatable', () => {
  const hierarchy = hierarchyWithTypedSecret(SECRET_VALUE);
  const agent = makeAgent({ bindings: SECRET_BINDINGS });

  const { text } = buildGrounderPrompt(agent, {
    feature: FEATURE_GROUNDER,
    act: `Verify the password field contains "${SECRET_VALUE}"`,
    hierarchy,
    platform: 'android',
  });

  assert.ok(text.includes('${secrets.PASSWORD}'), 'placeholder present');
  assert.ok(!text.includes(SECRET_VALUE), 'raw secret absent (elements and act line)');
  // Locating structure is untouched: index, id, class, bounds all survive.
  assert.ok(text.includes('"index":0'));
  assert.ok(text.includes('"id":"password_field"'));
  assert.ok(text.includes('"bounds":[10,20,300,80]'));
  assert.ok(text.includes('"isEditable":true'));
});

test('AIAgent prompt redaction never mutates the Hierarchy itself', () => {
  const hierarchy = hierarchyWithTypedSecret(SECRET_VALUE);
  const agent = makeAgent({ bindings: SECRET_BINDINGS });

  buildGrounderPrompt(agent, {
    feature: FEATURE_GROUNDER,
    act: 'Tap the login button',
    hierarchy,
    platform: 'android',
  });

  // Index-based grounding resolves against the ORIGINAL nodes: the tap/type
  // coordinates come from flattenedHierarchy[idx].bounds, not from the prompt.
  assert.equal(hierarchy.flattenedHierarchy[0]!.text, SECRET_VALUE);
  assert.deepEqual(hierarchy.flattenedHierarchy[0]!.bounds, [10, 20, 300, 80]);
});

test('AIAgent redacts secrets from planner hierarchy, history, and remember', () => {
  // Planner elements require accessibility text on a button/image node.
  const plannerHierarchy = Hierarchy.fromFlatJson([
    {
      content_desc: SECRET_VALUE,
      class: 'android.widget.Button',
      bounds: [0, 0, 100, 50],
    },
  ]);
  const agent = makeAgent({ bindings: SECRET_BINDINGS });

  const { textPrompt } = buildPlannerPrompt(agent, {
    testObjective: 'Type ${secrets.PASSWORD} into the password field',
    platform: 'android',
    hierarchy: plannerHierarchy,
    postActionHierarchy: plannerHierarchy,
    history: `1. [type] Typed "${SECRET_VALUE}" into the field → SUCCESS\n`,
    remember: [`The field now shows ${SECRET_VALUE}`],
  });

  assert.ok(textPrompt.includes('${secrets.PASSWORD}'));
  assert.ok(!textPrompt.includes(SECRET_VALUE));
  assert.ok(textPrompt.includes('Post-action ui_elements:'));
});

test('AIAgent redacts secrets containing JSON-escapable characters', () => {
  // Redaction runs before JSON.stringify; matching afterwards would miss this
  // value because `"` and `\` are escaped in the serialized element text.
  const weirdSecret = 'alpha"beta\\gamma';
  const hierarchy = hierarchyWithTypedSecret(weirdSecret);
  const agent = makeAgent({
    bindings: { secrets: { WEIRD: weirdSecret }, variables: {} },
  });

  const { text } = buildGrounderPrompt(agent, {
    feature: FEATURE_GROUNDER,
    act: 'Verify the field',
    hierarchy,
    platform: 'android',
  });

  assert.ok(text.includes('${secrets.WEIRD}'));
  assert.ok(!text.includes('alpha'));
  assert.ok(!text.includes('gamma'));
});

test('AIAgent redaction leaves structural JSON intact when a secret equals a coordinate', () => {
  // Regression: a whole-text pass over the assembled prompt used to rewrite
  // the 1080 inside bounds to ${secrets.PIN}, corrupting the ui_elements JSON.
  const hierarchy = Hierarchy.fromFlatJson([
    {
      text: '1080',
      id: 'pin_field',
      class: 'android.widget.EditText',
      bounds: [0, 0, 1080, 240],
      isEditable: true,
    },
  ]);
  const agent = makeAgent({
    bindings: { secrets: { PIN: '1080' }, variables: {} },
  });

  const { text } = buildGrounderPrompt(agent, {
    feature: FEATURE_GROUNDER,
    act: 'Verify the PIN field',
    hierarchy,
    platform: 'android',
  });

  const serialized = text.match(/ui_elements:\n(.*)\n/)?.[1];
  assert.ok(serialized, 'ui_elements JSON present');
  const elements = JSON.parse(serialized) as Array<Record<string, unknown>>;
  assert.deepEqual(elements[0]!['bounds'], [0, 0, 1080, 240]);
  assert.equal(elements[0]!['text'], '${secrets.PIN}');
});

test('AIAgent redacts an escapable secret echoed into remember', () => {
  // Regression: remember was JSON.stringify-ed before redaction, so `"`/`\`
  // in the secret were escaped and no longer exact-matched the value.
  const weirdSecret = 'alpha"beta\\gamma';
  const agent = makeAgent({
    bindings: { secrets: { WEIRD: weirdSecret }, variables: {} },
  });

  const { textPrompt } = buildPlannerPrompt(agent, {
    testObjective: 'Log in',
    platform: 'android',
    remember: [`the field shows ${weirdSecret}`],
  });

  assert.ok(textPrompt.includes('${secrets.WEIRD}'));
  assert.ok(!textPrompt.includes('alpha'));
  assert.ok(!textPrompt.includes('gamma'));
});

test('AIAgent without bindings assembles prompts unredacted', () => {
  const hierarchy = hierarchyWithTypedSecret(SECRET_VALUE);
  const agent = makeAgent();

  const { text } = buildGrounderPrompt(agent, {
    feature: FEATURE_GROUNDER,
    act: 'Verify the field',
    hierarchy,
    platform: 'android',
  });

  assert.ok(text.includes(SECRET_VALUE));
  assert.ok(!text.includes('${secrets.PASSWORD}'));
});

test('AIAgent keeps a literal placeholder token in the objective intact when a secret value equals its key name', () => {
  // Regression: the unanchored value match used to find PASSWORD inside the
  // literal ${secrets.PASSWORD} token that testObjective deliberately carries
  // and nest it into ${secrets.${secrets.PASSWORD}} — a token the model was
  // never taught.
  const agent = makeAgent({
    bindings: { secrets: { PASSWORD: 'PASSWORD' }, variables: {} },
  });

  const { textPrompt } = buildPlannerPrompt(agent, {
    testObjective: 'Type ${secrets.PASSWORD} into the field, then type PASSWORD again',
    platform: 'android',
  });

  assert.ok(!textPrompt.includes('${secrets.${secrets.PASSWORD}}'));
  assert.ok(
    textPrompt.includes(
      'Type ${secrets.PASSWORD} into the field, then type ${secrets.PASSWORD} again',
    ),
  );
});

test('AIAgent with a single-character secret value assembles the planner prompt byte-identically', () => {
  // Regression: a 1-char value used to rewrite every occurrence of that
  // character, mangling the whole prompt — including the word "secrets"
  // inside other placeholder tokens.
  const request: PlannerRequest = {
    testObjective: 'Press the submit button and assemble the secrets list',
    platform: 'android',
    history: '1. [tap] Tapped submit → SUCCESS\n',
  };
  const redactingAgent = makeAgent({
    bindings: { secrets: { TOKEN: 's' }, variables: {} },
  });
  const plainAgent = makeAgent();

  assert.equal(
    buildPlannerPrompt(redactingAgent, request).textPrompt,
    buildPlannerPrompt(plainAgent, request).textPrompt,
  );
});

// ----------------------------------------------------------------------------
// Retry behavior for plan() and ground()
// ----------------------------------------------------------------------------

type MockLLMResult = { output: unknown; text: string };

function installMockCallLLM(
  agent: AIAgent,
  results: Array<MockLLMResult | Error>,
): { callCount: () => number } {
  let idx = 0;
  (
    agent as unknown as {
      _callLLM: (
        systemPrompt: string,
        userParts: unknown[],
        feature: FeatureName,
      ) => Promise<MockLLMResult>;
    }
  )._callLLM = async () => {
    const next = results[idx++];
    if (next instanceof Error) {
      throw next;
    }
    if (!next) {
      throw new Error(`No more mock results (called ${idx} times)`);
    }
    return next;
  };
  return { callCount: () => idx };
}

const validPlannerOutput = {
  output: {
    thought: { plan: '[-> Tap]', think: 'Target visible.', act: 'Tap button' },
    action: { action_type: 'tap' },
    remember: [],
  },
};

const emptyPlannerOutput = { output: {} };

test('AIAgent.plan retries on parse failure then succeeds', async () => {
  const agent = makeAgent();
  const mock = installMockCallLLM(agent, [
    { output: emptyPlannerOutput, text: '' },
    { output: validPlannerOutput, text: '' },
  ]);

  const response = await agent.plan({
    testObjective: 'test',
    platform: 'android',
  });

  assert.equal(response.act, PLANNER_ACTION_TAP);
  assert.equal(mock.callCount(), 2);
});

test('AIAgent.plan retries on transient LLM error then succeeds', async () => {
  const agent = makeAgent();
  const mock = installMockCallLLM(agent, [
    new Error('ECONNRESET'),
    { output: validPlannerOutput, text: '' },
  ]);

  const response = await agent.plan({
    testObjective: 'test',
    platform: 'android',
  });

  assert.equal(response.act, PLANNER_ACTION_TAP);
  assert.equal(mock.callCount(), 2);
});

test('AIAgent.plan does NOT retry on FatalProviderError', async () => {
  const agent = makeAgent();
  const mock = installMockCallLLM(agent, [
    new FatalProviderError({
      provider: 'google',
      modelName: 'gemini-test',
      statusCode: 401,
      detail: 'Unauthorized',
    }),
    { output: validPlannerOutput, text: '' },
  ]);

  await assert.rejects(
    () => agent.plan({ testObjective: 'test', platform: 'android' }),
    (error: unknown) => FatalProviderError.isInstance(error),
  );
  assert.equal(mock.callCount(), 1);
});

test('AIAgent.plan surfaces the last parse error after exhausting retries', async () => {
  const agent = makeAgent();
  const mock = installMockCallLLM(agent, [
    { output: emptyPlannerOutput, text: '' },
    { output: emptyPlannerOutput, text: '' },
  ]);

  await assert.rejects(
    () => agent.plan({ testObjective: 'test', platform: 'android' }),
    /missing actionable action_type/,
  );
  assert.equal(mock.callCount(), 2);
});

test('AIAgent.ground retries on parse failure then succeeds', async () => {
  const agent = makeAgent();
  const mock = installMockCallLLM(agent, [
    { output: null, text: '' },
    { output: { index: 5, reason: 'match' }, text: '' },
  ]);

  const response = await agent.ground({
    feature: FEATURE_GROUNDER,
    act: 'Tap button',
  });

  assert.equal(response.output['index'], 5);
  assert.equal(mock.callCount(), 2);
});

test('AIAgent.ground does NOT retry on FatalProviderError', async () => {
  const agent = makeAgent();
  const mock = installMockCallLLM(agent, [
    new FatalProviderError({
      provider: 'google',
      modelName: 'gemini-test',
      statusCode: 400,
      detail: 'Bad request',
    }),
    { output: { index: 5 }, text: '' },
  ]);

  await assert.rejects(
    () => agent.ground({ feature: FEATURE_GROUNDER, act: 'Tap button' }),
    (error: unknown) => FatalProviderError.isInstance(error),
  );
  assert.equal(mock.callCount(), 1);
});
