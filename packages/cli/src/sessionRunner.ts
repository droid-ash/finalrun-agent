// Orchestrates: detect device -> set up -> execute test.

import {
  AppUpload,
  DeviceActionRequest,
  DeviceInfo,
  GetAppListAction,
  LaunchAppAction,
  Logger,
  PLATFORM_ANDROID,
  RecordingRequest,
  type DeviceInventoryDiagnostic,
  type DeviceInventoryEntry,
  type FeatureOverrides,
  type ModelDefaults,
  type RuntimeBindings,
} from '@finalrun/common';
import { DeviceNode } from '@finalrun/device-node';
import {
  TestExecutor,
  AIAgent,
  type TestRecordingResult,
} from '@finalrun/goal-executor';
import type { TestExecutionResult } from '@finalrun/goal-executor';
import type { DeviceLogCaptureResult } from '@finalrun/common';
import type { ResolvedAppConfig } from '@finalrun/common';
import { CliFilePathUtil } from '@finalrun/device-node';
import {
  type DeviceSelectionIO,
  printInventorySummary,
  printDiagnosticsFailure,
  promptForDeviceSelection,
} from './deviceInventoryPresenter.js';
import { TerminalRenderer } from './terminalRenderer.js';

type GoalRunnerDeviceNode = Pick<
  DeviceNode,
  | 'init'
  | 'detectInventory'
  | 'startTarget'
  | 'setUpDevice'
  | 'cleanup'
  | 'installAndroidApp'
  | 'installIOSApp'
>;

type GoalRunnerDevice = Awaited<ReturnType<DeviceNode['setUpDevice']>>;

type GoalRunnerRenderer = Pick<
  TerminalRenderer,
  'onProgress' | 'printSummary' | 'destroy'
>;

type GoalRunnerExecutor = Pick<
  TestExecutor,
  'abort' | 'executeGoal'
>;

export interface TestSessionConfig {
  goal: string;
  apiKeys: Record<string, string>;
  defaults: ModelDefaults;
  features?: FeatureOverrides;
  maxIterations?: number;
  debug?: boolean;
  platform?: string;
  appOverridePath?: string;
  app?: ResolvedAppConfig;
  runtimeBindings?: RuntimeBindings;
  abortSignal?: AbortSignal;
  recording?: {
    runId: string;
    testId: string;
    outputFilePath?: string;
    keepPartialOnFailure?: boolean;
  };
  deviceLog?: {
    runId: string;
    testId: string;
    keepPartialOnFailure?: boolean;
  };
}

export interface GoalSessionConfig {
  platform?: string;
  appOverridePath?: string;
  app?: ResolvedAppConfig;
}

export interface TestSessionDeps {
  createFilePathUtil(): CliFilePathUtil;
  getDeviceNode(): GoalRunnerDeviceNode;
  createSelectionIO(): DeviceSelectionIO;
  createAiAgent(params: ConstructorParameters<typeof AIAgent>[0]): AIAgent;
  createExecutor(
    params: ConstructorParameters<typeof TestExecutor>[0],
  ): GoalRunnerExecutor;
  createRenderer(): GoalRunnerRenderer;
}

export interface TestSession {
  deviceNode: GoalRunnerDeviceNode;
  device: GoalRunnerDevice;
  deviceInfo: DeviceInfo;
  platform: string;
  app?: ResolvedAppConfig;
  launchSummary?: string;
  cleanup(): Promise<void>;
}

export class DevicePreparationError extends Error {
  readonly diagnostics: DeviceInventoryDiagnostic[];

  constructor(message: string, diagnostics: DeviceInventoryDiagnostic[] = []) {
    super(message);
    this.name = 'DevicePreparationError';
    this.diagnostics = diagnostics;
  }
}

export function isDevicePreparationError(error: unknown): error is DevicePreparationError {
  return error instanceof DevicePreparationError;
}

