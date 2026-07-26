import * as path from 'node:path';
import {
  Logger,
  LogLevel,
  type DeviceInfo,
  type DeviceInventoryDiagnostic,
  type FeatureOverrides,
  type LogEntry,
  type ModelDefaults,
  type RuntimeBindings,
  type TestDefinition,
  type TestResult,
} from '@finalrun/common';
import {
  DevicePreparationError,
  executeTestOnSession,
  isDevicePreparationError,
  prepareTestSession,
  type TestSession,
} from './sessionRunner.js';
import {
  formatResolvedAppSummary,
  type ResolvedAppConfig,
} from '@finalrun/common';
import { formatDiagnosticsForOutput } from './deviceInventoryPresenter.js';
import { compileTestObjective } from './testCompiler.js';
import type { ExecutionStatus, TestExecutionResult } from '@finalrun/goal-executor';
import { runCheck, type CheckRunnerOptions, type CheckRunnerResult } from '@finalrun/common';
import { ReportWriter } from './reportWriter.js';
import { rebuildRunIndex } from './runIndex.js';
import {
  formatHostPreflightReport,
  resolveTestRequestedPlatforms,
  runHostPreflight,
  shouldBlockLocalRunPreflight,
} from './hostPreflight.js';
import {
  createRunId,
  resolveWorkspace,
  type FinalRunWorkspace,
} from '@finalrun/common';

export interface TestRunnerOptions extends CheckRunnerOptions {
  apiKeys: Record<string, string>;
  defaults: ModelDefaults;
  features?: FeatureOverrides;
  maxIterations?: number;
  debug?: boolean;
  invokedCommand?: 'test' | 'suite';
}

export interface TestRunnerResult {
  success: boolean;
  status: ExecutionStatus;
  runId: string;
  runDir: string;
  runIndexPath: string;
  testResults: TestResult[];
}

export type PreExecutionFailurePhase = 'validation' | 'setup';

export class PreExecutionFailureError extends Error {
  readonly phase: PreExecutionFailurePhase;
  readonly diagnostics: DeviceInventoryDiagnostic[];
  readonly exitCode: number;

  constructor(params: {
    phase: PreExecutionFailurePhase;
    message: string;
    diagnostics?: DeviceInventoryDiagnostic[];
    exitCode?: number;
  }) {
    super(params.message);
    this.name = 'PreExecutionFailureError';
    this.phase = params.phase;
    this.diagnostics = params.diagnostics ?? [];
    this.exitCode = params.exitCode ?? 1;
  }
}

const CLI_TEST_FORCE_DEVICE_SETUP_FAILURE_ENV_VAR = 'FINALRUN_CLI_TEST_FORCE_DEVICE_SETUP_FAILURE';
const CLI_TEST_SKIP_HOST_PREFLIGHT_ENV_VAR = 'FINALRUN_CLI_TEST_SKIP_HOST_PREFLIGHT';

export const testRunnerDependencies = {
  prepareTestSession: prepareTestSession,
  executeTestOnSession: executeTestOnSession,
  runCheck,
  runHostPreflight,
  resolveWorkspace,
  addSigintListener(listener: () => void): () => void {
    process.on('SIGINT', listener);
    return () => {
      process.removeListener('SIGINT', listener);
    };
  },
  exitProcess(code: number): never {
    process.exit(code);
  },
};

/**
 * Mutable state for one `runTests` invocation. Created as a local per run and
 * passed to the phase helpers — `reportWriter` is created lazily once the
 * first test is about to execute, so `undefined` means no run artifacts exist
 * yet (validation/setup failures must not leave artifacts behind).
 */
interface TestRunContext {
  readonly options: TestRunnerOptions;
  readonly workspace: FinalRunWorkspace;
  readonly startedAt: Date;
  readonly testResults: TestResult[];
  readonly bufferedLogEntries: LogEntry[];
  readonly bufferingSink: (entry: LogEntry) => void;
  readonly runAbortController: AbortController;
  encounteredFailure: boolean;
  reportWriter: ReportWriter | undefined;
  runDir: string;
  logSink: ReturnType<ReportWriter['createLoggerSink']> | undefined;
  runAborted: boolean;
}

