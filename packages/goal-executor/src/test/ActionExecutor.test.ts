import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DeviceActionRequest,
  DeviceNodeResponse,
  TapAction,
  EnterTextAction,
  DeeplinkAction,
  LaunchAppAction,
  RotateAction,
  GetAppListAction,
  FEATURE_GROUNDER,
  FEATURE_VISUAL_GROUNDER,
  FEATURE_INPUT_FOCUS_GROUNDER,
  FEATURE_LAUNCH_APP_GROUNDER,
  PLANNER_ACTION_TAP,
  PLANNER_ACTION_TYPE,
  PLANNER_ACTION_ROTATE,
  PLANNER_ACTION_DEEPLINK,
  PLANNER_ACTION_LAUNCH_APP,
  PLANNER_ACTION_WAIT,
} from '@finalrun/common';
import type { DeviceAgent } from '@finalrun/common';
import type { AIAgent, GrounderResponse } from '../ai/AIAgent.js';
import { FatalProviderError } from '../ai/providerFailure.js';
import { ActionExecutor } from '../ActionExecutor.js';

function createAgent(
  executedActions: unknown[],
  options?: {
    availableApps?: Array<{ packageName: string; name: string }>;
  },
): DeviceAgent {
  return {
    async setUp() {
      return new DeviceNodeResponse({ success: true });
    },
    async executeAction(request: DeviceActionRequest) {
      if (request.action instanceof GetAppListAction) {
        return new DeviceNodeResponse({
          success: true,
          data: {
            apps: options?.availableApps ?? [],
          },
        });
      }

      executedActions.push(request.action);
      return new DeviceNodeResponse({ success: true });
    },
    isConnected() {
      return true;
    },
    getDeviceInfo() {
      return {
        id: 'emulator-5554',
        deviceUUID: 'device-1',
        isAndroid: true,
        sdkVersion: 34,
        getPlatform() {
          return 'android';
        },
      };
    },
    async closeConnection() {
      return undefined;
    },
    killDriver() {
      return undefined;
    },
    setApiKey() {
      return undefined;
    },
    getId() {
      return 'device-1';
    },
    listenForDeviceDisconnection() {
      return undefined;
    },
    clearListener() {
      return undefined;
    },
    uninstallDriver() {
      return undefined;
    },
  } as unknown as DeviceAgent;
}

function createAiAgent(
  groundImpl: (request: {
    feature: string;
    act: string;
    tracePhase?: string;
    traceStep?: number;
    availableApps?: Array<{ packageName: string; name: string }>;
  }) => Promise<GrounderResponse>,
): AIAgent {
  return {
    async ground(request: {
      feature: string;
      act: string;
      tracePhase?: string;
      traceStep?: number;
      availableApps?: Array<{ packageName: string; name: string }>;
    }) {
      return groundImpl(request);
    },
  } as unknown as AIAgent;
}

function assertTraceNames(
  trace: { spans: Array<{ name: string; status: string }> } | undefined,
  expectedNames: string[],
): void {
  assert.deepEqual(
    trace?.spans.map((span) => span.name),
    expectedNames,
  );
}

test('ActionExecutor repeats tap actions using the planner repeat fields', async () => {
  const executedActions: unknown[] = [];
  const agent = createAgent(executedActions);
  const aiAgent = createAiAgent(async (request) => {
    assert.equal(request.feature, FEATURE_GROUNDER);
    return {
      output: { x: 100, y: 200 },
      raw: '{}',
      trace: {
        totalMs: 18,
        promptBuildMs: 3,
        llmMs: 11,
        parseMs: 4,
      },
    };
  });

  const executor = new ActionExecutor({
    agent,
    aiAgent,
    platform: 'android',
  });

  const result = await executor.executeAction({
    action: PLANNER_ACTION_TAP,
    reason: 'Tap the Add language button.',
    repeat: 3,
    delayBetweenTapMs: 0,
    screenWidth: 1080,
    screenHeight: 2400,
  });

  assert.equal(result.success, true);
  assert.equal(executedActions.length, 3);
  assert.ok(executedActions.every((action) => action instanceof TapAction));
  assertTraceNames(result.trace, ['action.ground', 'action.device']);
  assert.equal(result.trace?.spans[0]?.status, 'success');
});