export const testSessionDeps: TestSessionDeps = {
  createFilePathUtil: () => new CliFilePathUtil(undefined, undefined, { downloadAssets: true }),
  getDeviceNode: () => DeviceNode.getInstance(),
  createSelectionIO: () => ({
    input: process.stdin,
    output: process.stdout,
    isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
  }),
  createAiAgent: (params) => new AIAgent(params),
  createExecutor: (params) => new TestExecutor(params),
  createRenderer: () => new TerminalRenderer(),
};

type AdbPath = Awaited<ReturnType<CliFilePathUtil['getADBPath']>>;

export async function prepareTestSession(
  config: GoalSessionConfig,
  dependencies: TestSessionDeps = testSessionDeps,
): Promise<TestSession> {
  const filePathUtil = dependencies.createFilePathUtil();
  Logger.i('Detecting local devices...');
  const adbPath = await filePathUtil.getADBPath();
  const deviceNode = dependencies.getDeviceNode();
  const selectionIO = dependencies.createSelectionIO();
  deviceNode.init(filePathUtil);
  let cleanedUp = false;

  const cleanup = async (): Promise<void> => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    await deviceNode.cleanup();
  };

  try {
    let selectedEntry = await detectAndChooseEntry({
      deviceNode,
      adbPath,
      requestedPlatform: config.platform,
      selectionIO,
    });

    if (selectedEntry.startable) {
      selectedEntry = await startEntryAndReselect({
        deviceNode,
        adbPath,
        requestedPlatform: config.platform,
        selectionIO,
        selectedEntry,
      });
    }

    return await establishDeviceSession({ deviceNode, adbPath, config, selectedEntry, cleanup });
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      Logger.w('Failed to clean up device resources after setup failure:', cleanupError);
    }
    throw error;
  }
}

/** Connects the driver to the chosen entry, applies overrides, and builds the session. */
async function establishDeviceSession(params: {
  deviceNode: GoalRunnerDeviceNode;
  adbPath: AdbPath;
  config: GoalSessionConfig;
  selectedEntry: DeviceInventoryEntry;
  cleanup: () => Promise<void>;
}): Promise<TestSession> {
  if (!params.selectedEntry?.deviceInfo) {
    throw new DevicePreparationError('No runnable device is available for this run.');
  }

  const deviceInfo = params.selectedEntry.deviceInfo;
  const platform = deviceInfo.getPlatform();
  Logger.i(`Using device: ${params.selectedEntry.displayName}`);

  Logger.i('Setting up device...');
  const device = await params.deviceNode.setUpDevice(deviceInfo);
  Logger.i('Driver connected.');

  if (params.config.appOverridePath) {
    await installAppOverride({
      deviceNode: params.deviceNode,
      adbPath: params.adbPath,
      deviceInfo,
      platform,
      appOverridePath: params.config.appOverridePath,
    });
  }

  let launchSummary: string | undefined;
  if (params.config.app) {
    launchSummary = await ensureAppReady(device, params.config.app);
  }

  return {
    deviceNode: params.deviceNode,
    device,
    deviceInfo,
    platform,
    app: params.config.app,
    launchSummary,
    cleanup: params.cleanup,
  };
}

/** Detects local targets, prints the inventory context, and picks an entry. */
async function detectAndChooseEntry(params: {
  deviceNode: GoalRunnerDeviceNode;
  adbPath: AdbPath;
  requestedPlatform?: string;
  selectionIO: DeviceSelectionIO;
}): Promise<DeviceInventoryEntry> {
  const inventory = await params.deviceNode.detectInventory(params.adbPath);
  const scopedEntries = filterInventoryEntries(inventory.entries, params.requestedPlatform);
  const scopedDiagnostics = filterInventoryDiagnostics(
    inventory.diagnostics,
    params.requestedPlatform,
  );
  const selectableEntries = getSelectableEntries(scopedEntries);
  if (selectableEntries.length === 1) {
    Logger.i(buildAutoSelectionSummary(scopedEntries, selectableEntries[0]!));
  } else if (selectableEntries.length === 0) {
    printInventorySummary({
      heading: 'Detected local targets',
      entries: scopedEntries,
      selectableEntries,
      output: params.selectionIO.output,
    });
  }

  return await chooseInventoryEntry({
    entries: scopedEntries,
    diagnostics: scopedDiagnostics,
    requestedPlatform: params.requestedPlatform,
    selectionIO: params.selectionIO,
  });
}

