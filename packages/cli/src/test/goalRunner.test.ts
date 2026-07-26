import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import {
  DeviceActionRequest,
  DeviceInfo,
  DeviceNodeResponse,
  GetAppListAction,
  LaunchAppAction,
  Logger,
  PLATFORM_ANDROID,
  type DeviceInventoryDiagnostic,
  type DeviceInventoryEntry,
  type DeviceInventoryReport,
  type RecordingRequest,
} from '@finalrun/common';
import type { TestExecutionResult } from '@finalrun/goal-executor';
import type { DeviceNode } from '@finalrun/device-node';
import {
  executeTestOnSession,
  prepareTestSession,
  runGoal,
  type TestSessionDeps,
} from '../sessionRunner.js';

function createAndroidTestExecutionResult(): TestExecutionResult {
  return {
    success: true,
    status: 'success',
    message: 'Goal completed successfully.',
    platform: PLATFORM_ANDROID,
    startedAt: '2026-03-20T10:00:00.000Z',
    completedAt: '2026-03-20T10:00:05.000Z',
    steps: [],
    totalIterations: 1,
  };
}

function createAndroidDeviceInfo(): DeviceInfo {
  return new DeviceInfo({
    id: 'emulator-5554',
    deviceUUID: 'emulator-5554',
    isAndroid: true,
    sdkVersion: 34,
    name: 'Android Emulator',
  });
}

function createIOSDeviceInfo(): DeviceInfo {
  return new DeviceInfo({
    id: 'BOOTED-DEVICE-1',
    deviceUUID: 'BOOTED-DEVICE-1',
    isAndroid: false,
    sdkVersion: 17,
    name: 'iPhone 15 Pro',
  });
}

function createInventoryEntryFromDevice(deviceInfo: DeviceInfo): DeviceInventoryEntry {
  const platform = deviceInfo.isAndroid ? 'android' : 'ios';
  const targetKind = deviceInfo.isAndroid ? 'android-emulator' : 'ios-simulator';
  const state = deviceInfo.isAndroid ? 'connected' : 'booted';
  return {
    selectionId: `${platform}:${deviceInfo.id}`,
    platform,
    targetKind,
    state,
    stateDetail: null,
    runnable: true,
    startable: false,
    displayName: `${deviceInfo.name ?? deviceInfo.id} - ${deviceInfo.id}`,
    rawId: deviceInfo.id ?? deviceInfo.deviceUUID,
    modelName: deviceInfo.name,
    osVersionLabel: deviceInfo.isAndroid ? 'Android 14' : 'iOS 17.5',
    deviceInfo,
    transcripts: [],
  };
}

function createStartableIOSEntry(): DeviceInventoryEntry {
  return {
    selectionId: 'ios-simulator:SHUTDOWN-DEVICE-1',
    platform: 'ios',
    targetKind: 'ios-simulator',
    state: 'shutdown',
    stateDetail: null,
    runnable: false,
    startable: true,
    displayName: 'iPhone 15 - iOS 17.5 - SHUTDOWN-DEVICE-1',
    rawId: 'SHUTDOWN-DEVICE-1',
    modelName: 'iPhone 15',
    osVersionLabel: 'iOS 17.5',
    deviceInfo: null,
    transcripts: [],
  };
}

