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
    let inventory = await deviceNode.detectInventory(adbPath);
    let scopedEntries = filterInventoryEntries(inventory.entries, config.platform);
    let scopedDiagnostics = filterInventoryDiagnostics(inventory.diagnostics, config.platform);
    const selectableEntries = getSelectableEntries(scopedEntries);
    if (selectableEntries.length === 1) {
      Logger.i(buildAutoSelectionSummary(scopedEntries, selectableEntries[0]!));
    } else if (selectableEntries.length === 0) {
      printInventorySummary({
        heading: 'Detected local targets',
        entries: scopedEntries,
        selectableEntries,
        output: selectionIO.output,
      });
    }

    let selectedEntry = await chooseInventoryEntry({
      entries: scopedEntries,
      diagnostics: scopedDiagnostics,
      requestedPlatform: config.platform,
      selectionIO,
    });

    if (selectedEntry.startable) {
      Logger.i(`Starting device: ${selectedEntry.displayName}`);
      Logger.i('Waiting for the selected device to become ready...');
      const startupDiagnostic = await deviceNode.startTarget(selectedEntry, adbPath);
      if (startupDiagnostic) {
        printDiagnosticsFailure({
          heading: 'Device startup failed',
          diagnostics: [startupDiagnostic],
          output: selectionIO.output,
        });
        throw new DevicePreparationError(startupDiagnostic.summary, [startupDiagnostic]);
      }

      inventory = await deviceNode.detectInventory(adbPath);
      scopedEntries = filterInventoryEntries(inventory.entries, config.platform);
      scopedDiagnostics = filterInventoryDiagnostics(inventory.diagnostics, config.platform);
      const startedEntry = scopedEntries.find(
        (entry) => entry.selectionId === selectedEntry.selectionId && entry.runnable,
      ) ?? null;

      if (!startedEntry?.deviceInfo) {
        if (scopedDiagnostics.length > 0) {
          printDiagnosticsFailure({
            heading: 'Device startup failed',
            diagnostics: scopedDiagnostics,
            output: selectionIO.output,
          });
        }
        throw new DevicePreparationError(
          'The selected device did not become runnable after startup.',
          scopedDiagnostics,
        );
      }

      selectedEntry = startedEntry;
    }

    if (!selectedEntry?.deviceInfo) {
      throw new DevicePreparationError('No runnable device is available for this run.');
    }

    const deviceInfo = selectedEntry.deviceInfo;
    const platform = deviceInfo.isAndroid ? PLATFORM_ANDROID : 'ios';
    Logger.i(`Using device: ${selectedEntry.displayName}`);

    Logger.i('Setting up device...');
    const device = await deviceNode.setUpDevice(deviceInfo);
    Logger.i('Driver connected.');

    if (config.appOverridePath) {
      Logger.i(`Installing app override: ${config.appOverridePath}`);
      if (platform === PLATFORM_ANDROID) {
        if (!deviceInfo.id) {
          throw new Error('Android device serial is required to install an app override.');
        }
        const installed = await deviceNode.installAndroidApp(
          adbPath!,
          deviceInfo.id,
          config.appOverridePath,
        );
        if (!installed) {
          throw new Error(
            `Failed to install Android app override after driver connection: ${config.appOverridePath}`,
          );
        }
      } else {
        if (!deviceInfo.id) {
          throw new Error('iOS simulator ID is required to install an app override.');
        }
        const installed = await deviceNode.installIOSApp(
          deviceInfo.id,
          config.appOverridePath,
        );
        if (!installed) {
          throw new Error(
            `Failed to install iOS app override after driver connection: ${config.appOverridePath}`,
          );
        }
      }
    }

    let launchSummary: string | undefined;
    if (config.app) {
      launchSummary = await ensureAppReady(device, config.app);
    }

    return {
      deviceNode,
      device,
      deviceInfo,
      platform,
      app: config.app,
      launchSummary,
      cleanup,
    };
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      Logger.w('Failed to clean up device resources after setup failure:', cleanupError);
    }
    throw error;
  }
}

