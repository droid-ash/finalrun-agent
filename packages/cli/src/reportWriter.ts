import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import YAML from 'yaml';
import {
  type AgentAction,
  type BindingReference,
  type EnvironmentRecord,
  type FailurePhase,
  type FeatureOverrides,
  type FirstFailure,
  type LogEntry,
  Logger,
  type LoggerSink,
  type ReasoningLevel,
  type RunManifest,
  type RunManifestAppRecord,
  type RunStatus,
  type RunSummary,
  type RunTarget,
  type RuntimeBindings,
  type SuiteDefinition,
  type TestDefinition,
  type TestResult,
  type TestStatus,
  redactResolvedValue,
} from '@finalrun/common';
import type { TestExecutionResult, AgentActionResult } from '@finalrun/goal-executor';
import type { DeviceLogCaptureResult } from '@finalrun/common';
import type { LoadedEnvironmentConfig } from '@finalrun/common';

interface TestSnapshotState {
  authored: {
    name: string;
    description?: string;
    setup: string[];
    steps: string[];
    expected_state: string[];
  };
  bindingReferences: BindingReference;
  snapshotYamlPath: string;
  snapshotJsonPath: string;
  workspaceSourcePath: string;
  effectiveGoal: string;
}

interface WriteRunInputsParams {
  workspaceRoot: string;
  environment: LoadedEnvironmentConfig;
  tests: TestDefinition[];
  suite?: SuiteDefinition;
  effectiveGoals: Map<string, string>;
  target: RunTarget;
  cli: { command: string; selectors: string[]; debug: boolean; [key: string]: unknown };
  model: { provider: string; modelName: string; label: string };
  reasoning?: ReasoningLevel;
  features?: FeatureOverrides;
  app: RunManifestAppRecord;
}

export class ReportWriter {
  private static readonly _FAILURE_PLACEHOLDER_IMAGE = Buffer.from(
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBxAQEBAQEA8QDw8PDw8PDw8PDw8QDxAQFREWFhURFRUYHSggGBolGxUVITEhJSkrLi4uFx8zODMsNygtLisBCgoKDg0OGxAQGy0fICUtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLf/AABEIAAEAAgMBIgACEQEDEQH/xAAXAAADAQAAAAAAAAAAAAAAAAAAAQID/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEAMQAAAB5A//xAAXEAEBAQEAAAAAAAAAAAAAAAABABEh/9oACAEBAAEFAm3H/8QAFBEBAAAAAAAAAAAAAAAAAAAAEP/aAAgBAwEBPwGn/8QAFBEBAAAAAAAAAAAAAAAAAAAAEP/aAAgBAgEBPwGn/9k=',
    'base64',
  );
  private readonly _runDir: string;
  private readonly _envName: string;
  private readonly _platform: string;
  private readonly _runId: string;
  private readonly _bindings: RuntimeBindings;
  private readonly _runnerLogPath: string;
  private _inputEnvironment: EnvironmentRecord;
  private _inputSuite?: SuiteDefinition;
  private _inputTests: TestDefinition[] = [];
  private readonly _testSnapshots = new Map<string, TestSnapshotState>();
  private _cliContext: {
    command: string;
    selectors: string[];
    debug: boolean;
  } = {
    command: 'finalrun test',
    selectors: [],
    debug: false,
  };
  private _runTarget: RunTarget = {
    type: 'direct',
  };
  private _modelContext: {
    provider: string;
    modelName: string;
    label: string;
  } = {
    provider: 'unknown',
    modelName: 'unknown',
    label: 'unknown/unknown',
  };
  private _appContext: RunManifestAppRecord = {
    source: 'repo',
    label: 'repo app',
  };
  private _runContextJsonPath?: string;