test('ActionExecutor uses structured input text fields instead of extracting from reason', async () => {
  const executedActions: unknown[] = [];
  const agent = createAgent(executedActions);
  const aiAgent = createAiAgent(async (request) => {
    assert.equal(request.feature, FEATURE_INPUT_FOCUS_GROUNDER);
    return {
      output: { index: null },
      raw: '{}',
      trace: {
        totalMs: 15,
        promptBuildMs: 2,
        llmMs: 9,
        parseMs: 4,
      },
    };
  });

  const executor = new ActionExecutor({
    agent,
    aiAgent,
    platform: 'android',
  });

  const result = await executor.executeAction({
    action: PLANNER_ACTION_TYPE,
    reason: 'Type into the language search field.',
    text: 'Hindi',
    clearText: false,
    screenWidth: 1080,
    screenHeight: 2400,
  });

  assert.equal(result.success, true);
  assert.equal(executedActions.length, 1);
  assert.ok(executedActions[0] instanceof EnterTextAction);
  assert.equal((executedActions[0] as EnterTextAction).value, 'Hindi');
  assert.equal((executedActions[0] as EnterTextAction).shouldEraseText, false);
  assertTraceNames(result.trace, ['action.prep', 'action.ground', 'action.device']);
});

test('ActionExecutor uses structured deeplink URLs from the planner action payload', async () => {
  const executedActions: unknown[] = [];
  const agent = createAgent(executedActions);
  const aiAgent = createAiAgent(async () => {
    throw new Error('Grounder should not be called for deeplink actions');
  });

  const executor = new ActionExecutor({
    agent,
    aiAgent,
    platform: 'android',
  });

  const result = await executor.executeAction({
    action: PLANNER_ACTION_DEEPLINK,
    reason: 'Open the settings page.',
    url: 'wikipedia://settings/languages',
    screenWidth: 1080,
    screenHeight: 2400,
  });

  assert.equal(result.success, true);
  assert.equal(executedActions.length, 1);
  assert.ok(executedActions[0] instanceof DeeplinkAction);
  assert.equal(
    (executedActions[0] as DeeplinkAction).deeplink,
    'wikipedia://settings/languages',
  );
  assertTraceNames(result.trace, ['action.prep', 'action.device']);
});

test('ActionExecutor traces launchApp with prep, ground, and device spans', async () => {
  const executedActions: unknown[] = [];
  const agent = createAgent(executedActions, {
    availableApps: [
      { packageName: 'org.wikimedia.wikipedia', name: 'Wikipedia' },
      { packageName: 'com.apple.settings', name: 'Settings' },
    ],
  });
  const aiAgent = createAiAgent(async (request) => {
    assert.equal(request.feature, FEATURE_LAUNCH_APP_GROUNDER);
    assert.equal(request.availableApps?.length, 2);
    return {
      output: { packageName: 'org.wikimedia.wikipedia' },
      raw: '{}',
      trace: {
        totalMs: 21,
        promptBuildMs: 4,
        llmMs: 12,
        parseMs: 5,
      },
    };
  });

  const executor = new ActionExecutor({
    agent,
    aiAgent,
    platform: 'android',
  });

  const result = await executor.executeAction({
    action: PLANNER_ACTION_LAUNCH_APP,
    reason: 'Launch Wikipedia.',
    screenWidth: 1080,
    screenHeight: 2400,
  });

  assert.equal(result.success, true);
  assert.equal(executedActions.length, 1);
  assert.ok(executedActions[0] instanceof LaunchAppAction);
  assert.equal(
    (executedActions[0] as LaunchAppAction).appUpload.packageName,
    'org.wikimedia.wikipedia',
  );
  assertTraceNames(result.trace, ['action.prep', 'action.ground', 'action.device']);
});

test('ActionExecutor does not default primary app relaunches to reinstall', async () => {
  const executedActions: unknown[] = [];
  const agent = createAgent(executedActions, {
    availableApps: [
      { packageName: 'org.wikimedia.wikipedia', name: 'Wikipedia' },
    ],
  });
  const aiAgent = createAiAgent(async () => ({
    output: { packageName: 'org.wikimedia.wikipedia' },
    raw: '{}',
  }));

  const executor = new ActionExecutor({
    agent,
    aiAgent,
    platform: 'android',
    appIdentifier: 'org.wikimedia.wikipedia',
  });

  const result = await executor.executeAction({
    action: PLANNER_ACTION_LAUNCH_APP,
    reason: 'Reopen Wikipedia.',
    screenWidth: 1080,
    screenHeight: 2400,
  });

  assert.equal(result.success, true);
  assert.equal(executedActions.length, 1);
  assert.equal(
    (executedActions[0] as LaunchAppAction).shouldUninstallBeforeLaunch,
    false,
  );
});