function createDependencies(params: {
  startRecording?: (request: RecordingRequest) => Promise<DeviceNodeResponse>;
  stopRecording?: (runId: string, testId: string) => Promise<DeviceNodeResponse>;
  abortRecording?: (runId: string, keepOutput?: boolean) => Promise<void>;
  executeGoal?: () => Promise<TestExecutionResult>;
  devices?: DeviceInfo[];
  inventoryReports?: DeviceInventoryReport[];
  adbPath?: string | null;
  onInit?: () => void;
  onDetectDevices?: () => void;
  onSetUpDevice?: () => void;
  onCleanup?: () => void | Promise<void>;
  onStartTarget?: (
    entry: DeviceInventoryEntry,
    adbPath: string | null,
  ) => DeviceInventoryDiagnostic | null | Promise<DeviceInventoryDiagnostic | null>;
  onInstallAndroidApp?: (adbPath: string, deviceId: string, appPath: string) => boolean | Promise<boolean>;
  onInstallIOSApp?: (deviceId: string, appPath: string) => boolean | Promise<boolean>;
  availableApps?: Array<{ packageName: string; name: string }>;
  deviceActions?: unknown[];
  onExecuteDeviceAction?: (
    request: DeviceActionRequest,
  ) => DeviceNodeResponse | Promise<DeviceNodeResponse>;
  selectionInput?: string;
}): TestSessionDeps {
  const printedResults: TestExecutionResult[] = [];
  const selectionInput = new PassThrough();
  if (params.selectionInput) {
    selectionInput.end(params.selectionInput);
  }
  const selectionOutput = new PassThrough();
  let selectionOutputText = '';
  selectionOutput.on('data', (chunk: Buffer | string) => {
    selectionOutputText += String(chunk);
  });
  let inventoryCallCount = 0;
  const device = {
    async executeAction(request: DeviceActionRequest) {
      if (params.onExecuteDeviceAction) {
        return await params.onExecuteDeviceAction(request);
      }
      if (request.action instanceof GetAppListAction) {
        return new DeviceNodeResponse({
          success: true,
          data: {
            apps: params.availableApps ?? [],
          },
        });
      }

      params.deviceActions?.push(request.action);
      if (request.action instanceof LaunchAppAction) {
        return new DeviceNodeResponse({
          success: true,
          message: `Launched ${request.action.appUpload.packageName}`,
        });
      }

      return new DeviceNodeResponse({ success: true });
    },
    async startRecording(request: RecordingRequest) {
      return await (params.startRecording ??
        (async () =>
          new DeviceNodeResponse({
            success: true,
            data: {
              startedAt: '2026-03-20T10:00:00.000Z',
            },
          })))(request);
    },
    async stopRecording(runId: string, testId: string) {
      return await (params.stopRecording ??
        (async () =>
          new DeviceNodeResponse({
            success: true,
            data: {
              filePath: '/tmp/run_case.mp4',
              startedAt: '2026-03-20T10:00:00.000Z',
              completedAt: '2026-03-20T10:00:05.000Z',
            },
          })))(runId, testId);
    },
    async abortRecording(runId: string, keepOutput?: boolean) {
      await (params.abortRecording ?? (async () => {}))(runId, keepOutput);
    },
  };

  const deviceNode = {
    async installAndroidApp(adbPath: string, deviceId: string, appPath: string) {
      return await (params.onInstallAndroidApp ??
        (async () => true))(adbPath, deviceId, appPath);
    },
    async installIOSApp(deviceId: string, appPath: string) {
      return await (params.onInstallIOSApp ?? (async () => true))(deviceId, appPath);
    },
    init() {
      params.onInit?.();
    },
    async detectInventory() {
      params.onDetectDevices?.();
      const defaultReport: DeviceInventoryReport = {
        entries: (params.devices ?? [createAndroidDeviceInfo()]).map(createInventoryEntryFromDevice),
        diagnostics: [],
      };
      const nextReport = params.inventoryReports?.[inventoryCallCount] ??
        params.inventoryReports?.[params.inventoryReports.length - 1] ??
        defaultReport;
      inventoryCallCount += 1;
      return nextReport;
    },
    async startTarget(entry: DeviceInventoryEntry, adbPath: string | null) {
      return await (params.onStartTarget ?? (async () => null))(entry, adbPath);
    },
    async setUpDevice() {
      params.onSetUpDevice?.();
      return device;
    },
    async cleanup() {
      await params.onCleanup?.();
    },
  };

  const dependencies: TestSessionDeps = {
    createFilePathUtil: () =>
      ({
        async getADBPath() {
          return params.adbPath ?? '/usr/bin/adb';
        },
      }) as unknown as ReturnType<TestSessionDeps['createFilePathUtil']>,
    getDeviceNode: () => deviceNode as unknown as DeviceNode,
    createSelectionIO: () => ({
      input: selectionInput,
      output: selectionOutput,
      isTTY: true,
    }),
    createAiAgent: () => ({}) as never,
    createExecutor: () =>
      ({
        abort() {},
        async executeGoal() {
          return await (params.executeGoal ?? (async () => createAndroidTestExecutionResult()))();
        },
      }) as ReturnType<TestSessionDeps['createExecutor']>,
    createRenderer: () => ({
      onProgress() {},
      printSummary(result: TestExecutionResult) {
        printedResults.push(result);
      },
      destroy() {},
    }),
  };

  Object.assign(dependencies, {
    __printedResults: printedResults,
    __selectionOutputText: () => selectionOutputText,
  });

  return dependencies;
}