  constructor(params: {
    runDir: string;
    envName: string;
    platform: string;
    runId: string;
    bindings: RuntimeBindings;
  }) {
    this._runDir = params.runDir;
    this._envName = params.envName;
    this._platform = params.platform;
    this._runId = params.runId;
    this._bindings = params.bindings;
    this._runnerLogPath = path.join(this._runDir, 'runner.log');
    this._inputEnvironment = {
      envName: params.envName,
      variables: params.bindings.variables,
      secretReferences: [],
    };
  }

  async init(): Promise<void> {
    await fsp.mkdir(this._runDir, { recursive: true });
    await fsp.writeFile(this._runnerLogPath, '', 'utf-8');
  }

  createLoggerSink(): LoggerSink {
    return (entry: LogEntry) => {
      const renderedMessage =
        redactResolvedValue(entry.renderedMessage, this._bindings) ?? entry.renderedMessage;
      fs.appendFileSync(
        this._runnerLogPath,
        `${entry.timestamp} ${renderedMessage}\n`,
        'utf-8',
      );
    };
  }

  appendLogLine(line: string): void {
    const renderedLine = redactResolvedValue(line, this._bindings) ?? line;
    fs.appendFileSync(
      this._runnerLogPath,
      `${new Date().toISOString()} ${renderedLine}\n`,
      'utf-8',
    );
  }

  appendRawBlock(block: string): void {
    const renderedBlock = redactResolvedValue(block, this._bindings) ?? block;
    fs.appendFileSync(
      this._runnerLogPath,
      renderedBlock.endsWith('\n') ? renderedBlock : `${renderedBlock}\n`,
      'utf-8',
    );
  }

  setRunContext(params: {
    cli: { command: string; selectors: string[]; debug: boolean; [key: string]: unknown };
    model: { provider: string; modelName: string; label: string };
    app: RunManifestAppRecord;
    target?: RunTarget;
  }): void {
    this._cliContext = params.cli;
    this._modelContext = params.model;
    this._appContext = params.app;
    this._runTarget = params.target ?? { type: 'direct' };
  }

  async writeRunInputs(params: WriteRunInputsParams): Promise<void> {
    const inputDir = path.join(this._runDir, 'input');
    const testSnapshotDir = path.join(inputDir, 'tests');
    await fsp.mkdir(testSnapshotDir, { recursive: true });

    await this._writeRunContextInput(params);
    await this._writeEnvironmentInput(params);
    await this._writeSuiteInput(params);
    await this._writeTestInputs(params);
  }

  private async _writeJson(relativePath: string, value: unknown): Promise<void> {
    await fsp.writeFile(
      path.join(this._runDir, relativePath),
      JSON.stringify(value, null, 2),
      'utf-8',
    );
  }

  private async _writeRunContextInput(params: WriteRunInputsParams): Promise<void> {
    this.setRunContext({
      cli: params.cli,
      model: params.model,
      app: params.app,
      target: params.target,
    });
    this._runContextJsonPath = path.posix.join('input', 'run-context.json');
    await this._writeJson(this._runContextJsonPath, {
      cli: params.cli,
      model: params.model,
      ...(params.reasoning !== undefined ? { reasoning: params.reasoning } : {}),
      ...(params.features !== undefined ? { features: params.features } : {}),
      app: params.app,
      target: params.target,
    });
  }

  private async _writeEnvironmentInput(params: WriteRunInputsParams): Promise<void> {
    const envSnapshotYamlPath = path.posix.join('input', 'env.snapshot.yaml');
    const envSnapshotJsonPath = path.posix.join('input', 'env.json');
    const workspaceEnvPath = params.environment.envPath
      ? toDisplayPath(params.workspaceRoot, params.environment.envPath)
      : undefined;
    this._inputEnvironment = {
      envName: params.environment.envName,
      workspaceEnvPath,
      snapshotYamlPath: envSnapshotYamlPath,
      snapshotJsonPath: envSnapshotJsonPath,
      app: params.environment.config.app,
      variables: params.environment.config.variables,
      secretReferences: params.environment.secretReferences,
    };
    await fsp.writeFile(
      path.join(this._runDir, envSnapshotYamlPath),
      YAML.stringify({
        app: params.environment.config.app,
        secrets: params.environment.config.secrets,
        variables: params.environment.config.variables,
      }),
      'utf-8',
    );
    await this._writeJson(envSnapshotJsonPath, this._inputEnvironment);
  }