test('ActionExecutor ignores malformed grounder boolean flags and preserves defaults', async () => {
  const executedActions: unknown[] = [];
  const agent = createAgent(executedActions, {
    availableApps: [
      { packageName: 'org.wikimedia.wikipedia', name: 'Wikipedia' },
    ],
  });
  const aiAgent = createAiAgent(async () => ({
    output: {
      packageName: 'org.wikimedia.wikipedia',
      allowAllPermissions: 'false',
      shouldUninstallBeforeLaunch: 'false',
      clearState: 'true',
      stopAppBeforeLaunch: 1,
    },
    raw: '{}',
  }));

  const executor = new ActionExecutor({
    agent,
    aiAgent,
    platform: 'android',
    appIdentifier: 'org.wikimedia.wikipedia',
  });

  const result = await executor.executeAction({
    action: PLANNER_ACTION_LAUNCH_APP,
    reason: 'Reopen Wikipedia.',
    screenWidth: 1080,
    screenHeight: 2400,
  });

  assert.equal(result.success, true);
  assert.equal(executedActions.length, 1);
  const action = executedActions[0] as LaunchAppAction;
  assert.equal(action.allowAllPermissions, true);
  assert.equal(action.shouldUninstallBeforeLaunch, false);
  assert.equal(action.clearState, false);
  assert.equal(action.stopAppBeforeLaunch, false);
});

test('ActionExecutor honors explicit grounder boolean flags for app launches', async () => {
  const executedActions: unknown[] = [];
  const agent = createAgent(executedActions, {
    availableApps: [
      { packageName: 'org.wikimedia.wikipedia', name: 'Wikipedia' },
    ],
  });
  const aiAgent = createAiAgent(async () => ({
    output: {
      packageName: 'org.wikimedia.wikipedia',
      allowAllPermissions: false,
      shouldUninstallBeforeLaunch: true,
      clearState: true,
      stopAppBeforeLaunch: true,
    },
    raw: '{}',
  }));

  const executor = new ActionExecutor({
    agent,
    aiAgent,
    platform: 'android',
    appIdentifier: 'org.wikimedia.wikipedia',
  });

  const result = await executor.executeAction({
    action: PLANNER_ACTION_LAUNCH_APP,
    reason: 'Reinstall and relaunch Wikipedia.',
    screenWidth: 1080,
    screenHeight: 2400,
  });

  assert.equal(result.success, true);
  assert.equal(executedActions.length, 1);
  const action = executedActions[0] as LaunchAppAction;
  assert.equal(action.allowAllPermissions, false);
  assert.equal(action.shouldUninstallBeforeLaunch, true);
  assert.equal(action.clearState, true);
  assert.equal(action.stopAppBeforeLaunch, true);
});

test('ActionExecutor traces wait actions without calling the device', async () => {
  const executedActions: unknown[] = [];
  const agent = createAgent(executedActions);
  const aiAgent = createAiAgent(async () => {
    throw new Error('Grounder should not be called for wait actions');
  });

  const executor = new ActionExecutor({
    agent,
    aiAgent,
    platform: 'android',
  });

  const result = await executor.executeAction({
    action: PLANNER_ACTION_WAIT,
    reason: 'Wait for the animation to finish.',
    durationSeconds: 0,
    screenWidth: 1080,
    screenHeight: 2400,
  });

  assert.equal(result.success, true);
  assert.equal(executedActions.length, 0);
  assertTraceNames(result.trace, ['action.wait']);
});

test('ActionExecutor executes rotate without calling the grounder', async () => {
  const executedActions: unknown[] = [];
  const agent = createAgent(executedActions);
  const aiAgent = createAiAgent(async () => {
    throw new Error('Grounder should not be called for rotate actions');
  });

  const executor = new ActionExecutor({
    agent,
    aiAgent,
    platform: 'android',
  });

  const result = await executor.executeAction({
    action: PLANNER_ACTION_ROTATE,
    reason: 'Rotate the device.',
    screenWidth: 1080,
    screenHeight: 2400,
  });

  assert.equal(result.success, true);
  assert.equal(executedActions.length, 1);
  assert.ok(executedActions[0] instanceof RotateAction);
  assertTraceNames(result.trace, ['action.device']);
});

