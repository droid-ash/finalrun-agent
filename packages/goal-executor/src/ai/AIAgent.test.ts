import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FEATURE_GROUNDER,
  FEATURE_PLANNER,
  FEATURE_SCROLL_INDEX_GROUNDER,
  PLANNER_ACTION_ROTATE,
  PLANNER_ACTION_TAP,
  type FeatureName,
  type FeatureOverrides,
  type ModelDefaults,
} from '@finalrun/common';
import { AIAgent, GrounderResponse, PlannerResponse } from './AIAgent.js';
import { FatalProviderError } from './providerFailure.js';

function makeAgent(overrides?: {
  defaults?: Partial<ModelDefaults>;
  features?: FeatureOverrides;
  apiKeys?: Record<string, string>;
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
  });
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