  private async _writeSuiteInput(params: WriteRunInputsParams): Promise<void> {
    this._inputSuite = undefined;
    if (!params.suite) {
      return;
    }
    const suiteSnapshotYamlPath = path.posix.join('input', 'suite.snapshot.yaml');
    const suiteSnapshotJsonPath = path.posix.join('input', 'suite.json');
    const suiteRecord: SuiteDefinition = {
      suiteId: params.suite.suiteId,
      name: params.suite.name,
      description: params.suite.description,
      workspaceSourcePath: params.suite.sourcePath
        ? toDisplayPath(params.workspaceRoot, params.suite.sourcePath)
        : undefined,
      snapshotYamlPath: params.suite.sourcePath ? suiteSnapshotYamlPath : undefined,
      snapshotJsonPath: suiteSnapshotJsonPath,
      tests: params.suite.tests,
      resolvedTestIds: params.tests.map((test) => test.testId!),
    };
    if (params.suite.sourcePath) {
      await fsp.copyFile(
        params.suite.sourcePath,
        path.join(this._runDir, suiteSnapshotYamlPath),
      );
    }
    await this._writeJson(suiteSnapshotJsonPath, suiteRecord);
    this._inputSuite = suiteRecord;
  }

  private async _writeTestInputs(params: WriteRunInputsParams): Promise<void> {
    const selectedTests: TestDefinition[] = [];
    this._testSnapshots.clear();
    for (const test of params.tests) {
      const snapshotYamlPath = path.posix.join('input', 'tests', `${test.testId!}.yaml`);
      const snapshotJsonPath = path.posix.join('input', 'tests', `${test.testId!}.json`);
      const bindingReferences = collectBindingReferences(test);
      const authored = {
        name: test.name,
        description: test.description,
        setup: test.setup,
        steps: test.steps,
        expected_state: test.expected_state,
      };
      const workspaceSourcePath = test.sourcePath
        ? toDisplayPath(params.workspaceRoot, test.sourcePath)
        : undefined;
      const effectiveGoal = params.effectiveGoals.get(test.testId!) ?? '';
      if (test.sourcePath) {
        await fsp.copyFile(test.sourcePath, path.join(this._runDir, snapshotYamlPath));
      }
      await this._writeJson(snapshotJsonPath, {
        testId: test.testId!,
        testName: test.name,
        relativePath: test.relativePath,
        workspaceSourcePath,
        bindingReferences,
        ...authored,
      });
      this._testSnapshots.set(test.testId!, {
        authored,
        bindingReferences,
        snapshotYamlPath,
        snapshotJsonPath,
        workspaceSourcePath: workspaceSourcePath ?? test.sourcePath ?? '',
        effectiveGoal,
      });
      selectedTests.push({
        testId: test.testId!,
        name: test.name,
        description: test.description,
        relativePath: test.relativePath,
        workspaceSourcePath,
        snapshotYamlPath: test.sourcePath ? snapshotYamlPath : undefined,
        snapshotJsonPath,
        bindingReferences,
        setup: test.setup,
        steps: test.steps,
        expected_state: test.expected_state,
      });
    }

    this._inputTests = selectedTests;
  }