test('runGoal starts and stops Android recording when recording is configured', async () => {
  const recordingRequests: RecordingRequest[] = [];
  const stopCalls: Array<[string, string]> = [];
  const dependencies = createDependencies({
    async startRecording(request) {
      recordingRequests.push(request);
      return new DeviceNodeResponse({
        success: true,
        data: {
          startedAt: '2026-03-20T10:00:00.000Z',
        },
      });
    },
    async stopRecording(runId, testId) {
      stopCalls.push([runId, testId]);
      return new DeviceNodeResponse({
        success: true,
        data: {
          filePath: '/tmp/run_case.mp4',
          startedAt: '2026-03-20T10:00:00.000Z',
          completedAt: '2026-03-20T10:00:05.000Z',
        },
      });
    },
  });

  const result = await runGoal(
    {
      goal: 'Log in',
      apiKeys: { openai: 'test-key' },
      defaults: { provider: 'openai', modelName: 'gpt-4.1' },
      platform: PLATFORM_ANDROID,
      recording: {
        runId: 'run-1',
        testId: 'case-1',
      },
    },
    dependencies,
  );

  assert.equal(result.success, true);
  assert.deepEqual(stopCalls, [['run-1', 'case-1']]);
  assert.equal(recordingRequests.length, 1);
  assert.equal(recordingRequests[0]?.runId, 'run-1');
  assert.equal(recordingRequests[0]?.testId, 'case-1');
  assert.equal(recordingRequests[0]?.outputFilePath, undefined);
  assert.equal(result.recording?.filePath, '/tmp/run_case.mp4');
});

test('executeTestOnSession forwards explicit recording output paths and preserves partials when execution aborts', async () => {
  const recordingRequests: RecordingRequest[] = [];
  const abortCalls: Array<[string, boolean | undefined]> = [];
  const dependencies = createDependencies({
    async startRecording(request) {
      recordingRequests.push(request);
      return new DeviceNodeResponse({
        success: true,
        data: {
          startedAt: '2026-03-20T10:00:00.000Z',
        },
      });
    },
    async abortRecording(runId, keepOutput) {
      abortCalls.push([runId, keepOutput]);
    },
    async executeGoal() {
      throw new Error('executor crashed');
    },
  });

  const session = await prepareTestSession(
    {
      platform: PLATFORM_ANDROID,
    },
    dependencies,
  );

  try {
    await assert.rejects(
      () =>
        executeTestOnSession(
          session,
          {
            goal: 'Test 1',
            apiKeys: { openai: 'test-key' },
            defaults: { provider: 'openai', modelName: 'gpt-4.1' },
            recording: {
              runId: 'run-1',
              testId: 'case-1',
              outputFilePath: '/tmp/finalrun-artifacts/run-1/tests/case-1/recording.mp4',
              keepPartialOnFailure: true,
            },
          },
          dependencies,
        ),
      /executor crashed/,
    );

    assert.equal(
      recordingRequests[0]?.outputFilePath,
      '/tmp/finalrun-artifacts/run-1/tests/case-1/recording.mp4',
    );
    assert.deepEqual(abortCalls, [['run-1', true]]);
  } finally {
    await session.cleanup();
  }
});

test('prepareTestSession installs the Android app override once during shared setup', async () => {
  const installCalls: Array<[string, string, string]> = [];
  let detectCalls = 0;
  let setUpCalls = 0;
  let cleanupCalls = 0;
  const dependencies = createDependencies({
    onDetectDevices() {
      detectCalls += 1;
    },
    onSetUpDevice() {
      setUpCalls += 1;
    },
    async onCleanup() {
      cleanupCalls += 1;
    },
    async onInstallAndroidApp(adbPath, deviceId, appPath) {
      installCalls.push([adbPath, deviceId, appPath]);
      return true;
    },
  });

  const session = await prepareTestSession(
    {
      platform: PLATFORM_ANDROID,
      appOverridePath: '/tmp/app.apk',
    },
    dependencies,
  );

  try {
    assert.equal(session.platform, PLATFORM_ANDROID);
    assert.equal(detectCalls, 1);
    assert.equal(setUpCalls, 1);
    assert.deepEqual(installCalls, [['/usr/bin/adb', 'emulator-5554', '/tmp/app.apk']]);
  } finally {
    await session.cleanup();
    assert.equal(cleanupCalls, 1);
  }
});