export async function runTests(options: TestRunnerOptions): Promise<TestRunnerResult> {
  Logger.init({
    level: options.debug ? LogLevel.DEBUG : LogLevel.INFO,
    resetSinks: true,
  });
  const workspace = await testRunnerDependencies.resolveWorkspace(options.cwd);

  const ctx = createRunContext(options, workspace);
  Logger.addSink(ctx.bufferingSink);
  const removeSigintListener = testRunnerDependencies.addSigintListener(() =>
    requestRunAbort(ctx),
  );

  try {
    const { checked, effectiveGoals } = await runValidationPhase(ctx);
    if (ctx.runAborted) {
      throw abortedBeforeExecutionError();
    }

    const goalSession = await prepareRunSession(ctx, checked);
    try {
      // Inside the try: a session now exists, so an abort that arrived during
      // preparation must still release it via the finally below.
      if (ctx.runAborted) {
        throw abortedBeforeExecutionError();
      }
      await runTestLoop(ctx, checked, effectiveGoals, goalSession);
      return await finalizeRun(ctx);
    } finally {
      await releaseSession(goalSession);
    }
  } finally {
    removeSigintListener();
    if (ctx.logSink) {
      Logger.removeSink(ctx.logSink);
    }
    Logger.removeSink(ctx.bufferingSink);
  }
}

function createRunContext(
  options: TestRunnerOptions,
  workspace: FinalRunWorkspace,
): TestRunContext {
  const bufferedLogEntries: LogEntry[] = [];
  return {
    options,
    workspace,
    startedAt: new Date(),
    testResults: [],
    bufferedLogEntries,
    bufferingSink: (entry: LogEntry) => {
      bufferedLogEntries.push(entry);
    },
    runAbortController: new AbortController(),
    encounteredFailure: false,
    reportWriter: undefined,
    runDir: '',
    logSink: undefined,
    runAborted: false,
  };
}

/** First SIGINT aborts the run; a second one forces exit (code 130). */
function requestRunAbort(ctx: TestRunContext): void {
  if (ctx.runAborted) {
    Logger.e('\nReceived second SIGINT — forcing exit.');
    ctx.reportWriter?.appendLogLine('Received second SIGINT — forcing exit.');
    testRunnerDependencies.exitProcess(130);
  }

  ctx.runAborted = true;
  Logger.w('\nReceived SIGINT — aborting run...');
  ctx.runAbortController.abort();
}

function abortedBeforeExecutionError(): PreExecutionFailureError {
  return new PreExecutionFailureError({
    phase: 'setup',
    message: 'Run aborted before execution.',
    exitCode: 130,
  });
}