  async writeTestRecord(
    test: TestDefinition,
    result: TestExecutionResult,
    bindings: RuntimeBindings,
  ): Promise<TestResult> {
    await this._ensureTestArtifactDirs(test.testId!);

    const recordingRelative = await this._copyRecordingArtifact(test.testId!, result.recording);
    const recordingStartedAt = result.recording?.startedAt;
    const recordingCompletedAt = result.recording?.completedAt;

    const deviceLogRelative = await this._copyLogArtifact(test.testId!, result.deviceLog, bindings);
    const deviceLogStartedAt = result.deviceLog?.startedAt;
    const deviceLogCompletedAt = result.deviceLog?.completedAt;

    const steps = await this._writeStepArtifacts(test.testId!, result, bindings, recordingStartedAt);

    const testRecord: TestResult = {
      testId: test.testId!,
      testName: test.name,
      sourcePath: test.sourcePath ?? '',
      relativePath: test.relativePath ?? '',
      success: result.success,
      status: resolveTestStatus(result),
      message: redactResolvedValue(result.message, bindings) ?? result.message,
      analysis: redactResolvedValue(result.analysis, bindings),
      platform: result.platform,
      startedAt: result.startedAt,
      completedAt: result.completedAt,
      durationMs: durationMsBetween(result.startedAt, result.completedAt),
      recordingFile: recordingRelative,
      recordingStartedAt,
      recordingCompletedAt,
      deviceLogFile: deviceLogRelative,
      deviceLogStartedAt,
      deviceLogCompletedAt,
      steps,
    };

    await this._writeJson(path.posix.join('tests', test.testId!, 'result.json'), testRecord);

    return testRecord;
  }

  private async _ensureTestArtifactDirs(testId: string): Promise<void> {
    const testDir = path.join(this._runDir, 'tests', testId);
    await fsp.mkdir(path.join(testDir, 'actions'), { recursive: true });
    await fsp.mkdir(path.join(testDir, 'screenshots'), { recursive: true });
  }

  private async _writeStepArtifacts(
    testId: string,
    result: TestExecutionResult,
    bindings: RuntimeBindings,
    recordingStartedAt: string | undefined,
  ): Promise<AgentAction[]> {
    const steps: AgentAction[] = [];
    for (const [index, step] of result.steps.entries()) {
      const stepNumber = index + 1;
      const stepFileBase = `${String(stepNumber).padStart(3, '0')}`;
      const stepJsonRelative = path.posix.join('tests', testId, 'actions', `${stepFileBase}.json`);
      const screenshotRelative = step.screenshot
        ? path.posix.join('tests', testId, 'screenshots', `${stepFileBase}.jpg`)
        : undefined;

      if (step.screenshot && screenshotRelative) {
        const buffer = decodeScreenshot(step.screenshot);
        await fsp.writeFile(path.join(this._runDir, screenshotRelative), buffer);
      }

      const artifactStep = toAgentAction(step, {
        stepNumber,
        bindings,
        screenshotFile: screenshotRelative,
        videoOffsetMs: computeVideoOffsetMs(step.timestamp, recordingStartedAt),
        stepJsonFile: stepJsonRelative,
      });
      steps.push(artifactStep);
      await this._writeJson(stepJsonRelative, artifactStep);
    }
    return steps;
  }

  async finalize(params: {
    startedAt: string;
    completedAt: string;
    tests: TestResult[];
    successOverride?: boolean;
    statusOverride?: RunStatus;
    failurePhase?: FailurePhase;
    diagnosticsSummary?: string;
  }): Promise<RunSummary> {
    const summary = this._buildRunSummary(params);
    const manifest = this._buildRunManifest({
      startedAt: params.startedAt,
      completedAt: params.completedAt,
      tests: params.tests,
      success: summary.success,
      status: summary.status,
      failurePhase: params.failurePhase,
      diagnosticsSummary: params.diagnosticsSummary,
    });

    await this._writeJson('summary.json', summary);
    await this._writeJson('run.json', manifest);

    return summary;
  }

