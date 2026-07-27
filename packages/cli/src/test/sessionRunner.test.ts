// Characterization tests for sessionRunner (260727-18tg).
//
// These tests pin the CURRENT behaviour of packages/cli/src/sessionRunner.ts —
// they passed green against the unmodified source before the file was
// restructured, and must keep passing byte-for-byte unchanged afterwards.
// All fakes flow through the EXISTING seams only: the `dependencies:
// TestSessionDeps` parameter and the `session: TestSession` parameter. No
// source reshaping. They complement goalRunner.test.ts, which covers the
// recording lifecycle, app override/prelaunch, and device selection prompts.

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import {
  DeviceInfo,
  DeviceNodeResponse,
  Logger,
  PLATFORM_ANDROID,
  type DeviceInventoryDiagnostic,
  type DeviceInventoryEntry,
  type DeviceInventoryReport,
  type LoggerSink,
  type ModelDefaults,
} from '@finalrun/common';
import type { DeviceNode } from '@finalrun/device-node';
import type { TestExecutionResult } from '@finalrun/goal-executor';
import {
  DevicePreparationError,
  executeTestOnSession,
  prepareTestSession,
  type TestSession,
  type TestSessionConfig,
  type TestSessionDeps,
} from '../sessionRunner.js';

const MODEL_DEFAULTS: ModelDefaults = { provider: 'openai', modelName: 'gpt-5.4-mini' };

function createExecutionResult(params?: Partial<TestExecutionResult>): TestExecutionResult {
  return {
    success: true,
    status: 'success',
    message: 'Goal completed successfully.',
    platform: PLATFORM_ANDROID,
    startedAt: '2026-03-20T10:00:00.000Z',
    completedAt: '2026-03-20T10:00:05.000Z',
    steps: [],
    totalIterations: 1,
    ...params,
  };
}

interface RecordedCall {
  method: string;
  args: unknown[];
}

function createFakeDevice(params?: {
  startLogCapture?: () => Promise<DeviceNodeResponse> | DeviceNodeResponse;
  stopLogCapture?: () => Promise<DeviceNodeResponse> | DeviceNodeResponse;
  startRecording?: () => Promise<DeviceNodeResponse> | DeviceNodeResponse;
  stopRecording?: () => Promise<DeviceNodeResponse> | DeviceNodeResponse;
}) {
  const calls: RecordedCall[] = [];
  const device = {
    calls,
    async startRecording(request: unknown) {
      calls.push({ method: 'startRecording', args: [request] });
      return await (params?.startRecording ??
        (() => new DeviceNodeResponse({
          success: true,
          data: { startedAt: '2026-03-20T10:00:00.000Z' },
        })))();
    },
    async stopRecording(runId: string, testId: string) {
      calls.push({ method: 'stopRecording', args: [runId, testId] });
      return await (params?.stopRecording ??
        (() => new DeviceNodeResponse({
          success: true,
          data: {
            filePath: '/tmp/recording.mp4',
            startedAt: '2026-03-20T10:00:00.000Z',
            completedAt: '2026-03-20T10:00:05.000Z',
          },
        })))();
    },
    async abortRecording(runId: string, keepOutput?: boolean) {
      calls.push({ method: 'abortRecording', args: [runId, keepOutput] });
    },
    async startLogCapture(request: unknown) {
      calls.push({ method: 'startLogCapture', args: [request] });
      return await (params?.startLogCapture ??
        (() => new DeviceNodeResponse({
          success: true,
          data: { startedAt: '2026-03-20T10:00:00.100Z' },
        })))();
    },
    async stopLogCapture(runId: string, testId: string) {
      calls.push({ method: 'stopLogCapture', args: [runId, testId] });
      return await (params?.stopLogCapture ??
        (() => new DeviceNodeResponse({
          success: true,
          data: {
            filePath: '/tmp/device.log',
            startedAt: '2026-03-20T10:00:00.100Z',
            completedAt: '2026-03-20T10:00:04.900Z',
          },
        })))();
    },
    async abortLogCapture(runId: string, keepOutput?: boolean) {
      calls.push({ method: 'abortLogCapture', args: [runId, keepOutput] });
    },
  };
  return device;
}