test('prepareTestSession prelaunches the configured app and stores the launch summary', async () => {
  const deviceActions: unknown[] = [];
  const dependencies = createDependencies({
    availableApps: [
      { packageName: 'org.wikipedia', name: 'Wikipedia' },
    ],
    deviceActions,
  });

  const session = await prepareTestSession(
    {
      platform: PLATFORM_ANDROID,
      app: {
        platform: PLATFORM_ANDROID,
        identifier: 'org.wikipedia',
        identifierKind: 'packageName',
      },
    },
    dependencies,
  );

  try {
    assert.equal(session.app?.identifier, 'org.wikipedia');
    assert.match(
      session.launchSummary ?? '',
      /already launched Android package "org\.wikipedia" before the goal started/,
    );
    assert.equal(deviceActions.length, 1);
    assert.ok(deviceActions[0] instanceof LaunchAppAction);
    assert.equal(
      (deviceActions[0] as LaunchAppAction).shouldUninstallBeforeLaunch,
      false,
    );
  } finally {
    await session.cleanup();
  }
});

test('prepareTestSession fails when the configured app is not installed', async () => {
  const dependencies = createDependencies({
    availableApps: [],
  });

  await assert.rejects(
    () =>
      prepareTestSession(
        {
          platform: PLATFORM_ANDROID,
          app: {
            platform: PLATFORM_ANDROID,
            identifier: 'org.wikipedia',
            identifierKind: 'packageName',
          },
        },
        dependencies,
      ),
    /Android package "org\.wikipedia" is not installed on the selected device/,
  );
});

test('prepareTestSession logs a compact summary when one target is auto-selected', async () => {
  const androidEntry = createInventoryEntryFromDevice(createAndroidDeviceInfo());
  const shutdownEntry = createStartableIOSEntry();
  const dependencies = createDependencies({
    inventoryReports: [
      {
        entries: [androidEntry, shutdownEntry],
        diagnostics: [],
      },
    ],
  });
  const logMessages: string[] = [];
  const sink = (entry: { renderedMessage: string }) => {
    logMessages.push(entry.renderedMessage);
  };
  Logger.addSink(sink);

  const session = await prepareTestSession({}, dependencies);

  try {
    const output = (dependencies as TestSessionDeps & {
      __selectionOutputText: () => string;
    }).__selectionOutputText();
    assert.equal(output, '');
    assert.match(
      logMessages.join('\n'),
      /\[finalrun\] Detected 2 targets \(1 Android, 1 iOS\); 1 ready target: Android Emulator - emulator-5554/,
    );
  } finally {
    Logger.removeSink(sink);
    await session.cleanup();
  }
});

test('prepareTestSession prompts for a device when multiple runnable targets are available', async () => {
  const androidEntry = createInventoryEntryFromDevice(createAndroidDeviceInfo());
  const iosEntry = createInventoryEntryFromDevice(createIOSDeviceInfo());
  const dependencies = createDependencies({
    inventoryReports: [
      {
        entries: [androidEntry, iosEntry],
        diagnostics: [],
      },
    ],
    selectionInput: '2\n',
  });

  const session = await prepareTestSession({}, dependencies);

  try {
    assert.equal(session.platform, 'ios');
    const output = (dependencies as TestSessionDeps & {
      __selectionOutputText: () => string;
    }).__selectionOutputText();
    assert.doesNotMatch(output, /Detected local targets/);
    assert.match(output, /Select a device/);
    assert.match(output, /Ready Targets/);
    assert.match(output, /\(connected\)/);
    assert.match(output, /\(booted\)/);
    assert.equal((output.match(/Ready Targets/g) ?? []).length, 1);
  } finally {
    await session.cleanup();
  }
});