  private _buildRunSummary(params: {
    startedAt: string;
    completedAt: string;
    tests: TestResult[];
    successOverride?: boolean;
    statusOverride?: RunStatus;
    failurePhase?: FailurePhase;
  }): RunSummary {
    const passedCount = params.tests.filter((test) => test.success).length;
    const failedCount = params.tests.length - passedCount;
    const stepCount = params.tests.reduce((total, test) => total + test.steps.length, 0);
    return {
      runId: this._runId,
      envName: this._envName,
      platform: this._platform,
      startedAt: params.startedAt,
      completedAt: params.completedAt,
      durationMs: durationMsBetween(params.startedAt, params.completedAt),
      success: params.successOverride ?? failedCount === 0,
      status: params.statusOverride ?? ((params.successOverride ?? failedCount === 0) ? 'success' : 'failure'),
      failurePhase: params.failurePhase,
      testCount: params.tests.length,
      passedCount,
      failedCount,
      stepCount,
      target: this._runTarget,
      variables: this._bindings.variables,
      tests: params.tests.map((test) => ({
        testId: test.testId,
        testName: test.testName,
        relativePath: test.relativePath,
        success: test.success,
        status: test.status,
        durationMs: test.durationMs,
        resultFile: path.posix.join('tests', test.testId, 'result.json'),
      })),
      runJsonFile: 'run.json',
    };
  }

  async writeTestFailureRecord(params: {
    test: TestDefinition;
    bindings: RuntimeBindings;
    message: string;
    platform: string;
    startedAt: string;
    completedAt: string;
  }): Promise<TestResult> {
    await this._ensureTestArtifactDirs(params.test.testId!);

    const stepJsonRelative = path.posix.join('tests', params.test.testId!, 'actions', '001.json');
    const screenshotRelative = path.posix.join(
      'tests',
      params.test.testId!,
      'screenshots',
      '001.jpg',
    );
    const failureMessage =
      redactResolvedValue(params.message, params.bindings) ?? params.message;
    const failureStep = buildRunFailureStep({
      failureMessage,
      startedAt: params.startedAt,
      completedAt: params.completedAt,
      screenshotRelative,
      stepJsonRelative,
    });

    await fsp.writeFile(
      path.join(this._runDir, screenshotRelative),
      ReportWriter._FAILURE_PLACEHOLDER_IMAGE,
    );
    await this._writeJson(stepJsonRelative, failureStep);

    const testRecord: TestResult = {
      testId: params.test.testId!,
      testName: params.test.name,
      sourcePath: params.test.sourcePath ?? '',
      relativePath: params.test.relativePath ?? '',
      success: false,
      status: 'error',
      message: failureMessage,
      analysis: undefined,
      platform: params.platform,
      startedAt: params.startedAt,
      completedAt: params.completedAt,
      durationMs: durationMsBetween(params.startedAt, params.completedAt),
      steps: [failureStep],
    };

    await this._writeJson(path.posix.join('tests', params.test.testId!, 'result.json'), testRecord);

    return testRecord;
  }

  private _buildRunManifest(params: {
    startedAt: string;
    completedAt: string;
    tests: TestResult[];
    success: boolean;
    status: RunStatus;
    failurePhase?: FailurePhase;
    diagnosticsSummary?: string;
  }): RunManifest {
    const testRecords = params.tests.map((test) => this._toRunManifestTest(test));
    const firstFailure = findRunFirstFailure(testRecords, params.diagnosticsSummary);
    return {
      schemaVersion: 3,
      run: {
        runId: this._runId,
        success: params.success,
        status: params.status,
        failurePhase: params.failurePhase,
        startedAt: params.startedAt,
        completedAt: params.completedAt,
        durationMs: durationMsBetween(params.startedAt, params.completedAt),
        envName: this._envName,
        platform: this._platform,
        model: this._modelContext,
        app: this._appContext,
        selectors: this._cliContext.selectors,
        target: this._runTarget,
        counts: buildRunManifestCounts(testRecords),
        firstFailure,
        diagnosticsSummary: params.diagnosticsSummary,
      },
      input: {
        environment: this._inputEnvironment,
        suite: this._inputSuite,
        tests: this._inputTests,
        cli: this._cliContext,
      },
      tests: testRecords,
      paths: {
        runJson: 'run.json',
        summaryJson: 'summary.json',
        log: 'runner.log',
        runContextJson: this._runContextJsonPath,
      },
    };
  }