export async function executeTestOnSession(
  session: TestSession,
  config: TestSessionConfig,
  dependencies: TestSessionDeps = testSessionDeps,
): Promise<TestExecutionResult> {
  const renderer = dependencies.createRenderer();
  let abortListener: (() => void) | undefined;
  let activeRecording:
    | {
        runId: string;
        testId: string;
        startedAt: string;
        keepPartialOnFailure: boolean;
      }
    | undefined;
  let activeLogCapture:
    | {
        runId: string;
        testId: string;
        startedAt: string;
        keepPartialOnFailure: boolean;
      }
    | undefined;

  try {
    const aiAgent = dependencies.createAiAgent({
      apiKeys: config.apiKeys,
      defaults: config.defaults,
      features: config.features,
    });

    const executor = dependencies.createExecutor({
      goal: config.goal,
      platform: session.platform,
      maxIterations: config.maxIterations,
      agent: session.device,
      aiAgent,
      preContext: session.launchSummary,
      appIdentifier: session.app?.identifier,
      runtimeBindings: config.runtimeBindings,
    });
    if (config.abortSignal?.aborted) {
      const abortedResult = createAbortedTestResult(session.platform);
      renderer.printSummary(abortedResult);
      return abortedResult;
    }
    if (config.abortSignal) {
      abortListener = () => {
        executor.abort();
      };
      config.abortSignal.addEventListener('abort', abortListener);
    }

    const recordingRequired =
      config.recording !== undefined && session.platform === PLATFORM_ANDROID;

    if (config.recording) {
      const recordingResponse = await session.device.startRecording(
        new RecordingRequest({
          runId: config.recording.runId,
          testId: config.recording.testId,
          apiKey: config.apiKeys[config.defaults.provider] ?? '',
          outputFilePath: config.recording.outputFilePath,
        }),
      );

      if (recordingResponse.success) {
        activeRecording = {
          runId: config.recording.runId,
          testId: config.recording.testId,
          startedAt:
            typeof recordingResponse.data?.['startedAt'] === 'string'
              ? (recordingResponse.data['startedAt'] as string)
              : new Date().toISOString(),
          keepPartialOnFailure: config.recording.keepPartialOnFailure ?? false,
        };
        Logger.i(
          `Recording started for test ${config.recording.testId} at ${activeRecording.startedAt}`,
        );
      } else {
        const message =
          `Unable to start recording for test ${config.recording.testId}: ` +
          `${recordingResponse.message ?? 'unknown recording error'}`;
        if (recordingRequired) {
          Logger.e(message);
          const failureResult = createRecordingFailureResult({
            platform: session.platform,
            message: `Recording is required for Android runs. ${message}`,
          });
          renderer.printSummary(failureResult);
          return failureResult;
        }
        Logger.w(message);
      }
    }

    if (config.deviceLog) {
      try {
        const logResponse = await session.device.startLogCapture({
          runId: config.deviceLog.runId,
          testId: config.deviceLog.testId,
          appIdentifier: session.app?.identifier,
        });

        if (logResponse.success) {
          activeLogCapture = {
            runId: config.deviceLog.runId,
            testId: config.deviceLog.testId,
            startedAt:
              typeof logResponse.data?.['startedAt'] === 'string'
                ? (logResponse.data['startedAt'] as string)
                : new Date().toISOString(),
            keepPartialOnFailure: config.deviceLog.keepPartialOnFailure ?? false,
          };
          Logger.i(
            `Log capture started for test ${config.deviceLog.testId} at ${activeLogCapture.startedAt}`,
          );
        } else {
          Logger.w(
            `Unable to start log capture for test ${config.deviceLog.testId}: ` +
            `${logResponse.message ?? 'unknown log capture error'}`,
          );
        }
      } catch (error) {
        Logger.w('Failed to start device log capture:', error);
      }
    }

    // Execute!
    let result = await executor.executeGoal((event) => renderer.onProgress(event));

    let recording: TestRecordingResult | undefined;
    if (activeRecording) {
      const stopResponse = await session.device.stopRecording(
        activeRecording.runId,
        activeRecording.testId,
      );
      if (stopResponse.success) {
        const filePath = stopResponse.data?.['filePath'];
        if (typeof filePath === 'string') {
          recording = {
            filePath,
            startedAt:
              typeof stopResponse.data?.['startedAt'] === 'string'
                ? (stopResponse.data['startedAt'] as string)
                : activeRecording.startedAt,
            completedAt:
              typeof stopResponse.data?.['completedAt'] === 'string'
                ? (stopResponse.data['completedAt'] as string)
                : new Date().toISOString(),
          };
        } else if (recordingRequired) {
          const message =
            `Recording is required for Android runs. ` +
            `Recording stopped for test ${activeRecording.testId} but no file path was returned.`;
          Logger.e(message);
          result = markGoalResultFailed(result, message);
        } else {
          Logger.w(
            `Recording stopped for test ${activeRecording.testId} but no file path was returned.`,
          );
        }
      } else {
        const message =
          `Unable to stop recording for test ${activeRecording.testId}: ` +
          `${stopResponse.message ?? 'unknown recording error'}`;
        try {
          await session.device.abortRecording(
            activeRecording.runId,
            activeRecording.keepPartialOnFailure,
          );
        } catch (error) {
          Logger.w('Failed to finalize recording after stop failure:', error);
        }
        if (recordingRequired) {
          Logger.e(message);
          result = markGoalResultFailed(
            result,
            `Recording is required for Android runs. ${message}`,
          );
        } else {
          Logger.w(message);
        }
      }
      activeRecording = undefined;
    }

    let deviceLog: DeviceLogCaptureResult | undefined;
    if (activeLogCapture) {
      try {
        deviceLog = await stopActiveLogCapture(session.device, activeLogCapture);
        activeLogCapture = undefined;
      } catch (error) {
        Logger.w('Failed to stop device log capture:', error);
        // Do NOT clear activeLogCapture here — let the finally block abort it
      }
    }

    const finalResult = recording
      ? { ...result, recording, ...(deviceLog ? { deviceLog } : {}) }
      : deviceLog
        ? { ...result, deviceLog }
        : result;
    // Print summary
    renderer.printSummary(finalResult);

    return finalResult;
  } finally {
    if (abortListener && config.abortSignal) {
      config.abortSignal.removeEventListener('abort', abortListener);
    }
    if (activeRecording) {
      try {
        await session.device.abortRecording(
          activeRecording.runId,
          activeRecording.keepPartialOnFailure,
        );
      } catch (error) {
        Logger.w('Failed to abort active recording during cleanup:', error);
      }
    }
    if (activeLogCapture) {
      try {
        await session.device.abortLogCapture(
          activeLogCapture.runId,
          activeLogCapture.keepPartialOnFailure,
        );
      } catch (error) {
        Logger.w('Failed to abort active log capture during cleanup:', error);
      }
    }
    renderer.destroy();
  }
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
  capture: {
    runId: string;
    testId: string;
    startedAt: string;
    keepPartialOnFailure: boolean;
  },
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

  const filePath = stopLogResponse.data?.['filePath'];
  if (typeof filePath !== 'string') {
    Logger.w(
      `Log capture stopped for test ${capture.testId} but no file path was returned.`,
    );
    return undefined;
  }

  return {
    filePath,
    startedAt:
      typeof stopLogResponse.data?.['startedAt'] === 'string'
        ? (stopLogResponse.data['startedAt'] as string)
        : capture.startedAt,
    completedAt:
      typeof stopLogResponse.data?.['completedAt'] === 'string'
        ? (stopLogResponse.data['completedAt'] as string)
        : new Date().toISOString(),
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