test('prepareTestSession starts a selected shutdown simulator before setup', async () => {
  const shutdownEntry = createStartableIOSEntry();
  const bootedEntry: DeviceInventoryEntry = {
    selectionId: 'ios-simulator:SHUTDOWN-DEVICE-1',
    platform: 'ios',
    targetKind: 'ios-simulator',
    state: 'booted',
    stateDetail: null,
    runnable: true,
    startable: false,
    displayName: 'iPhone 15 - iOS 17.5 - SHUTDOWN-DEVICE-1',
    rawId: 'SHUTDOWN-DEVICE-1',
    modelName: 'iPhone 15',
    osVersionLabel: 'iOS 17.5',
    deviceInfo: new DeviceInfo({
      id: 'SHUTDOWN-DEVICE-1',
      deviceUUID: 'SHUTDOWN-DEVICE-1',
      isAndroid: false,
      sdkVersion: 17,
      name: 'iPhone 15',
    }),
    transcripts: [],
  };
  let startedTargets = 0;
  const dependencies = createDependencies({
    inventoryReports: [
      {
        entries: [shutdownEntry],
        diagnostics: [],
      },
      {
        entries: [bootedEntry],
        diagnostics: [],
      },
    ],
    async onStartTarget() {
      startedTargets += 1;
      return null;
    },
  });

  const session = await prepareTestSession({}, dependencies);

  try {
    assert.equal(session.platform, 'ios');
    assert.equal(startedTargets, 1);
  } finally {
    await session.cleanup();
  }
});

test('prepareTestSession reports Android app override failure after driver connection', async () => {
  let cleanupCalls = 0;
  let setUpCalls = 0;
  const dependencies = createDependencies({
    onSetUpDevice() {
      setUpCalls += 1;
    },
    async onCleanup() {
      cleanupCalls += 1;
    },
    async onInstallAndroidApp() {
      return false;
    },
  });

  await assert.rejects(
    () =>
      prepareTestSession(
        {
          platform: PLATFORM_ANDROID,
          appOverridePath: '/tmp/app.apk',
        },
        dependencies,
      ),
    /Failed to install Android app override after driver connection: \/tmp\/app\.apk/,
  );

  assert.equal(setUpCalls, 1);
  assert.equal(cleanupCalls, 1);
});

test('executeTestOnSession reuses one prepared session while keeping recording scoped per test', async () => {
  const recordingRequests: RecordingRequest[] = [];
  const stopCalls: Array<[string, string]> = [];
  let detectCalls = 0;
  let setUpCalls = 0;
  let cleanupCalls = 0;
  const dependencies = createDependencies({
    onDetectDevices() {
      detectCalls += 1;
    },
    onSetUpDevice() {
      setUpCalls += 1;
    },
    async onCleanup() {
      cleanupCalls += 1;
    },
    async startRecording(request) {
      recordingRequests.push(request);
      return new DeviceNodeResponse({
        success: true,
        data: {
          startedAt: '2026-03-20T10:00:00.000Z',
        },
      });
    },
    async stopRecording(runId, testId) {
      stopCalls.push([runId, testId]);
      return new DeviceNodeResponse({
        success: true,
        data: {
          filePath: `/tmp/${testId}.mp4`,
          startedAt: '2026-03-20T10:00:00.000Z',
          completedAt: '2026-03-20T10:00:05.000Z',
        },
      });
    },
  });

  const session = await prepareTestSession(
    {
      platform: PLATFORM_ANDROID,
    },
    dependencies,
  );

  try {
    await executeTestOnSession(
      session,
      {
        goal: 'Test 1',
        apiKeys: { openai: 'test-key' },
        defaults: { provider: 'openai', modelName: 'gpt-4.1' },
        recording: {
          runId: 'run-1',
          testId: 'case-1',
        },
      },
      dependencies,
    );
    await executeTestOnSession(
      session,
      {
        goal: 'Test 2',
        apiKeys: { openai: 'test-key' },
        defaults: { provider: 'openai', modelName: 'gpt-4.1' },
        recording: {
          runId: 'run-1',
          testId: 'case-2',
        },
      },
      dependencies,
    );

    assert.equal(detectCalls, 1);
    assert.equal(setUpCalls, 1);
    assert.deepEqual(
      recordingRequests.map((request) => request.testId),
      ['case-1', 'case-2'],
    );
    assert.deepEqual(stopCalls, [
      ['run-1', 'case-1'],
      ['run-1', 'case-2'],
    ]);
  } finally {
    await session.cleanup();
    assert.equal(cleanupCalls, 1);
  }
});