  private _toRunManifestTest(test: TestResult): TestResult {
    const snapshot = this._testSnapshots.get(test.testId);
    const steps = test.steps.map((step) => ({ ...step })) as AgentAction[];
    const passedSteps = steps.filter((step) => step.success).length;

    return {
      ...test,
      workspaceSourcePath: snapshot?.workspaceSourcePath ?? test.sourcePath,
      snapshotYamlPath: snapshot?.snapshotYamlPath ?? '',
      snapshotJsonPath: snapshot?.snapshotJsonPath ?? '',
      bindingReferences: snapshot?.bindingReferences ?? { variables: [], secrets: [] },
      authored: toAuthoredRecord(snapshot, test),
      effectiveGoal: snapshot?.effectiveGoal ?? '',
      counts: {
        executionStepsTotal: steps.length,
        executionStepsPassed: passedSteps,
        executionStepsFailed: steps.length - passedSteps,
      },
      firstFailure: findTestFirstFailure(test, steps),
      previewScreenshotPath: selectPreviewScreenshotPath(steps),
      resultJsonPath: path.posix.join('tests', test.testId, 'result.json'),
      steps,
    };
  }

  private async _copyRecordingArtifact(
    testId: string,
    recording: TestExecutionResult['recording'],
  ): Promise<string | undefined> {
    if (!recording?.filePath) {
      return undefined;
    }

    const ext = path.extname(recording.filePath) || '.mov';
    const recordingRelative = path.posix.join('tests', testId, `recording${ext}`);
    const sourcePath = path.resolve(recording.filePath);
    const targetPath = path.resolve(path.join(this._runDir, recordingRelative));

    try {
      await fsp.access(sourcePath);
    } catch {
      Logger.w(`Recording file not found for report copy: ${recording.filePath}`);
      return undefined;
    }

    if (sourcePath === targetPath) {
      return recordingRelative;
    }

    await fsp.copyFile(sourcePath, targetPath);
    return recordingRelative;
  }

  private async _copyLogArtifact(
    testId: string,
    deviceLog: DeviceLogCaptureResult | undefined,
    bindings: RuntimeBindings,
  ): Promise<string | undefined> {
    if (!deviceLog?.filePath) {
      return undefined;
    }

    const logRelative = path.posix.join('tests', testId, 'device.log');
    const sourcePath = path.resolve(deviceLog.filePath);
    const targetPath = path.resolve(path.join(this._runDir, logRelative));

    try {
      await fsp.access(sourcePath);
    } catch {
      Logger.w(`Device log file not found for report copy: ${deviceLog.filePath}`);
      return undefined;
    }

    const stats = await fsp.stat(sourcePath);
    if (stats.size > 50 * 1024 * 1024) {
      Logger.w(
        `Device log file is large (${(stats.size / 1024 / 1024).toFixed(1)} MB): ${sourcePath}. Redaction will hold the entire file in memory.`,
      );
    }

    await fsp.copyFile(sourcePath, targetPath);

    // Read, redact secrets, and write back
    try {
      const raw = await fsp.readFile(targetPath, 'utf-8');
      const redacted = redactResolvedValue(raw, bindings);
      if (redacted !== undefined && redacted !== raw) {
        await fsp.writeFile(targetPath, redacted, 'utf-8');
      }
    } catch (error) {
      Logger.w(`Failed to redact device log file: ${this._formatError(error)}`);
      await fsp.unlink(targetPath).catch(() => {});
      return undefined;
    }

    return logRelative;
  }

  private _formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

function durationMsBetween(startedAt: string, completedAt: string): number {
  return Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime());
}

function findTestFirstFailure(test: TestResult, steps: AgentAction[]): FirstFailure | undefined {
  const firstFailureStep = steps.find((step) => !step.success);
  return firstFailureStep
    ? {
        testId: test.testId,
        testName: test.testName,
        stepNumber: firstFailureStep.stepNumber,
        actionType: firstFailureStep.actionType,
        message:
          firstFailureStep.errorMessage ??
          firstFailureStep.trace?.failureReason ??
          test.message,
        screenshotPath: firstFailureStep.screenshotFile,
        stepJsonPath: firstFailureStep.stepJsonFile,
      }
    : undefined;
}