/** Starts a startable entry, re-detects, and returns the now-runnable entry. */
async function startEntryAndReselect(params: {
  deviceNode: GoalRunnerDeviceNode;
  adbPath: AdbPath;
  requestedPlatform?: string;
  selectionIO: DeviceSelectionIO;
  selectedEntry: DeviceInventoryEntry;
}): Promise<DeviceInventoryEntry> {
  Logger.i(`Starting device: ${params.selectedEntry.displayName}`);
  Logger.i('Waiting for the selected device to become ready...');
  const startupDiagnostic = await params.deviceNode.startTarget(
    params.selectedEntry,
    params.adbPath,
  );
  if (startupDiagnostic) {
    printDiagnosticsFailure({
      heading: 'Device startup failed',
      diagnostics: [startupDiagnostic],
      output: params.selectionIO.output,
    });
    throw new DevicePreparationError(startupDiagnostic.summary, [startupDiagnostic]);
  }

  const inventory = await params.deviceNode.detectInventory(params.adbPath);
  const scopedEntries = filterInventoryEntries(inventory.entries, params.requestedPlatform);
  const scopedDiagnostics = filterInventoryDiagnostics(
    inventory.diagnostics,
    params.requestedPlatform,
  );
  const startedEntry = scopedEntries.find(
    (entry) => entry.selectionId === params.selectedEntry.selectionId && entry.runnable,
  ) ?? null;

  if (!startedEntry?.deviceInfo) {
    if (scopedDiagnostics.length > 0) {
      printDiagnosticsFailure({
        heading: 'Device startup failed',
        diagnostics: scopedDiagnostics,
        output: params.selectionIO.output,
      });
    }
    throw new DevicePreparationError(
      'The selected device did not become runnable after startup.',
      scopedDiagnostics,
    );
  }

  return startedEntry;
}

/** Installs the --app override onto the connected device, per platform. */
async function installAppOverride(params: {
  deviceNode: GoalRunnerDeviceNode;
  adbPath: AdbPath;
  deviceInfo: DeviceInfo;
  platform: string;
  appOverridePath: string;
}): Promise<void> {
  Logger.i(`Installing app override: ${params.appOverridePath}`);
  if (params.platform === PLATFORM_ANDROID) {
    if (!params.deviceInfo.id) {
      throw new Error('Android device serial is required to install an app override.');
    }
    if (!params.adbPath) {
      throw new Error('adb path is required to install an Android app override.');
    }
    const installed = await params.deviceNode.installAndroidApp(
      params.adbPath,
      params.deviceInfo.id,
      params.appOverridePath,
    );
    if (!installed) {
      throw new Error(
        `Failed to install Android app override after driver connection: ${params.appOverridePath}`,
      );
    }
  } else {
    if (!params.deviceInfo.id) {
      throw new Error('iOS simulator ID is required to install an app override.');
    }
    const installed = await params.deviceNode.installIOSApp(
      params.deviceInfo.id,
      params.appOverridePath,
    );
    if (!installed) {
      throw new Error(
        `Failed to install iOS app override after driver connection: ${params.appOverridePath}`,
      );
    }
  }
}

/** A started recording or log capture that still needs to be stopped or aborted. */
interface ActiveCapture {
  runId: string;
  testId: string;
  startedAt: string;
  keepPartialOnFailure: boolean;
}

/**
 * Per-call state accumulated across executeTestOnSession's phases. Each phase
 * records what it acquired here, and the orchestrator's `finally` releases
 * whatever is still held on any exit path.
 */
interface ExecutionSessionState {
  abortListener?: () => void;
  activeRecording?: ActiveCapture;
  activeLogCapture?: ActiveCapture;
}