function callsTo(device: { calls: RecordedCall[] }, method: string): RecordedCall[] {
  return device.calls.filter((call) => call.method === method);
}

function createSession(
  device: ReturnType<typeof createFakeDevice>,
  overrides?: Partial<TestSession>,
): TestSession {
  return {
    deviceNode: {} as never,
    device: device as unknown as TestSession['device'],
    deviceInfo: {} as never,
    platform: PLATFORM_ANDROID,
    app: undefined,
    launchSummary: undefined,
    async cleanup() {},
    ...overrides,
  };
}

function createExecuteDeps(params?: {
  executeGoal?: () => Promise<TestExecutionResult>;
}) {
  const printedResults: TestExecutionResult[] = [];
  let abortCalls = 0;
  let destroyCalls = 0;
  let executeGoalCalls = 0;
  const dependencies: TestSessionDeps = {
    createFilePathUtil: () => ({}) as never,
    getDeviceNode: () => ({}) as never,
    createSelectionIO: () => ({
      input: new PassThrough(),
      output: new PassThrough(),
      isTTY: false,
    }),
    createAiAgent: () => ({}) as never,
    createExecutor: () =>
      ({
        abort() {
          abortCalls += 1;
        },
        async executeGoal() {
          executeGoalCalls += 1;
          return await (params?.executeGoal ?? (async () => createExecutionResult()))();
        },
      }) as ReturnType<TestSessionDeps['createExecutor']>,
    createRenderer: () => ({
      onProgress() {},
      printSummary(result: TestExecutionResult) {
        printedResults.push(result);
      },
      destroy() {
        destroyCalls += 1;
      },
    }),
  };
  return {
    dependencies,
    printedResults,
    getAbortCalls: () => abortCalls,
    getDestroyCalls: () => destroyCalls,
    getExecuteGoalCalls: () => executeGoalCalls,
  };
}

function createConfig(params?: Partial<TestSessionConfig>): TestSessionConfig {
  return {
    goal: 'Open the app.',
    apiKeys: { openai: 'key' },
    defaults: MODEL_DEFAULTS,
    ...params,
  };
}

test('executeTestOnSession returns an aborted result without executing when the signal is already aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  const device = createFakeDevice();
  const harness = createExecuteDeps();

  const result = await executeTestOnSession(
    createSession(device),
    createConfig({ abortSignal: controller.signal }),
    harness.dependencies,
  );

  assert.equal(result.status, 'aborted');
  assert.equal(result.success, false);
  assert.equal(result.message, 'Goal execution was aborted');
  assert.deepEqual(result.steps, []);
  assert.equal(harness.getExecuteGoalCalls(), 0);
  assert.deepEqual(harness.printedResults, [result]);
  assert.equal(harness.getDestroyCalls(), 1);
  assert.deepEqual(device.calls, []);
});

test('executeTestOnSession wires the abort signal to the executor and removes the listener afterwards', async () => {
  const abortingController = new AbortController();
  const device = createFakeDevice();
  const abortingHarness = createExecuteDeps({
    executeGoal: async () => {
      abortingController.abort();
      return createExecutionResult({ success: false, status: 'aborted', message: 'aborted' });
    },
  });
  await executeTestOnSession(
    createSession(device),
    createConfig({ abortSignal: abortingController.signal }),
    abortingHarness.dependencies,
  );
  assert.equal(abortingHarness.getAbortCalls(), 1);

  const lateController = new AbortController();
  const lateHarness = createExecuteDeps();
  await executeTestOnSession(
    createSession(createFakeDevice()),
    createConfig({ abortSignal: lateController.signal }),
    lateHarness.dependencies,
  );
  lateController.abort();
  assert.equal(lateHarness.getAbortCalls(), 0, 'listener must be removed after completion');
});