function toAuthoredRecord(
  snapshot: TestSnapshotState | undefined,
  test: TestResult,
): TestResult['authored'] {
  return snapshot?.authored
    ? {
        name: snapshot.authored.name,
        description: snapshot.authored.description,
        setup: snapshot.authored.setup,
        steps: snapshot.authored.steps,
        expected_state: snapshot.authored.expected_state,
      }
    : {
        name: test.testName,
        setup: [],
        steps: [],
        expected_state: [],
      };
}

function buildRunManifestCounts(testRecords: TestResult[]): RunManifest['run']['counts'] {
  const stepTotal = testRecords.reduce(
    (total, test) => total + (test.counts?.executionStepsTotal ?? 0),
    0,
  );
  const stepPassed = testRecords.reduce(
    (total, test) => total + (test.counts?.executionStepsPassed ?? 0),
    0,
  );
  return {
    tests: {
      total: testRecords.length,
      passed: testRecords.filter((test) => test.success).length,
      failed: testRecords.filter((test) => !test.success).length,
    },
    steps: {
      total: stepTotal,
      passed: stepPassed,
      failed: stepTotal - stepPassed,
    },
  };
}

function buildRunFailureStep(params: {
  failureMessage: string;
  startedAt: string;
  completedAt: string;
  screenshotRelative: string;
  stepJsonRelative: string;
}): AgentAction {
  return {
    stepNumber: 1,
    iteration: 1,
    actionType: 'run_failure',
    naturalLanguageAction: 'Run setup failed before the first recorded agent action.',
    reason: params.failureMessage,
    analysis: 'No executable agent step completed before the run failed.',
    success: false,
    status: 'failure',
    errorMessage: params.failureMessage,
    durationMs: durationMsBetween(params.startedAt, params.completedAt),
    timestamp: params.completedAt,
    screenshotFile: params.screenshotRelative,
    stepJsonFile: params.stepJsonRelative,
    trace: {
      step: 1,
      action: 'run_failure',
      status: 'failure',
      totalMs: durationMsBetween(params.startedAt, params.completedAt),
      spans: [],
      failureReason: params.failureMessage,
    },
  };
}

function resolveTestStatus(result: TestExecutionResult): TestStatus {
  if (result.status === 'aborted') {
    return 'aborted';
  }
  return result.success ? 'success' : 'failure';
}

function collectBindingReferences(test: TestDefinition): BindingReference {
  const variables = new Set<string>();
  const secrets = new Set<string>();
  const values = [
    test.name,
    test.description,
    ...test.setup,
    ...test.steps,
    ...test.expected_state,
  ].filter((value): value is string => typeof value === 'string');

  for (const value of values) {
    for (const match of value.matchAll(/\$\{(variables|secrets)\.([A-Za-z0-9_-]+)\}/g)) {
      const namespace = match[1];
      const key = match[2];
      if (namespace === 'variables') {
        variables.add(key);
      } else if (namespace === 'secrets') {
        secrets.add(key);
      }
    }
  }

  return {
    variables: Array.from(variables.values()).sort((left, right) => left.localeCompare(right)),
    secrets: Array.from(secrets.values()).sort((left, right) => left.localeCompare(right)),
  };
}

function toDisplayPath(rootDir: string, filePath: string): string {
  const relative = path.relative(rootDir, filePath);
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join('/');
  }
  return filePath.split(path.sep).join('/');
}

function selectPreviewScreenshotPath(
  steps: AgentAction[],
): string | undefined {
  const failedScreenshot = steps.find((step) => !step.success && step.screenshotFile);
  if (failedScreenshot?.screenshotFile) {
    return failedScreenshot.screenshotFile;
  }
  return steps.find((step) => step.screenshotFile)?.screenshotFile;
}