export async function executeTestOnSession(
  session: TestSession,
  config: TestSessionConfig,
  dependencies: TestSessionDeps = testSessionDeps,
): Promise<TestExecutionResult> {
  const renderer = dependencies.createRenderer();
  const state: ExecutionSessionState = {};

  try {
    const executor = createSessionExecutor(session, config, dependencies);
    if (config.abortSignal?.aborted) {
      const abortedResult = createAbortedTestResult(session.platform);
      renderer.printSummary(abortedResult);
      return abortedResult;
    }
    wireAbortSignal(config, executor, state);

    const recordingRequired =
      config.recording !== undefined && session.platform === PLATFORM_ANDROID;

    if (config.recording) {
      const outcome =
        await startRecordingPhase(session, config, config.recording, recordingRequired, state);
      if (outcome.failureResult) {
        renderer.printSummary(outcome.failureResult);
        return outcome.failureResult;
      }
    }

    if (config.deviceLog) {
      await startLogCapturePhase(session, config.deviceLog, state);
    }

    let result = await executor.executeGoal((event) => renderer.onProgress(event));

    let recording: TestRecordingResult | undefined;
    if (state.activeRecording) {
      const stopOutcome = await stopRecordingPhase(
        session.device,
        state.activeRecording,
        recordingRequired,
      );
      recording = stopOutcome.recording;
      if (stopOutcome.failureMessage) {
        result = markGoalResultFailed(result, stopOutcome.failureMessage);
      }
      state.activeRecording = undefined;
    }

    let deviceLog: DeviceLogCaptureResult | undefined;
    if (state.activeLogCapture) {
      try {
        deviceLog = await stopActiveLogCapture(session.device, state.activeLogCapture);
        state.activeLogCapture = undefined;
      } catch (error) {
        Logger.w('Failed to stop device log capture:', error);
        // Do NOT clear activeLogCapture here — let the finally block abort it
      }
    }

    const finalResult = composeFinalResult(result, recording, deviceLog);
    renderer.printSummary(finalResult);

    return finalResult;
  } finally {
    await releaseSessionResources(session, config, state, renderer);
  }
}

/** Builds the AI agent and goal executor for this session run. */
function createSessionExecutor(
  session: TestSession,
  config: TestSessionConfig,
  dependencies: TestSessionDeps,
): GoalRunnerExecutor {
  const aiAgent = dependencies.createAiAgent({
    apiKeys: config.apiKeys,
    defaults: config.defaults,
    features: config.features,
  });

  return dependencies.createExecutor({
    goal: config.goal,
    platform: session.platform,
    maxIterations: config.maxIterations,
    agent: session.device,
    aiAgent,
    preContext: session.launchSummary,
    appIdentifier: session.app?.identifier,
    runtimeBindings: config.runtimeBindings,
  });
}

/** Forwards an external abort signal to the executor, tracked for removal. */
function wireAbortSignal(
  config: TestSessionConfig,
  executor: GoalRunnerExecutor,
  state: ExecutionSessionState,
): void {
  if (!config.abortSignal) {
    return;
  }
  state.abortListener = () => {
    executor.abort();
  };
  config.abortSignal.addEventListener('abort', state.abortListener);
}