test('ActionExecutor records visual fallback explicitly in the trace', async () => {
  const executedActions: unknown[] = [];
  const agent = createAgent(executedActions);
  let groundCalls = 0;
  const aiAgent = createAiAgent(async (request) => {
    groundCalls += 1;
    if (request.tracePhase === 'action.visual_fallback') {
      assert.equal(request.feature, FEATURE_VISUAL_GROUNDER);
      return {
        output: { x: 42, y: 84, reason: 'Found visually' },
        raw: '{}',
        trace: {
          totalMs: 19,
          promptBuildMs: 3,
          llmMs: 12,
          parseMs: 4,
        },
      };
    }

    assert.equal(request.feature, FEATURE_GROUNDER);
    return {
      output: { needsVisualGrounding: true },
      raw: '{}',
      trace: {
        totalMs: 13,
        promptBuildMs: 2,
        llmMs: 8,
        parseMs: 3,
      },
    };
  });

  const executor = new ActionExecutor({
    agent,
    aiAgent,
    platform: 'android',
  });

  const result = await executor.executeAction({
    action: PLANNER_ACTION_TAP,
    reason: 'Tap the element that is only visible in the screenshot.',
    screenshot: 'base64-image',
    screenWidth: 1080,
    screenHeight: 2400,
  });

  assert.equal(result.success, true);
  assert.equal(groundCalls, 2);
  assert.equal(executedActions.length, 1);
  assert.ok(executedActions[0] instanceof TapAction);
  assertTraceNames(
    result.trace,
    ['action.ground', 'action.visual_fallback', 'action.device'],
  );
});

test('ActionExecutor preserves a ground failure when no visual fallback is available', async () => {
  const executedActions: unknown[] = [];
  const agent = createAgent(executedActions);
  const aiAgent = createAiAgent(async () => ({
    output: { isError: true, reason: 'Target element not found' },
    raw: '{}',
    trace: {
      totalMs: 12,
      promptBuildMs: 2,
      llmMs: 7,
      parseMs: 3,
    },
  }));

  const executor = new ActionExecutor({
    agent,
    aiAgent,
    platform: 'android',
  });

  const result = await executor.executeAction({
    action: PLANNER_ACTION_TAP,
    reason: 'Tap the missing button.',
    screenWidth: 1080,
    screenHeight: 2400,
  });

  assert.equal(result.success, false);
  assert.equal(result.error, 'Target element not found');
  assert.equal(executedActions.length, 0);
  assertTraceNames(result.trace, ['action.ground']);
  assert.equal(result.trace?.spans[0]?.status, 'failure');
});

test('ActionExecutor surfaces terminal provider failures from grounder calls', async () => {
  const executedActions: unknown[] = [];
  const agent = createAgent(executedActions);
  const aiAgent = createAiAgent(async () => {
    throw new FatalProviderError({
      provider: 'openai',
      modelName: 'gpt-5.4-mini',
      statusCode: 401,
      detail: 'Unauthorized',
    });
  });

  const executor = new ActionExecutor({
    agent,
    aiAgent,
    platform: 'android',
  });

  const result = await executor.executeAction({
    action: PLANNER_ACTION_TAP,
    reason: 'Tap the account button.',
    screenWidth: 1080,
    screenHeight: 2400,
  });

  assert.equal(result.success, false);
  assert.equal(
    result.error,
    'AI provider error (openai/gpt-5.4-mini, HTTP 401): Unauthorized',
  );
  assert.deepEqual(result.terminalFailure, {
    kind: 'provider',
    provider: 'openai',
    modelName: 'gpt-5.4-mini',
    statusCode: 401,
    message: 'AI provider error (openai/gpt-5.4-mini, HTTP 401): Unauthorized',
  });
  assert.equal(executedActions.length, 0);
  assertTraceNames(result.trace, ['action.ground']);
  assert.equal(result.trace?.spans[0]?.status, 'failure');
});

test('ActionExecutor resolves secret placeholders for text input only at the device boundary', async () => {
  const executedActions: unknown[] = [];
  const agent = createAgent(executedActions);
  const aiAgent = createAiAgent(async () => ({
    output: { index: null },
    raw: '{}',
    trace: {
      totalMs: 14,
      promptBuildMs: 2,
      llmMs: 8,
      parseMs: 4,
    },
  }));

  const executor = new ActionExecutor({
    agent,
    aiAgent,
    platform: 'android',
    runtimeBindings: {
      secrets: {
        email: 'person@example.com',
      },
      variables: {},
    },
  });

  const result = await executor.executeAction({
    action: PLANNER_ACTION_TYPE,
    reason: 'Type the login email.',
    text: '${secrets.email}',
    screenWidth: 1080,
    screenHeight: 2400,
  });

  assert.equal(result.success, true);
  assert.equal(executedActions.length, 1);
  assert.equal((executedActions[0] as EnterTextAction).value, 'person@example.com');
  assert.equal(JSON.stringify(result).includes('person@example.com'), false);
  assert.equal(result.trace?.spans[0]?.detail?.includes('textLength='), true);
});