function findRunFirstFailure(
  tests: TestResult[],
  diagnosticsSummary?: string,
): FirstFailure | undefined {
  const failedTest = tests.find((test) => !test.success);
  if (failedTest?.firstFailure) {
    return failedTest.firstFailure;
  }
  if (failedTest) {
    return {
      testId: failedTest.testId,
      testName: failedTest.testName,
      message: failedTest.message,
      screenshotPath: failedTest.previewScreenshotPath,
    };
  }
  if (diagnosticsSummary) {
    return { message: diagnosticsSummary };
  }
  return undefined;
}

function toAgentAction(
  step: AgentActionResult,
  params: {
    stepNumber: number;
    bindings: RuntimeBindings;
    screenshotFile?: string;
    videoOffsetMs?: number;
    stepJsonFile: string;
  },
): AgentAction & { stepJsonFile: string } {
  return {
    stepNumber: params.stepNumber,
    iteration: step.iteration,
    actionType: step.action,
    naturalLanguageAction: redactResolvedValue(
      step.naturalLanguageAction || step.reason,
      params.bindings,
    ) ?? step.naturalLanguageAction ?? step.reason,
    reason: redactResolvedValue(step.reason, params.bindings) ?? step.reason,
    analysis: redactResolvedValue(step.analysis, params.bindings),
    thought: step.thought
      ? {
          plan: redactResolvedValue(step.thought.plan, params.bindings),
          think: redactResolvedValue(step.thought.think, params.bindings),
          act: redactResolvedValue(step.thought.act, params.bindings),
        }
      : undefined,
    actionPayload: step.actionPayload
      ? {
          ...step.actionPayload,
          text: redactResolvedValue(step.actionPayload.text, params.bindings),
          url: redactResolvedValue(step.actionPayload.url, params.bindings),
        }
      : undefined,
    success: step.success,
    status: step.success ? 'success' : 'failure',
    errorMessage: redactResolvedValue(step.errorMessage, params.bindings),
    durationMs: step.durationMs,
    timestamp: step.timestamp ?? new Date().toISOString(),
    screenshotFile: params.screenshotFile,
    videoOffsetMs: params.videoOffsetMs,
    stepJsonFile: params.stepJsonFile,
    timing: redactTiming(step.timing, params.bindings),
    trace: redactTrace(step.trace, params.bindings),
  };
}

function computeVideoOffsetMs(
  stepTimestamp: string | undefined,
  recordingStartedAt: string | undefined,
): number | undefined {
  if (!stepTimestamp || !recordingStartedAt) {
    return undefined;
  }

  const stepTimeMs = new Date(stepTimestamp).getTime();
  const recordingStartMs = new Date(recordingStartedAt).getTime();
  if (!Number.isFinite(stepTimeMs) || !Number.isFinite(recordingStartMs)) {
    return undefined;
  }

  return Math.max(0, stepTimeMs - recordingStartMs);
}

function decodeScreenshot(value: string): Buffer {
  const normalized = value.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '');
  try {
    const buffer = Buffer.from(normalized, 'base64');
    if (buffer.length > 0) {
      return buffer;
    }
  } catch {
    // Fall through to raw write below.
  }

  return Buffer.from(value, 'utf-8');
}

function redactTrace(
  trace: AgentActionResult['trace'],
  bindings: RuntimeBindings,
): AgentAction['trace'] {
  if (!trace) {
    return undefined;
  }

  return {
    ...trace,
    failureReason: redactResolvedValue(trace.failureReason, bindings),
    spans: trace.spans.map((span) => ({
      ...span,
      detail: redactResolvedValue(span.detail, bindings),
    })),
  };
}

function redactTiming(
  timing: AgentActionResult['timing'],
  bindings: RuntimeBindings,
): AgentAction['timing'] {
  if (!timing) {
    return undefined;
  }

  return {
    ...timing,
    spans: timing.spans.map((span) => ({
      ...span,
      detail: redactResolvedValue(span.detail, bindings),
    })),
  };
}