/** Reads a string field from a driver response's data payload. */
function readDataString(
  data: Record<string, unknown> | null | undefined,
  key: string,
): string | undefined {
  const value = data?.[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Starts the screen recording. On success the acquired capture is recorded in
 * `state.activeRecording` BEFORE the "started" log line, so a throwing logger
 * sink can never orphan a started recording (the orchestrator's `finally`
 * still sees it). On a start failure, returns a failure result when recording
 * is required and nothing at all (a warning only) when it is optional.
 */
async function startRecordingPhase(
  session: TestSession,
  config: TestSessionConfig,
  recording: NonNullable<TestSessionConfig['recording']>,
  recordingRequired: boolean,
  state: ExecutionSessionState,
): Promise<{ failureResult?: TestExecutionResult }> {
  const recordingResponse = await session.device.startRecording(
    new RecordingRequest({
      runId: recording.runId,
      testId: recording.testId,
      apiKey: config.apiKeys[config.defaults.provider] ?? '',
      outputFilePath: recording.outputFilePath,
    }),
  );

  if (recordingResponse.success) {
    state.activeRecording = {
      runId: recording.runId,
      testId: recording.testId,
      startedAt: readDataString(recordingResponse.data, 'startedAt') ?? new Date().toISOString(),
      keepPartialOnFailure: recording.keepPartialOnFailure ?? false,
    };
    Logger.i(`Recording started for test ${recording.testId} at ${state.activeRecording.startedAt}`);
    return {};
  }

  const message =
    `Unable to start recording for test ${recording.testId}: ` +
    `${recordingResponse.message ?? 'unknown recording error'}`;
  if (recordingRequired) {
    Logger.e(message);
    return {
      failureResult: createRecordingFailureResult({
        platform: session.platform,
        message: `Recording is required for Android runs. ${message}`,
      }),
    };
  }
  Logger.w(message);
  return {};
}

/**
 * Starts the device log capture; a start failure only warns. On success the
 * acquired capture is recorded in `state.activeLogCapture` BEFORE the
 * "started" log line, so a logger sink throwing on that line (swallowed by
 * this helper's own catch, as on the pre-refactor source) still leaves the
 * capture tracked for the normal stop path.
 */
async function startLogCapturePhase(
  session: TestSession,
  deviceLog: NonNullable<TestSessionConfig['deviceLog']>,
  state: ExecutionSessionState,
): Promise<void> {
  try {
    const logResponse = await session.device.startLogCapture({
      runId: deviceLog.runId,
      testId: deviceLog.testId,
      appIdentifier: session.app?.identifier,
    });

    if (logResponse.success) {
      state.activeLogCapture = {
        runId: deviceLog.runId,
        testId: deviceLog.testId,
        startedAt: readDataString(logResponse.data, 'startedAt') ?? new Date().toISOString(),
        keepPartialOnFailure: deviceLog.keepPartialOnFailure ?? false,
      };
      Logger.i(
        `Log capture started for test ${deviceLog.testId} at ${state.activeLogCapture.startedAt}`,
      );
      return;
    }
    Logger.w(
      `Unable to start log capture for test ${deviceLog.testId}: ` +
      `${logResponse.message ?? 'unknown log capture error'}`,
    );
  } catch (error) {
    Logger.w('Failed to start device log capture:', error);
  }
}

/**
 * Stops the active recording. Returns the recording record when a file was
 * produced; when recording is required and no file materialized, returns the
 * failure message to mark the goal result with.
 */
async function stopRecordingPhase(
  device: TestSession['device'],
  capture: ActiveCapture,
  recordingRequired: boolean,
): Promise<{ recording?: TestRecordingResult; failureMessage?: string }> {
  const stopResponse = await device.stopRecording(capture.runId, capture.testId);
  if (stopResponse.success) {
    const filePath = readDataString(stopResponse.data, 'filePath');
    if (filePath !== undefined) {
      return {
        recording: {
          filePath,
          startedAt: readDataString(stopResponse.data, 'startedAt') ?? capture.startedAt,
          completedAt:
            readDataString(stopResponse.data, 'completedAt') ?? new Date().toISOString(),
        },
      };
    }
    if (recordingRequired) {
      const message =
        `Recording is required for Android runs. ` +
        `Recording stopped for test ${capture.testId} but no file path was returned.`;
      Logger.e(message);
      return { failureMessage: message };
    }
    Logger.w(`Recording stopped for test ${capture.testId} but no file path was returned.`);
    return {};
  }

  const message =
    `Unable to stop recording for test ${capture.testId}: ` +
    `${stopResponse.message ?? 'unknown recording error'}`;
  try {
    await device.abortRecording(capture.runId, capture.keepPartialOnFailure);
  } catch (error) {
    Logger.w('Failed to finalize recording after stop failure:', error);
  }
  if (recordingRequired) {
    Logger.e(message);
    return { failureMessage: `Recording is required for Android runs. ${message}` };
  }
  Logger.w(message);
  return {};
}

/** Merges recording and device-log records onto the result only when present. */
function composeFinalResult(
  result: TestExecutionResult,
  recording: TestRecordingResult | undefined,
  deviceLog: DeviceLogCaptureResult | undefined,
): TestExecutionResult {
  return recording
    ? { ...result, recording, ...(deviceLog ? { deviceLog } : {}) }
    : deviceLog
      ? { ...result, deviceLog }
      : result;
}

/** Releases everything still held in the per-call state, on every exit path. */
async function releaseSessionResources(
  session: TestSession,
  config: TestSessionConfig,
  state: ExecutionSessionState,
  renderer: GoalRunnerRenderer,
): Promise<void> {
  if (state.abortListener && config.abortSignal) {
    config.abortSignal.removeEventListener('abort', state.abortListener);
  }
  if (state.activeRecording) {
    try {
      await session.device.abortRecording(
        state.activeRecording.runId,
        state.activeRecording.keepPartialOnFailure,
      );
    } catch (error) {
      Logger.w('Failed to abort active recording during cleanup:', error);
    }
  }
  if (state.activeLogCapture) {
    try {
      await session.device.abortLogCapture(
        state.activeLogCapture.runId,
        state.activeLogCapture.keepPartialOnFailure,
      );
    } catch (error) {
      Logger.w('Failed to abort active log capture during cleanup:', error);
    }
  }
  renderer.destroy();
}

/**
 * Stops an active device log capture and builds its result record.
 *
 * On stop failure the capture is aborted (best-effort) and `undefined` is
 * returned. Errors thrown by `stopLogCapture` propagate to the caller, which
 * leaves the capture active so the enclosing `finally` block can abort it.
 */
async function stopActiveLogCapture(
  device: TestSession['device'],
  capture: ActiveCapture,
): Promise<DeviceLogCaptureResult | undefined> {
  const stopLogResponse = await device.stopLogCapture(capture.runId, capture.testId);
  if (!stopLogResponse.success) {
    Logger.w(
      `Unable to stop log capture for test ${capture.testId}: ` +
      `${stopLogResponse.message ?? 'unknown log capture error'}`,
    );
    try {
      await device.abortLogCapture(capture.runId, capture.keepPartialOnFailure);
    } catch (error) {
      Logger.w('Failed to finalize log capture after stop failure:', error);
    }
    return undefined;
  }

  const filePath = readDataString(stopLogResponse.data, 'filePath');
  if (filePath === undefined) {
    Logger.w(
      `Log capture stopped for test ${capture.testId} but no file path was returned.`,
    );
    return undefined;
  }

  return {
    filePath,
    startedAt: readDataString(stopLogResponse.data, 'startedAt') ?? capture.startedAt,
    completedAt: readDataString(stopLogResponse.data, 'completedAt') ?? new Date().toISOString(),
  };
}

/**
 * Top-level orchestrator for running a goal from the CLI.
 *
 */
export async function runGoal(
  config: TestSessionConfig,
  dependencies: TestSessionDeps = testSessionDeps,
): Promise<TestExecutionResult> {
  printRunBanner(config);
  const session = await prepareTestSession(
    {
      platform: config.platform,
      appOverridePath: config.appOverridePath,
      app: config.app,
    },
    dependencies,
  );

  try {
    return await executeTestOnSession(session, config, dependencies);
  } finally {
    try {
      await session.cleanup();
    } catch (error) {
      Logger.w('Failed to clean up device resources:', error);
    }
  }
}

async function ensureAppReady(
  device: GoalRunnerDevice,
  app: ResolvedAppConfig,
): Promise<string> {
  const appListResponse = await device.executeAction(
    new DeviceActionRequest({
      requestId: `prelaunch-app-list-${app.platform}`,
      action: new GetAppListAction(),
      timeout: 10,
    }),
  );
  if (!appListResponse.success) {
    throw new Error(
      `Failed to inspect installed apps before launching ${formatAppReference(app)}: ${appListResponse.message ?? 'unknown app list error'}`,
    );
  }

  const installedApps =
    ((appListResponse.data?.['apps'] as Array<{ packageName: string; name: string }>) ?? []);
  const isInstalled = installedApps.some((installedApp) => installedApp.packageName === app.identifier);
  if (!isInstalled) {
    throw new Error(
      `${formatAppReference(app)} is not installed on the selected device. Pass --app <path> to install it or install it manually before running FinalRun.`,
    );
  }

  Logger.i(`Prelaunching ${formatAppReference(app)}...`);
  const launchResponse = await device.executeAction(
    new DeviceActionRequest({
      requestId: `prelaunch-launch-${app.platform}`,
      action: new LaunchAppAction({
        appUpload: new AppUpload({
          id: '',
          platform: app.platform,
          packageName: app.identifier,
        }),
        allowAllPermissions: true,
        shouldUninstallBeforeLaunch: false,
        clearState: false,
        stopAppBeforeLaunch: false,
      }),
      timeout: 30,
    }),
  );
  if (!launchResponse.success) {
    throw new Error(
      `Failed to launch ${formatAppReference(app)} before execution: ${launchResponse.message ?? 'unknown launch error'}`,
    );
  }

  return [
    `The CLI already launched ${formatAppReference(app)} before the goal started.`,
    launchResponse.message ? `Driver response: ${launchResponse.message}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join(' ');
}

function formatAppReference(app: ResolvedAppConfig): string {
  return app.platform === PLATFORM_ANDROID
    ? `Android package "${app.identifier}"`
    : `iOS bundle ID "${app.identifier}"`;
}

function createRecordingFailureResult(params: {
  platform: string;
  message: string;
}): TestExecutionResult {
  const timestamp = new Date().toISOString();
  return {
    success: false,
    status: 'failure',
    message: params.message,
    platform: params.platform,
    startedAt: timestamp,
    completedAt: timestamp,
    steps: [],
    totalIterations: 0,
  };
}

function createAbortedTestResult(platform: string): TestExecutionResult {
  const timestamp = new Date().toISOString();
  return {
    success: false,
    status: 'aborted',
    message: 'Goal execution was aborted',
    platform,
    startedAt: timestamp,
    completedAt: timestamp,
    steps: [],
    totalIterations: 0,
  };
}

function markGoalResultFailed(result: TestExecutionResult, message: string): TestExecutionResult {
  return {
    ...result,
    success: false,
    status: result.status === 'aborted' ? 'aborted' : 'failure',
    message: result.success ? message : `${result.message}\n${message}`,
  };
}

function printRunBanner(config: TestSessionConfig): void {
  console.log('\n\x1b[1mFinalRun CLI\x1b[0m');
  console.log('─'.repeat(50));
  console.log(`Goal: ${config.goal}`);
  const defaultReasoning = config.defaults.reasoning ? ` (${config.defaults.reasoning})` : '';
  console.log(`Model: ${config.defaults.provider}/${config.defaults.modelName}${defaultReasoning}`);
  if (config.features) {
    const overrides = Object.entries(config.features)
      .filter(([, override]) => override && (override.model || override.reasoning))
      .map(([feature, override]) => {
        const parts: string[] = [];
        if (override!.model) parts.push(override!.model);
        if (override!.reasoning) parts.push(override!.reasoning);
        return `  ${feature}: ${parts.join(' ')}`;
      });
    if (overrides.length > 0) {
      console.log('Feature overrides:');
      for (const line of overrides) console.log(line);
    }
  }
  console.log('─'.repeat(50) + '\n');
}

async function chooseInventoryEntry(params: {
  entries: DeviceInventoryEntry[];
  diagnostics: DeviceInventoryDiagnostic[];
  requestedPlatform?: string,
  selectionIO: DeviceSelectionIO;
}): Promise<DeviceInventoryEntry> {
  const selectableEntries = getSelectableEntries(params.entries);
  if (selectableEntries.length === 1) {
    return selectableEntries[0]!;
  }

  const runnableEntries = params.entries.filter((entry) => entry.runnable);
  if (runnableEntries.length > 1) {
    return await promptForDeviceSelection({
      heading: 'Select a device',
      entries: params.entries,
      selectableEntries: runnableEntries,
      io: params.selectionIO,
    });
  }

  const startableEntries = params.entries.filter((entry) => entry.startable);
  if (startableEntries.length > 1) {
    return await promptForDeviceSelection({
      heading: 'Select a device to start',
      entries: params.entries,
      selectableEntries: startableEntries,
      io: params.selectionIO,
    });
  }

  if (params.diagnostics.length > 0) {
    printDiagnosticsFailure({
      heading: 'Device discovery failed',
      diagnostics: params.diagnostics,
      output: params.selectionIO.output,
    });
  }

  throw new DevicePreparationError(
    buildNoUsableTargetMessage(params.requestedPlatform),
    params.diagnostics,
  );
}

function getSelectableEntries(entries: DeviceInventoryEntry[]): DeviceInventoryEntry[] {
  const runnableEntries = entries.filter((entry) => entry.runnable);
  if (runnableEntries.length > 0) {
    return runnableEntries;
  }

  return entries.filter((entry) => entry.startable);
}

function filterInventoryEntries(
  entries: DeviceInventoryEntry[],
  requestedPlatform?: string,
): DeviceInventoryEntry[] {
  if (!requestedPlatform) {
    return entries;
  }

  const normalizedPlatform = requestedPlatform.toLowerCase();
  return entries.filter((entry) => entry.platform === normalizedPlatform);
}

function filterInventoryDiagnostics(
  diagnostics: DeviceInventoryDiagnostic[],
  requestedPlatform?: string,
): DeviceInventoryDiagnostic[] {
  if (!requestedPlatform) {
    return diagnostics;
  }

  const normalizedPlatform = requestedPlatform.toLowerCase();
  if (normalizedPlatform === PLATFORM_ANDROID) {
    return diagnostics.filter(
      (diagnostic) =>
        diagnostic.scope === 'android-connected' ||
        diagnostic.scope === 'android-targets' ||
        diagnostic.scope === 'startup',
    );
  }
  if (normalizedPlatform === 'ios') {
    return diagnostics.filter(
      (diagnostic) =>
        diagnostic.scope === 'ios-simulators' ||
        diagnostic.scope === 'startup',
    );
  }
  return diagnostics;
}

function buildNoUsableTargetMessage(requestedPlatform?: string): string {
  if (requestedPlatform) {
    return `No runnable ${requestedPlatform.toLowerCase()} devices or startable targets were found.`;
  }
  return 'No runnable devices or startable targets were found.';
}

function buildAutoSelectionSummary(
  entries: DeviceInventoryEntry[],
  selectedEntry: DeviceInventoryEntry,
): string {
  const totalTargets = entries.length;
  const androidCount = entries.filter((entry) => entry.platform === PLATFORM_ANDROID).length;
  const iosCount = entries.filter((entry) => entry.platform === 'ios').length;
  const platformCounts = [
    androidCount > 0 ? `${androidCount} Android` : null,
    iosCount > 0 ? `${iosCount} iOS` : null,
  ].filter((value): value is string => value !== null);
  const platformSummary =
    platformCounts.length > 0 ? ` (${platformCounts.join(', ')})` : '';
  const targetKind = selectedEntry.runnable ? 'ready target' : 'startable target';

  return (
    `Detected ${totalTargets} target${totalTargets === 1 ? '' : 's'}${platformSummary}; ` +
    `1 ${targetKind}: ${selectedEntry.displayName}`
  );
}