test('executeTestOnSession forwards the prelaunch summary and app identifier to the executor', async () => {
  let capturedConfig:
    | {
        preContext?: string;
        appIdentifier?: string;
      }
    | undefined;
  const dependencies = createDependencies({});
  dependencies.createExecutor = (params) => {
    capturedConfig = {
      preContext: params.preContext,
      appIdentifier: params.appIdentifier,
    };
    return {
      abort() {},
      async executeGoal() {
        return createAndroidTestExecutionResult();
      },
    };
  };

  const session = {
    platform: 'android' as const,
    deviceInfo: {} as never,
    deviceNode: {} as never,
    device: {} as never,
    app: {
      platform: 'android' as const,
      identifier: 'org.wikipedia',
      identifierKind: 'packageName' as const,
    },
    launchSummary: 'The CLI already launched Android package "org.wikipedia".',
    async cleanup() {
      return undefined;
    },
  };

  await executeTestOnSession(
    session,
    {
      goal: 'Test 1',
      apiKeys: { openai: 'test-key' },
      defaults: { provider: 'openai', modelName: 'gpt-4.1' },
    },
    dependencies,
  );

  assert.deepEqual(capturedConfig, {
    preContext: 'The CLI already launched Android package "org.wikipedia".',
    appIdentifier: 'org.wikipedia',
  });
});

test('runGoal still performs isolated setup and cleanup for single-test execution', async () => {
  let detectCalls = 0;
  let setUpCalls = 0;
  let cleanupCalls = 0;
  const dependencies = createDependencies({
    onDetectDevices() {
      detectCalls += 1;
    },
    onSetUpDevice() {
      setUpCalls += 1;
    },
    async onCleanup() {
      cleanupCalls += 1;
    },
  });

  const result = await runGoal(
    {
      goal: 'Log in',
      apiKeys: { openai: 'test-key' },
      defaults: { provider: 'openai', modelName: 'gpt-4.1' },
      platform: PLATFORM_ANDROID,
    },
    dependencies,
  );

  assert.equal(result.success, true);
  assert.equal(detectCalls, 1);
  assert.equal(setUpCalls, 1);
  assert.equal(cleanupCalls, 1);
});

test('runGoal fails before execution if required Android recording cannot start', async () => {
  let executed = false;
  const dependencies = createDependencies({
    async startRecording() {
      return new DeviceNodeResponse({
        success: false,
        message: 'scrcpy not found in PATH',
      });
    },
    async executeGoal() {
      executed = true;
      return createAndroidTestExecutionResult();
    },
  });

  const result = await runGoal(
    {
      goal: 'Log in',
      apiKeys: { openai: 'test-key' },
      defaults: { provider: 'openai', modelName: 'gpt-4.1' },
      platform: PLATFORM_ANDROID,
      recording: {
        runId: 'run-1',
        testId: 'case-1',
      },
    },
    dependencies,
  );

  assert.equal(result.success, false);
  assert.equal(executed, false);
  assert.match(result.message, /Recording is required for Android runs/);
});

test('runGoal marks the Android test as failed if recording stops without a video file', async () => {
  const abortCalls: Array<[string, boolean | undefined]> = [];
  const dependencies = createDependencies({
    async startRecording() {
      return new DeviceNodeResponse({
        success: true,
        data: {
          startedAt: '2026-03-20T10:00:00.000Z',
        },
      });
    },
    async stopRecording() {
      return new DeviceNodeResponse({
        success: false,
        message: 'scrcpy process exited before file creation',
      });
    },
    async abortRecording(runId, keepOutput) {
      abortCalls.push([runId, keepOutput]);
    },
  });

  const result = await runGoal(
    {
      goal: 'Log in',
      apiKeys: { openai: 'test-key' },
      defaults: { provider: 'openai', modelName: 'gpt-4.1' },
      platform: PLATFORM_ANDROID,
      recording: {
        runId: 'run-1',
        testId: 'case-1',
      },
    },
    dependencies,
  );

  assert.equal(result.success, false);
  assert.match(result.message, /Recording is required for Android runs/);
  assert.deepEqual(abortCalls, [['run-1', false]]);
});