/** Resolve and compile the selected tests; wrap failures as validation-phase errors. */
async function runValidationPhase(ctx: TestRunContext): Promise<{
  checked: CheckRunnerResult;
  effectiveGoals: Map<string, string>;
}> {
  try {
    const checked = await testRunnerDependencies.runCheck({
      ...ctx.options,
      requireSelection: true,
    });
    const effectiveGoals: Map<string, string> = new Map(
      checked.tests.map((t) => [
        t.testId!,
        compileTestObjective(t, checked.environment.bindings),
      ]),
    );
    return { checked, effectiveGoals };
  } catch (error) {
    if (error instanceof PreExecutionFailureError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new PreExecutionFailureError({
      phase: 'validation',
      message,
      exitCode: ctx.runAborted ? 130 : 1,
    });
  }
}

/** Convert a setup-phase failure into a PreExecutionFailureError with diagnostics. */
function toSetupFailure(ctx: TestRunContext, error: unknown): PreExecutionFailureError {
  if (error instanceof PreExecutionFailureError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  const diagnostics = isDevicePreparationError(error) ? error.diagnostics : [];
  return new PreExecutionFailureError({
    phase: 'setup',
    message: formatPreExecutionFailureMessage(
      `Run setup failed before execution: ${message}`,
      diagnostics,
    ),
    diagnostics,
    exitCode: ctx.runAborted ? 130 : 1,
  });
}

/** Run host preflight and prepare the shared device session for the whole run. */
async function prepareRunSession(
  ctx: TestRunContext,
  checked: CheckRunnerResult,
): Promise<TestSession> {
  try {
    const requestedPlatforms = resolveTestRequestedPlatforms(checked.resolvedApp.platform);
    Logger.i(formatResolvedAppSummary(checked.resolvedApp));
    const preflight =
      process.env[CLI_TEST_SKIP_HOST_PREFLIGHT_ENV_VAR] === '1'
        ? {
            requestedPlatforms,
            checks: [],
          }
        : await testRunnerDependencies.runHostPreflight({
            requestedPlatforms,
          });
    if (shouldBlockLocalRunPreflight(preflight)) {
      throw new PreExecutionFailureError({
        phase: 'setup',
        message: `Run setup failed before execution: ${formatHostPreflightReport(preflight, 'test')}`,
        exitCode: ctx.runAborted ? 130 : 1,
      });
    }

    if (ctx.runAborted) {
      throw abortedBeforeExecutionError();
    }

    const forcedDeviceSetupFailure = process.env[CLI_TEST_FORCE_DEVICE_SETUP_FAILURE_ENV_VAR];
    if (forcedDeviceSetupFailure) {
      throw new DevicePreparationError(forcedDeviceSetupFailure);
    }
    return await testRunnerDependencies.prepareTestSession({
      platform: checked.resolvedApp.platform,
      appOverridePath: checked.appOverride?.appPath,
      app: checked.resolvedApp,
    });
  } catch (error) {
    throw toSetupFailure(ctx, error);
  }
}

/** Create the run directory + report writer and swap buffered logging to the run log. */
async function initializeReportWriter(
  ctx: TestRunContext,
  checked: CheckRunnerResult,
  effectiveGoals: Map<string, string>,
  platform: string,
): Promise<ReportWriter> {
  const { reportWriter, runDir } = await createReportWriter({
    workspace: ctx.workspace,
    envName: checked.environment.envName,
    platform,
    startedAt: ctx.startedAt,
    bindings: checked.environment.bindings,
  });
  ctx.reportWriter = reportWriter;
  ctx.runDir = runDir;
  ctx.logSink = reportWriter.createLoggerSink();
  flushBufferedLogEntries(ctx.bufferedLogEntries, ctx.logSink);
  Logger.removeSink(ctx.bufferingSink);
  Logger.addSink(ctx.logSink);
  await reportWriter.writeRunInputs({
    workspaceRoot: checked.workspace.rootDir,
    environment: checked.environment,
    tests: checked.tests,
    effectiveGoals,
    cli: buildCliContext(ctx.options),
    model: buildModelContext(ctx.options.defaults.provider, ctx.options.defaults.modelName),
    ...(ctx.options.defaults.reasoning !== undefined
      ? { reasoning: ctx.options.defaults.reasoning }
      : {}),
    ...(ctx.options.features !== undefined ? { features: ctx.options.features } : {}),
    app: buildAppContext(checked.resolvedApp, checked.appOverride?.appPath ?? ctx.options.appPath),
    target: checked.target,
    suite: checked.suite,
  });
  reportWriter.appendLogLine(`Starting FinalRun test run ${path.basename(runDir)}`);
  return reportWriter;
}

/**
 * Execute each selected test against the shared session. The post-result
 * aborted/terminal-failure checks are deliberately hoisted OUTSIDE the
 * per-test try (see executeTestAndRecord): an appendLogLine write failure
 * in them propagates out of the loop rather than being caught.
 */
async function runTestLoop(
  ctx: TestRunContext,
  checked: CheckRunnerResult,
  effectiveGoals: Map<string, string>,
  goalSession: TestSession,
): Promise<void> {
  for (const test of checked.tests) {
    if (ctx.runAborted && !ctx.reportWriter) {
      throw abortedBeforeExecutionError();
    }
    if (ctx.runAborted) {
      break;
    }

    const reportWriter =
      ctx.reportWriter ??
      (await initializeReportWriter(ctx, checked, effectiveGoals, goalSession.platform));
    reportWriter.appendLogLine(`Running test ${test.relativePath}`);

    const goalResult = await executeTestAndRecord(ctx, checked, effectiveGoals, {
      goalSession,
      reportWriter,
      test,
    });
    if (!goalResult) {
      break;
    }

    if (goalResult.status === 'aborted' || ctx.runAborted) {
      ctx.runAborted = true;
      reportWriter.appendLogLine(`Run aborted while executing test ${test.relativePath}.`);
      break;
    }
    if (goalResult.terminalFailure) {
      reportWriter.appendLogLine(
        `Stopping run after terminal AI provider failure in ${test.relativePath}: ${goalResult.terminalFailure.message}`,
      );
      break;
    }
  }
}

/**
 * Run one test on the shared session and record its outcome. Returns the
 * execution result, or undefined when the test failed before completion
 * (the run stops).
 */
async function executeTestAndRecord(
  ctx: TestRunContext,
  checked: CheckRunnerResult,
  effectiveGoals: Map<string, string>,
  target: { goalSession: TestSession; reportWriter: ReportWriter; test: TestDefinition },
): Promise<TestExecutionResult | undefined> {
  const { goalSession, reportWriter, test } = target;
  const testStartedAt = new Date().toISOString();
  try {
    const goal =
      effectiveGoals.get(test.testId!) ??
      compileTestObjective(test, checked.environment.bindings);
    const recordingExtension = goalSession.platform === 'android' ? '.mp4' : '.mov';
    const recordingOutputPath = path.join(
      ctx.runDir,
      'tests',
      test.testId!,
      `recording${recordingExtension}`,
    );
    const goalResult = await testRunnerDependencies.executeTestOnSession(goalSession, {
      goal,
      apiKeys: ctx.options.apiKeys,
      defaults: ctx.options.defaults,
      features: ctx.options.features,
      maxIterations: ctx.options.maxIterations,
      debug: ctx.options.debug,
      runtimeBindings: checked.environment.bindings,
      abortSignal: ctx.runAbortController.signal,
      recording: {
        runId: path.basename(ctx.runDir),
        testId: test.testId!,
        outputFilePath: recordingOutputPath,
        keepPartialOnFailure: true,
      },
      deviceLog: {
        runId: path.basename(ctx.runDir),
        testId: test.testId!,
        keepPartialOnFailure: true,
      },
    });

    const testRecord = await reportWriter.writeTestRecord(
      test,
      goalResult,
      checked.environment.bindings,
    );
    ctx.testResults.push(testRecord);
    ctx.encounteredFailure ||= !goalResult.success;
    return goalResult;
  } catch (error) {
    await recordTestExecutionFailure(ctx, checked, target, testStartedAt, error);
    return undefined;
  }
}

/** Record a test that threw before completing and mark the run failed. */
async function recordTestExecutionFailure(
  ctx: TestRunContext,
  checked: CheckRunnerResult,
  target: { goalSession: TestSession; reportWriter: ReportWriter; test: TestDefinition },
  testStartedAt: string,
  error: unknown,
): Promise<void> {
  const { goalSession, reportWriter, test } = target;
  const message = error instanceof Error ? error.message : String(error);
  ctx.encounteredFailure = true;
  reportWriter.appendLogLine(
    `Test ${test.relativePath} failed before completion: ${message}`,
  );
  ctx.testResults.push(
    await reportWriter.writeTestFailureRecord({
      test: test,
      bindings: checked.environment.bindings,
      message,
      platform: goalSession.platform,
      startedAt: testStartedAt,
      completedAt: new Date().toISOString(),
    }),
  );
}

/** Compute the run outcome, finalize report artifacts, and rebuild the run index. */
async function finalizeRun(ctx: TestRunContext): Promise<TestRunnerResult> {
  const success =
    !ctx.runAborted && !ctx.encounteredFailure && ctx.testResults.every((t) => t.success);
  const runStatus: ExecutionStatus = ctx.runAborted
    ? 'aborted'
    : success
      ? 'success'
      : 'failure';
  if (!ctx.reportWriter) {
    throw new Error('Report writer was not initialized before execution completed.');
  }
  await ctx.reportWriter.finalize({
    startedAt: ctx.startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    tests: ctx.testResults,
    successOverride: success,
    statusOverride: runStatus,
    failurePhase: runStatus === 'failure' && ctx.encounteredFailure ? 'execution' : undefined,
  });
  await rebuildRunIndex(ctx.workspace.artifactsDir);

  return {
    success,
    status: runStatus,
    runId: path.basename(ctx.runDir),
    runDir: ctx.runDir,
    runIndexPath: path.join(ctx.workspace.artifactsDir, 'runs.json'),
    testResults: ctx.testResults,
  };
}

/** Release the shared device session; failures are logged, never propagated. */
async function releaseSession(goalSession: TestSession): Promise<void> {
  try {
    await goalSession.cleanup();
  } catch (error) {
    Logger.w('Failed to clean up device resources:', error);
  }
}

export function selectExecutionPlatform(
  devices: Array<Pick<DeviceInfo, 'getPlatform'>>,
  preferredPlatform?: string,
): string {
  const availablePlatforms = new Set(devices.map((device) => device.getPlatform()));
  if (preferredPlatform) {
    const matchingPlatform = preferredPlatform.toLowerCase();
    const match = devices.some((device) => device.getPlatform() === matchingPlatform);
    if (!match) {
      throw new Error(`No ${preferredPlatform} devices found.`);
    }
    return matchingPlatform;
  }

  if (availablePlatforms.size > 1) {
    throw new Error(
      'Multiple platforms are available. Choose --platform android or --platform ios.',
    );
  }

  return devices[0]!.getPlatform();
}

async function createReportWriter(params: {
  workspace: FinalRunWorkspace;
  envName: string;
  platform: string;
  startedAt: Date;
  bindings: RuntimeBindings;
}): Promise<{ reportWriter: ReportWriter; runDir: string }> {
  const runId = createRunId({
    envName: params.envName,
    platform: params.platform,
    startedAt: params.startedAt,
  });
  const runDir = path.join(params.workspace.artifactsDir, runId);
  const reportWriter = new ReportWriter({
    runDir,
    envName: params.envName,
    platform: params.platform,
    runId,
    bindings: params.bindings,
  });
  await reportWriter.init();
  return { reportWriter, runDir };
}

function flushBufferedLogEntries(
  entries: LogEntry[],
  sink: ReturnType<ReportWriter['createLoggerSink']>,
): void {
  for (const entry of entries) {
    sink(entry);
  }
  entries.length = 0;
}

function buildCliContext(options: TestRunnerOptions): {
  command: string;
  selectors: string[];
  suitePath?: string;
  requestedPlatform?: string;
  appOverridePath?: string;
  debug: boolean;
  maxIterations?: number;
} {
  const invokedCommand = options.invokedCommand ?? 'test';
  const commandParts = ['finalrun', invokedCommand];
  if (invokedCommand === 'suite' && options.suitePath) {
    commandParts.push(options.suitePath);
  }
  return {
    command: commandParts.join(' '),
    selectors: options.selectors ?? [],
    suitePath: options.suitePath,
    requestedPlatform: options.platform,
    appOverridePath: options.appPath,
    debug: options.debug === true,
    maxIterations: options.maxIterations,
  };
}

function buildModelContext(
  provider: string | undefined,
  modelName: string | undefined,
): {
  provider: string;
  modelName: string;
  label: string;
} {
  const resolvedProvider = provider ?? 'unknown';
  const resolvedModelName = modelName ?? 'unknown';
  return {
    provider: resolvedProvider,
    modelName: resolvedModelName,
    label: `${resolvedProvider}/${resolvedModelName}`,
  };
}

function buildAppContext(
  resolvedApp: ResolvedAppConfig,
  appOverridePath?: string,
): {
  source: 'config';
  label: string;
  identifier: string;
  identifierKind: 'packageName' | 'bundleId';
  name?: string;
  sourceEnvName?: string;
  overridePath?: string;
} {
  return {
    source: 'config',
    label: resolvedApp.name
      ? `${resolvedApp.name} (${resolvedApp.identifier})`
      : resolvedApp.identifier,
    identifier: resolvedApp.identifier,
    identifierKind: resolvedApp.identifierKind,
    name: resolvedApp.name,
    sourceEnvName: resolvedApp.sourceEnvName,
    overridePath: appOverridePath,
  };
}

function formatPreExecutionFailureMessage(
  message: string,
  diagnostics: DeviceInventoryDiagnostic[],
): string {
  if (diagnostics.length === 0) {
    return message;
  }
  return `${message}\n\n${formatDiagnosticsForOutput(diagnostics)}`;
}