test('executeTestOnSession pins the device-log capture lifecycle on the happy path', async () => {
  const device = createFakeDevice();
  const harness = createExecuteDeps();
  const session = createSession(device, {
    app: { platform: PLATFORM_ANDROID, identifier: 'org.wikipedia' } as TestSession['app'],
  });

  const result = await executeTestOnSession(
    session,
    createConfig({ deviceLog: { runId: 'run-1', testId: 'test-1' } }),
    harness.dependencies,
  );

  assert.deepEqual(callsTo(device, 'startLogCapture')[0]!.args, [
    { runId: 'run-1', testId: 'test-1', appIdentifier: 'org.wikipedia' },
  ]);
  assert.deepEqual(callsTo(device, 'stopLogCapture')[0]!.args, ['run-1', 'test-1']);
  assert.equal(callsTo(device, 'abortLogCapture').length, 0);
  assert.deepEqual(result.deviceLog, {
    filePath: '/tmp/device.log',
    startedAt: '2026-03-20T10:00:00.100Z',
    completedAt: '2026-03-20T10:00:04.900Z',
  });
  // No recording was configured: the result carries no recording key.
  assert.equal('recording' in result, false);
});

test('executeTestOnSession falls back to capture-start timestamps when stop omits them', async () => {
  const device = createFakeDevice({
    stopLogCapture: () =>
      new DeviceNodeResponse({ success: true, data: { filePath: '/tmp/device.log' } }),
  });
  const harness = createExecuteDeps();

  const before = Date.now();
  const result = await executeTestOnSession(
    createSession(device),
    createConfig({ deviceLog: { runId: 'run-1', testId: 'test-1' } }),
    harness.dependencies,
  );
  const after = Date.now();

  // startedAt falls back to the value captured when the capture STARTED.
  assert.equal(result.deviceLog?.startedAt, '2026-03-20T10:00:00.100Z');
  // completedAt falls back to "now".
  const completedAt = new Date(result.deviceLog?.completedAt ?? '').getTime();
  assert.equal(completedAt >= before && completedAt <= after, true);
});

test('executeTestOnSession aborts the log capture when stop reports failure', async () => {
  const device = createFakeDevice({
    stopLogCapture: () =>
      new DeviceNodeResponse({ success: false, message: 'log pull failed' }),
  });
  const harness = createExecuteDeps();

  const result = await executeTestOnSession(
    createSession(device),
    createConfig({
      deviceLog: { runId: 'run-1', testId: 'test-1', keepPartialOnFailure: true },
    }),
    harness.dependencies,
  );

  // The stop-failure abort keeps the partial per config, and the run result survives.
  assert.deepEqual(callsTo(device, 'abortLogCapture'), [
    { method: 'abortLogCapture', args: ['run-1', true] },
  ]);
  assert.equal('deviceLog' in result, false);
  assert.equal(result.success, true);
});

test('executeTestOnSession lets the finally block abort a capture whose stop threw', async () => {
  const device = createFakeDevice({
    stopLogCapture: () => {
      throw new Error('gRPC channel closed');
    },
  });
  const harness = createExecuteDeps();

  const result = await executeTestOnSession(
    createSession(device),
    createConfig({ deviceLog: { runId: 'run-1', testId: 'test-1' } }),
    harness.dependencies,
  );

  // The capture stayed active through the throw, so the finally block aborts it.
  assert.deepEqual(callsTo(device, 'abortLogCapture'), [
    { method: 'abortLogCapture', args: ['run-1', false] },
  ]);
  assert.equal('deviceLog' in result, false);
  assert.equal(result.success, true);
  assert.equal(harness.getDestroyCalls(), 1);
});

test('executeTestOnSession continues the run when log capture cannot start', async () => {
  const failingStart = createFakeDevice({
    startLogCapture: () => new DeviceNodeResponse({ success: false, message: 'no provider' }),
  });
  const failingHarness = createExecuteDeps();
  const failedStartResult = await executeTestOnSession(
    createSession(failingStart),
    createConfig({ deviceLog: { runId: 'run-1', testId: 'test-1' } }),
    failingHarness.dependencies,
  );
  assert.equal(failedStartResult.success, true);
  assert.equal(callsTo(failingStart, 'stopLogCapture').length, 0);
  assert.equal(callsTo(failingStart, 'abortLogCapture').length, 0);

  const throwingStart = createFakeDevice({
    startLogCapture: () => {
      throw new Error('capture unavailable');
    },
  });
  const throwingHarness = createExecuteDeps();
  const thrownStartResult = await executeTestOnSession(
    createSession(throwingStart),
    createConfig({ deviceLog: { runId: 'run-1', testId: 'test-1' } }),
    throwingHarness.dependencies,
  );
  assert.equal(thrownStartResult.success, true);
  assert.equal(callsTo(throwingStart, 'stopLogCapture').length, 0);
  assert.equal(callsTo(throwingStart, 'abortLogCapture').length, 0);
});