test('ActionExecutor keeps secret placeholders tokenized in deeplink traces while executing the resolved URL', async () => {
  const executedActions: unknown[] = [];
  const agent = createAgent(executedActions);
  const aiAgent = createAiAgent(async () => {
    throw new Error('Grounder should not be called for deeplink actions');
  });

  const executor = new ActionExecutor({
    agent,
    aiAgent,
    platform: 'android',
    runtimeBindings: {
      secrets: {
        email: 'person@example.com',
      },
      variables: {},
    },
  });

  const result = await executor.executeAction({
    action: PLANNER_ACTION_DEEPLINK,
    reason: 'Open the account recovery screen.',
    url: 'wikipedia://login?email=${secrets.email}',
    screenWidth: 1080,
    screenHeight: 2400,
  });

  assert.equal(result.success, true);
  assert.equal(executedActions.length, 1);
  assert.equal(
    (executedActions[0] as DeeplinkAction).deeplink,
    'wikipedia://login?email=person@example.com',
  );
  assert.equal(
    result.trace?.spans[0]?.detail,
    'url=wikipedia://login?email=${secrets.email}',
  );
});

test('ActionExecutor surfaces terminal provider failures from visual grounding fallback', async () => {
  const executedActions: unknown[] = [];
  const agent = createAgent(executedActions);
  const aiAgent = createAiAgent(async (request) => {
    if (request.tracePhase === 'action.visual_fallback') {
      throw new FatalProviderError({
        provider: 'google',
        modelName: 'gemini-2.0-flash',
        statusCode: 400,
        detail: 'Bad Request',
      });
    }

    return {
      output: { needsVisualGrounding: true },
      raw: '{}',
      trace: {
        totalMs: 13,
        promptBuildMs: 2,
        llmMs: 8,
        parseMs: 3,
      },
    };
  });

  const executor = new ActionExecutor({
    agent,
    aiAgent,
    platform: 'android',
  });

  const result = await executor.executeAction({
    action: PLANNER_ACTION_TAP,
    reason: 'Tap the element that needs screenshot-only grounding.',
    screenshot: 'base64-image',
    screenWidth: 1080,
    screenHeight: 2400,
  });

  assert.equal(result.success, false);
  assert.equal(
    result.error,
    'AI provider error (google/gemini-2.0-flash, HTTP 400): Bad Request',
  );
  assert.equal(result.terminalFailure?.statusCode, 400);
  assert.equal(executedActions.length, 0);
  assertTraceNames(result.trace, ['action.ground', 'action.visual_fallback']);
  assert.equal(result.trace?.spans[1]?.status, 'failure');
});

test('ActionExecutor substitutes the fallback error for blank driver failure messages', async () => {
  // Callers throw result.error directly (see _runSingleDeviceAction), so an
  // empty or whitespace-only driver message must be normalized to the
  // 'Action failed' fallback instead of surfacing as a blank error.
  for (const message of ['', '   ']) {
    const agent = createAgent([]);
    agent.executeAction = async () => new DeviceNodeResponse({ success: false, message });

    const executor = new ActionExecutor({
      agent,
      aiAgent: createAiAgent(async () => {
        throw new Error('Grounder should not be called for rotate actions');
      }),
      platform: 'android',
    });

    const result = await executor.executeAction({
      action: PLANNER_ACTION_ROTATE,
      reason: 'Rotate the device.',
      screenWidth: 1080,
      screenHeight: 2400,
    });

    assert.equal(result.success, false);
    assert.equal(result.error, 'Action failed');
  }

  // A non-blank driver message is preserved verbatim.
  const agent = createAgent([]);
  agent.executeAction = async () =>
    new DeviceNodeResponse({ success: false, message: 'Rotation is not supported.' });

  const executor = new ActionExecutor({
    agent,
    aiAgent: createAiAgent(async () => {
      throw new Error('Grounder should not be called for rotate actions');
    }),
    platform: 'android',
  });

  const result = await executor.executeAction({
    action: PLANNER_ACTION_ROTATE,
    reason: 'Rotate the device.',
    screenWidth: 1080,
    screenHeight: 2400,
  });

  assert.equal(result.success, false);
  assert.equal(result.error, 'Rotation is not supported.');
});