test('executeTestOnSession aborts active recording and log capture when the executor throws', async () => {
  const device = createFakeDevice();
  const harness = createExecuteDeps({
    executeGoal: async () => {
      throw new Error('executor exploded');
    },
  });

  await assert.rejects(
    () =>
      executeTestOnSession(
        createSession(device),
        createConfig({
          recording: { runId: 'run-1', testId: 'test-1', keepPartialOnFailure: true },
          deviceLog: { runId: 'run-1', testId: 'test-1' },
        }),
        harness.dependencies,
      ),
    /executor exploded/,
  );

  assert.deepEqual(callsTo(device, 'abortRecording'), [
    { method: 'abortRecording', args: ['run-1', true] },
  ]);
  assert.deepEqual(callsTo(device, 'abortLogCapture'), [
    { method: 'abortLogCapture', args: ['run-1', false] },
  ]);
  assert.equal(callsTo(device, 'stopRecording').length, 0);
  assert.equal(harness.getDestroyCalls(), 1, 'renderer is destroyed on the throw path');
});

test('executeTestOnSession continues without recording when an optional recording fails to start', async () => {
  const device = createFakeDevice({
    startRecording: () => new DeviceNodeResponse({ success: false, message: 'scrcpy missing' }),
  });
  const harness = createExecuteDeps();

  // iOS: recording is not required, so a start failure only warns.
  const result = await executeTestOnSession(
    createSession(device, { platform: 'ios' }),
    createConfig({ recording: { runId: 'run-1', testId: 'test-1' } }),
    harness.dependencies,
  );

  assert.equal(result.success, true);
  assert.equal('recording' in result, false);
  assert.equal(callsTo(device, 'stopRecording').length, 0);
  assert.equal(callsTo(device, 'abortRecording').length, 0);
});

test('executeTestOnSession appends the required-recording failure to an already-failed result', async () => {
  const device = createFakeDevice({
    stopRecording: () => new DeviceNodeResponse({ success: true, data: {} }),
  });
  const harness = createExecuteDeps({
    executeGoal: async () =>
      createExecutionResult({ success: false, status: 'failure', message: 'goal failed first' }),
  });

  const result = await executeTestOnSession(
    createSession(device),
    createConfig({ recording: { runId: 'run-1', testId: 'test-1' } }),
    harness.dependencies,
  );

  assert.equal(result.success, false);
  assert.equal(result.status, 'failure');
  // markGoalResultFailed CONCATENATES onto an already-failed result's message.
  assert.equal(
    result.message,
    'goal failed first\nRecording is required for Android runs. ' +
      'Recording stopped for test test-1 but no file path was returned.',
  );
});

// --- capture release when the runner-log sink throws -------------------------
//
// REGRESSION tests (18tg rework cycle 1), not characterization: the runner-log
// sink (ReportWriter.createLoggerSink) is an unguarded synchronous
// fs.appendFileSync called from Logger's unguarded sink loop, so Logger.i
// genuinely throws on ENOSPC/EACCES/removed run dir. The acquisition must be
// recorded in the per-call state BEFORE the "started" log line, or a throwing
// sink orphans a capture that origin/main released (review must-fix #1, R8).

test('a log capture whose "started" log line throws is still stopped, not orphaned', async () => {
  const device = createFakeDevice();
  const harness = createExecuteDeps();
  const throwingSink: LoggerSink = (entry) => {
    if (entry.message.includes('Log capture started')) {
      throw new Error('ENOSPC: runner.log sink failed');
    }
  };
  Logger.addSink(throwingSink);
  try {
    const result = await executeTestOnSession(
      createSession(device),
      createConfig({ deviceLog: { runId: 'run-1', testId: 'test-1' } }),
      harness.dependencies,
    );

    // The capture was recorded before the throwing log line, so the normal
    // stop path still runs — same device-call sequence as origin/main.
    assert.deepEqual(callsTo(device, 'stopLogCapture')[0]?.args, ['run-1', 'test-1']);
    assert.equal(callsTo(device, 'abortLogCapture').length, 0);
    assert.deepEqual(result.deviceLog, {
      filePath: '/tmp/device.log',
      startedAt: '2026-03-20T10:00:00.100Z',
      completedAt: '2026-03-20T10:00:04.900Z',
    });
  } finally {
    Logger.removeSink(throwingSink);
  }
});

test('a recording whose "started" log line throws is aborted before the throw propagates', async () => {
  const device = createFakeDevice();
  const harness = createExecuteDeps();
  const throwingSink: LoggerSink = (entry) => {
    if (entry.message.includes('Recording started')) {
      throw new Error('ENOSPC: runner.log sink failed');
    }
  };
  Logger.addSink(throwingSink);
  try {
    await assert.rejects(
      () =>
        executeTestOnSession(
          createSession(device),
          createConfig({
            recording: { runId: 'run-1', testId: 'test-1', keepPartialOnFailure: true },
          }),
          harness.dependencies,
        ),
      /ENOSPC/,
    );

    // The recording was recorded as acquired before the throwing log line, so
    // the finally block aborts it — same device-call sequence as origin/main.
    assert.deepEqual(callsTo(device, 'abortRecording'), [
      { method: 'abortRecording', args: ['run-1', true] },
    ]);
    assert.equal(harness.getExecuteGoalCalls(), 0);
    assert.equal(harness.getDestroyCalls(), 1);
  } finally {
    Logger.removeSink(throwingSink);
  }
});

// --- prepareTestSession -----------------------------------------------------

function createAndroidDeviceInfo(): DeviceInfo {
  return new DeviceInfo({
    id: 'emulator-5554',
    deviceUUID: 'emulator-5554',
    isAndroid: true,
    sdkVersion: 34,
    name: 'Android Emulator',
  });
}

function createRunnableEntry(deviceInfo: DeviceInfo): DeviceInventoryEntry {
  return {
    selectionId: `android:${deviceInfo.id}`,
    platform: 'android',
    targetKind: 'android-emulator',
    state: 'connected',
    stateDetail: null,
    runnable: true,
    startable: false,
    displayName: `${deviceInfo.name} - ${deviceInfo.id}`,
    rawId: deviceInfo.id ?? deviceInfo.deviceUUID,
    modelName: deviceInfo.name,
    osVersionLabel: 'Android 14',
    deviceInfo,
    transcripts: [],
  };
}

function createStartableEntry(): DeviceInventoryEntry {
  return {
    selectionId: 'ios-simulator:SHUTDOWN-1',
    platform: 'ios',
    targetKind: 'ios-simulator',
    state: 'shutdown',
    stateDetail: null,
    runnable: false,
    startable: true,
    displayName: 'iPhone 15 - SHUTDOWN-1',
    rawId: 'SHUTDOWN-1',
    modelName: 'iPhone 15',
    osVersionLabel: 'iOS 17.5',
    deviceInfo: null,
    transcripts: [],
  };
}

function createPrepareDeps(params: {
  inventoryReports: DeviceInventoryReport[];
  onStartTarget?: (
    entry: DeviceInventoryEntry,
  ) => DeviceInventoryDiagnostic | null | Promise<DeviceInventoryDiagnostic | null>;
}) {
  let cleanupCalls = 0;
  let inventoryCallCount = 0;
  const setUpDeviceArgs: DeviceInfo[] = [];
  const device = createFakeDevice();
  const deviceNode = {
    init() {},
    async detectInventory() {
      const report =
        params.inventoryReports[inventoryCallCount] ??
        params.inventoryReports[params.inventoryReports.length - 1]!;
      inventoryCallCount += 1;
      return report;
    },
    async startTarget(entry: DeviceInventoryEntry) {
      return await (params.onStartTarget ?? (async () => null))(entry);
    },
    async setUpDevice(deviceInfo: DeviceInfo) {
      setUpDeviceArgs.push(deviceInfo);
      return device;
    },
    async cleanup() {
      cleanupCalls += 1;
    },
    async installAndroidApp() {
      return true;
    },
    async installIOSApp() {
      return true;
    },
  };
  const dependencies: TestSessionDeps = {
    createFilePathUtil: () =>
      ({
        async getADBPath() {
          return '/usr/bin/adb';
        },
      }) as never,
    getDeviceNode: () => deviceNode as unknown as DeviceNode,
    createSelectionIO: () => ({
      input: new PassThrough(),
      output: new PassThrough(),
      isTTY: false,
    }),
    createAiAgent: () => ({}) as never,
    createExecutor: () =>
      ({ abort() {}, executeGoal: async () => createExecutionResult() }) as never,
    createRenderer: () => ({ onProgress() {}, printSummary() {}, destroy() {} }),
  };
  return {
    dependencies,
    getCleanupCalls: () => cleanupCalls,
    setUpDeviceArgs,
  };
}

test('prepareTestSession returns a session whose cleanup is idempotent', async () => {
  const deviceInfo = createAndroidDeviceInfo();
  const harness = createPrepareDeps({
    inventoryReports: [{ entries: [createRunnableEntry(deviceInfo)], diagnostics: [] }],
  });

  const session = await prepareTestSession({}, harness.dependencies);

  assert.equal(session.platform, PLATFORM_ANDROID);
  assert.equal(session.deviceInfo, deviceInfo);
  assert.deepEqual(harness.setUpDeviceArgs, [deviceInfo]);
  assert.equal(session.launchSummary, undefined);

  await session.cleanup();
  await session.cleanup();
  assert.equal(harness.getCleanupCalls(), 1, 'cleanup must run the device teardown once');
});

test('prepareTestSession wraps a startup diagnostic in DevicePreparationError and cleans up', async () => {
  const diagnostic: DeviceInventoryDiagnostic = {
    scope: 'startup',
    summary: 'Simulator failed to boot.',
    blocking: true,
    transcripts: [],
  };
  const harness = createPrepareDeps({
    inventoryReports: [{ entries: [createStartableEntry()], diagnostics: [] }],
    onStartTarget: () => diagnostic,
  });

  await assert.rejects(
    () => prepareTestSession({}, harness.dependencies),
    (error: unknown) => {
      assert.equal(error instanceof DevicePreparationError, true);
      const preparationError = error as DevicePreparationError;
      assert.equal(preparationError.message, 'Simulator failed to boot.');
      assert.deepEqual(preparationError.diagnostics, [diagnostic]);
      return true;
    },
  );
  assert.equal(harness.getCleanupCalls(), 1, 'setup failure must release device resources');
});

test('prepareTestSession fails when the started device never becomes runnable', async () => {
  const startable = createStartableEntry();
  const harness = createPrepareDeps({
    // Second detection still reports the entry as startable-only.
    inventoryReports: [
      { entries: [startable], diagnostics: [] },
      { entries: [startable], diagnostics: [] },
    ],
  });

  await assert.rejects(
    () => prepareTestSession({}, harness.dependencies),
    (error: unknown) => {
      assert.equal(error instanceof DevicePreparationError, true);
      assert.equal(
        (error as DevicePreparationError).message,
        'The selected device did not become runnable after startup.',
      );
      return true;
    },
  );
  assert.equal(harness.getCleanupCalls(), 1);
});

test('prepareTestSession reports the platform-scoped message when nothing is usable', async () => {
  const harness = createPrepareDeps({
    inventoryReports: [{ entries: [], diagnostics: [] }],
  });

  await assert.rejects(
    () => prepareTestSession({ platform: 'iOS' }, harness.dependencies),
    (error: unknown) => {
      assert.equal(error instanceof DevicePreparationError, true);
      assert.equal(
        (error as DevicePreparationError).message,
        'No runnable ios devices or startable targets were found.',
      );
      return true;
    },
  );
  assert.equal(harness.getCleanupCalls(), 1);
});
