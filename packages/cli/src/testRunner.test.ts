import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  Logger,
  redactResolvedValue,
  type LoggerSink,
  type TestDefinition,
  type RuntimeBindings,
} from '@finalrun/common';
import type { TestExecutionResult } from '@finalrun/goal-executor';
import { ReportWriter } from './reportWriter.js';
import { DevicePreparationError } from './sessionRunner.js';
import {
  PreExecutionFailureError,
  runTests,
  selectExecutionPlatform,
  testRunnerDependencies,
} from './testRunner.js';
import { resolveWorkspace } from '@finalrun/common';

function createDevice(platform: string): { getPlatform(): string } {
  return {
    getPlatform() {
      return platform;
    },
  };
}

function createTestExecutionResult(params?: Partial<TestExecutionResult>): TestExecutionResult {
  const result = {
    success: true,
    message: 'Opened the app successfully.',
    analysis: 'The flow completed successfully.',
    platform: 'android',
    startedAt: '2026-03-17T18:00:00.000Z',
    completedAt: '2026-03-17T18:00:01.000Z',
    totalIterations: 1,
    steps: [
      {
        iteration: 1,
        action: 'tap',
        reason: 'Open the app.',
        naturalLanguageAction: 'Step 1: Open the app.',
        analysis: 'Opened the app from the home screen.',
        thought: {
          plan: 'Bring the app to the foreground.',
          think: 'The flow is ready to execute.',
          act: 'Open the app.',
        },
        actionPayload: {},
        success: true,
        timestamp: '2026-03-17T18:00:00.500Z',
        durationMs: 500,
      },
    ],
    ...params,
  };
  return {
    ...result,
    status: result.status ?? (result.success ? 'success' : 'failure'),
  };
}

function createTestSession(params?: { platform?: string; cleanup?: () => Promise<void> }) {
  return {
    platform: params?.platform ?? 'android',
    deviceInfo: {} as never,
    deviceNode: {} as never,
    device: {} as never,
    async cleanup() {
      await params?.cleanup?.();
    },
  };
}

function writeWorkspaceConfig(
  rootDir: string,
  platforms: 'android' | 'ios' | 'both' = 'android',
): void {
  const lines = ['app:'];
  if (platforms === 'android' || platforms === 'both') {
    lines.push('  packageName: org.wikipedia');
  }
  if (platforms === 'ios' || platforms === 'both') {
    lines.push('  bundleId: org.wikipedia');
  }
  fs.mkdirSync(path.join(rootDir, '.finalrun'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, '.finalrun', 'config.yaml'), `${lines.join('\n')}\n`, 'utf-8');
}

function createSingleTestWorkspace(prefix: string): string {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  writeWorkspaceConfig(rootDir);
  const testsDir = path.join(rootDir, '.finalrun', 'tests');
  const envDir = path.join(rootDir, '.finalrun', 'env');
  fs.mkdirSync(testsDir, { recursive: true });
  fs.mkdirSync(envDir, { recursive: true });
  fs.writeFileSync(path.join(envDir, 'dev.yaml'), '{}\n', 'utf-8');
  fs.writeFileSync(
    path.join(testsDir, 'login.yaml'),
    ['name: login', 'steps:', '  - Open the login screen.'].join('\n'),
    'utf-8',
  );
  return rootDir;
}

const originalRunHostPreflight = testRunnerDependencies.runHostPreflight;

test.beforeEach(() => {
  testRunnerDependencies.runHostPreflight = async ({ requestedPlatforms }) => ({
    requestedPlatforms,
    checks: [],
  });
});

test.afterEach(() => {
  testRunnerDependencies.runHostPreflight = originalRunHostPreflight;
});

async function assertNoRunArtifacts(cwd: string): Promise<void> {
  const workspace = await resolveWorkspace(cwd);
  const artifactEntries = await fsp.readdir(workspace.artifactsDir).catch(() => []);
  assert.deepEqual(artifactEntries, []);
  await assert.rejects(() => fsp.stat(path.join(workspace.artifactsDir, 'runs.json')));
}

test('selectExecutionPlatform requires an explicit platform when Android and iOS devices are both available', () => {
  assert.throws(
    () => selectExecutionPlatform([createDevice('android'), createDevice('ios')]),
    /Choose --platform android or --platform ios/,
  );
});

test('selectExecutionPlatform honors the requested platform when it is available', () => {
  const platform = selectExecutionPlatform([createDevice('android'), createDevice('ios')], 'ios');

  assert.equal(platform, 'ios');
});

test('redactResolvedValue preserves complete placeholders when secrets overlap', () => {
  const redacted = redactResolvedValue('primary=abcd secondary=abc', {
    secrets: {
      short: 'abc',
      long: 'abcd',
    },
    variables: {},
  });

  assert.equal(redacted, 'primary=${secrets.long} secondary=${secrets.short}');
});

test('ReportWriter emits redacted JSON artifacts and input snapshots without persisted HTML', async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-report-'));
  const workspaceRoot = path.join(runDir, 'workspace');
  const testSourcePath = path.join(workspaceRoot, '.finalrun', 'tests', 'auth', 'login.yaml');
  const envPath = path.join(workspaceRoot, '.finalrun', 'env', 'staging.yaml');
  const writer = new ReportWriter({
    runDir,
    envName: 'staging',
    platform: 'android',
    runId: '2026-03-16T10-30-00.000Z-staging-android',
    bindings: {
      secrets: {
        email: 'person@example.com',
      },
      variables: {
        language: 'Spanish',
      },
    },
  });

  const bindings: RuntimeBindings = {
    secrets: {
      email: 'person@example.com',
    },
    variables: {
      language: 'Spanish',
    },
  };

  const testDef: TestDefinition = {
    name: 'login',
    description: 'Verify a user can log in.',
    setup: [],
    steps: ['Enter ${secrets.email} on the login screen.'],
    expected_state: ['The feed is visible.'],
    sourcePath: testSourcePath,
    relativePath: 'auth/login.yaml',
    testId: 'auth__login',
  };

  const screenshot = `data:image/jpeg;base64,${Buffer.from('fake-jpeg-data').toString('base64')}`;
  const recordingPath = path.join(runDir, 'source-recording.mp4');
  const goalResult: TestExecutionResult = {
    success: true,
    status: 'success',
    message: 'Entered person@example.com and opened the feed.',
    analysis: 'Entered person@example.com and verified the feed.',
    platform: 'android',
    startedAt: '2026-03-16T10:30:00.000Z',
    completedAt: '2026-03-16T10:30:02.000Z',
    totalIterations: 1,
    recording: {
      filePath: recordingPath,
      startedAt: '2026-03-16T10:30:00.000Z',
      completedAt: '2026-03-16T10:30:02.000Z',
    },
    steps: [
      {
        iteration: 1,
        action: 'input_text',
        reason: 'Enter ${secrets.email} on the login screen.',
        naturalLanguageAction: 'Step 1: Enter ${secrets.email}.',
        analysis: 'Typed person@example.com into the email field.',
        thought: {
          plan: 'Focus the email field.',
          think: 'Use the stored login credential.',
          act: 'Enter ${secrets.email}.',
        },
        actionPayload: {
          text: 'person@example.com',
          clearText: true,
        },
        success: true,
        screenshot,
        timestamp: '2026-03-16T10:30:01.000Z',
        durationMs: 1200,
        trace: {
          step: 1,
          action: 'input_text',
          status: 'failure',
          totalMs: 1200,
          failureReason: 'Failed after typing person@example.com.',
          spans: [
            {
              name: 'action.prep',
              startMs: 0,
              durationMs: 150,
              status: 'failure',
              detail: 'device rejected person@example.com',
            },
          ],
        },
        timing: {
          totalMs: 1200,
          spans: [
            {
              name: 'action.device',
              durationMs: 900,
              status: 'failure',
              detail: 'driver echoed person@example.com',
            },
          ],
        },
      },
    ],
  };

  try {
    await fsp.mkdir(path.dirname(testSourcePath), { recursive: true });
    await fsp.mkdir(path.dirname(envPath), { recursive: true });
    await fsp.writeFile(
      testSourcePath,
      [
        'name: login',
        'description: Verify a user can log in.',
        'steps:',
        '  - Enter ${secrets.email} on the login screen.',
        'expected_state:',
        '  - The feed is visible.',
      ].join('\n'),
      'utf-8',
    );
    await fsp.writeFile(
      envPath,
      [
        'secrets:',
        '  email: ${FINALRUN_TEST_EMAIL_SECRET}',
        'variables:',
        '  language: Spanish',
      ].join('\n'),
      'utf-8',
    );
    await fsp.writeFile(recordingPath, 'fake-video-data', 'utf-8');
    await writer.init();
    await writer.writeRunInputs({
      workspaceRoot,
      environment: {
        envName: 'staging',
        envPath,
        config: {
          secrets: {
            email: '${FINALRUN_TEST_EMAIL_SECRET}',
          },
          variables: {
            language: 'Spanish',
          },
        },
        bindings,
        secretReferences: [
          {
            key: 'email',
            envVar: 'FINALRUN_TEST_EMAIL_SECRET',
          },
        ],
      },
      tests: [testDef],
      effectiveGoals: new Map([
        [testDef.testId!, 'Test Name: login\n\nSteps:\n1. Enter ${secrets.email}.'],
      ]),
      target: {
        type: 'direct',
      },
      cli: {
        command: 'finalrun test',
        selectors: ['auth/login.yaml'],
        debug: false,
        maxIterations: 110,
      },
      model: {
        provider: 'openai',
        modelName: 'gpt-5.4-mini',
        label: 'openai/gpt-5.4-mini',
      },
      app: {
        source: 'repo',
        label: 'repo app',
      },
    });
    writer.appendLogLine('report writer smoke check for person@example.com');
    writer.createLoggerSink()({
      level: 1,
      levelName: 'INFO',
      message: 'Planner failed for person@example.com',
      args: [],
      renderedMessage: '[finalrun] Planner failed for person@example.com',
      timestamp: '2026-03-16T10:30:00.500Z',
      tag: 'finalrun',
    });

    const testRecord = await writer.writeTestRecord(testDef, goalResult, bindings);
    await writer.finalize({
      startedAt: goalResult.startedAt,
      completedAt: goalResult.completedAt,
      tests: [testRecord],
    });

    const stepJsonPath = path.join(runDir, 'tests', 'auth__login', 'actions', '001.json');
    const screenshotPath = path.join(runDir, 'tests', 'auth__login', 'screenshots', '001.jpg');
    const recordingArtifactPath = path.join(runDir, 'tests', 'auth__login', 'recording.mp4');
    const resultJsonPath = path.join(runDir, 'tests', 'auth__login', 'result.json');
    const summaryJsonPath = path.join(runDir, 'summary.json');
    const runJsonPath = path.join(runDir, 'run.json');
    const runnerLogPath = path.join(runDir, 'runner.log');
    const testSnapshotYamlPath = path.join(runDir, 'input', 'tests', 'auth__login.yaml');
    const testSnapshotJsonPath = path.join(runDir, 'input', 'tests', 'auth__login.json');
    const envSnapshotYamlPath = path.join(runDir, 'input', 'env.snapshot.yaml');
    const envSnapshotJsonPath = path.join(runDir, 'input', 'env.json');

    for (const target of [
      stepJsonPath,
      screenshotPath,
      recordingArtifactPath,
      resultJsonPath,
      summaryJsonPath,
      runJsonPath,
      runnerLogPath,
      testSnapshotYamlPath,
      testSnapshotJsonPath,
      envSnapshotYamlPath,
      envSnapshotJsonPath,
    ]) {
      const stats = await fsp.stat(target);
      assert.equal(stats.isFile(), true);
    }

    const stepJson = await fsp.readFile(stepJsonPath, 'utf-8');
    const runJson = await fsp.readFile(runJsonPath, 'utf-8');
    const runnerLog = await fsp.readFile(runnerLogPath, 'utf-8');

    assert.equal(stepJson.includes('person@example.com'), false);
    assert.equal(stepJson.includes('${secrets.email}'), true);
    assert.equal(runJson.includes('person@example.com'), false);
    assert.equal(runJson.includes('${secrets.email}'), true);
    assert.equal(stepJson.includes('driver echoed ${secrets.email}'), true);
    assert.equal(runJson.includes('"target": {\n      "type": "direct"'), true);
    assert.equal(stepJson.includes('"videoOffsetMs": 1000'), true);
    assert.equal(runnerLog.includes('person@example.com'), false);
    assert.equal(runnerLog.includes('${secrets.email}'), true);
    await assert.rejects(() => fsp.stat(path.join(runDir, 'index.html')));
  } finally {
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test('ReportWriter persists suite snapshots and suite metadata without changing per-test result files', async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-suite-report-'));
  const workspaceRoot = path.join(runDir, 'workspace');
  const testSourcePath = path.join(
    workspaceRoot,
    '.finalrun',
    'tests',
    'login',
    'valid_login.yaml',
  );
  const suiteSourcePath = path.join(workspaceRoot, '.finalrun', 'suites', 'login_suite.yaml');
  const writer = new ReportWriter({
    runDir,
    envName: 'none',
    platform: 'android',
    runId: '2026-03-24T08-10-11.000Z-none-android',
    bindings: {
      secrets: {},
      variables: {},
    },
  });

  const testDef: TestDefinition = {
    name: 'valid login',
    setup: [],
    steps: ['Open login.', 'Submit valid credentials.'],
    expected_state: ['The dashboard is visible.'],
    sourcePath: testSourcePath,
    relativePath: 'login/valid_login.yaml',
    testId: 'login__valid_login',
  };

  try {
    await fsp.mkdir(path.dirname(testSourcePath), { recursive: true });
    await fsp.mkdir(path.dirname(suiteSourcePath), { recursive: true });
    await fsp.writeFile(
      testSourcePath,
      [
        'name: valid login',
        'steps:',
        '  - Open login.',
        '  - Submit valid credentials.',
        'expected_state:',
        '  - The dashboard is visible.',
      ].join('\n'),
      'utf-8',
    );
    await fsp.writeFile(
      suiteSourcePath,
      [
        'name: login suite',
        'description: Covers login and dashboard smoke paths.',
        'tests:',
        '  - login/valid_login.yaml',
        '  - dashboard/**',
      ].join('\n'),
      'utf-8',
    );
    await writer.init();
    await writer.writeRunInputs({
      workspaceRoot,
      environment: {
        envName: 'none',
        config: {
          secrets: {},
          variables: {},
        },
        bindings: {
          secrets: {},
          variables: {},
        },
        secretReferences: [],
      },
      tests: [testDef],
      suite: {
        name: 'login suite',
        description: 'Covers login and dashboard smoke paths.',
        tests: ['login/valid_login.yaml', 'dashboard/**'],
        sourcePath: suiteSourcePath,
        relativePath: 'login_suite.yaml',
        suiteId: 'login_suite',
      },
      effectiveGoals: new Map([
        [
          testDef.testId!,
          'Test Name: valid login\n\nSteps:\n1. Open login.\n2. Submit valid credentials.',
        ],
      ]),
      target: {
        type: 'suite',
        suiteId: 'login_suite',
        suiteName: 'login suite',
        suitePath: 'login_suite.yaml',
      },
      cli: {
        command: 'finalrun suite login_suite.yaml',
        selectors: [],
        suitePath: 'login_suite.yaml',
        debug: false,
      },
      model: {
        provider: 'openai',
        modelName: 'gpt-5.4-mini',
        label: 'openai/gpt-5.4-mini',
      },
      app: {
        source: 'repo',
        label: 'repo app',
      },
    });

    const testRecord = await writer.writeTestRecord(testDef, createTestExecutionResult(), {
      secrets: {},
      variables: {},
    });
    await writer.finalize({
      startedAt: '2026-03-24T08:10:11.000Z',
      completedAt: '2026-03-24T08:10:20.000Z',
      tests: [testRecord],
      successOverride: true,
    });

    const suiteSnapshotYamlPath = path.join(runDir, 'input', 'suite.snapshot.yaml');
    const suiteSnapshotJsonPath = path.join(runDir, 'input', 'suite.json');
    const runJsonPath = path.join(runDir, 'run.json');
    const resultJsonPath = path.join(runDir, 'tests', 'login__valid_login', 'result.json');

    for (const targetPath of [
      suiteSnapshotYamlPath,
      suiteSnapshotJsonPath,
      runJsonPath,
      resultJsonPath,
    ]) {
      const stats = await fsp.stat(targetPath);
      assert.equal(stats.isFile(), true);
    }

    const runJson = JSON.parse(await fsp.readFile(runJsonPath, 'utf-8'));
    const resultJson = JSON.parse(await fsp.readFile(resultJsonPath, 'utf-8'));
    const suiteJson = JSON.parse(await fsp.readFile(suiteSnapshotJsonPath, 'utf-8'));

    assert.deepEqual(runJson.run.target, {
      type: 'suite',
      suiteId: 'login_suite',
      suiteName: 'login suite',
      suitePath: 'login_suite.yaml',
    });
    assert.equal(runJson.input.suite.name, 'login suite');
    assert.equal(runJson.input.suite.description, 'Covers login and dashboard smoke paths.');
    assert.deepEqual(runJson.input.suite.tests, ['login/valid_login.yaml', 'dashboard/**']);
    assert.deepEqual(runJson.input.suite.resolvedTestIds, ['login__valid_login']);
    assert.equal(suiteJson.description, 'Covers login and dashboard smoke paths.');
    assert.equal(suiteJson.snapshotYamlPath, 'input/suite.snapshot.yaml');
    assert.equal(resultJson.suiteName, undefined);
    await assert.rejects(() => fsp.stat(path.join(runDir, 'index.html')));
  } finally {
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test('ReportWriter reuses artifact-local recording files without duplicating the copy step', async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-artifact-recording-'));
  const writer = new ReportWriter({
    runDir,
    envName: 'none',
    platform: 'android',
    runId: '2026-03-24T08-10-11.000Z-none-android',
    bindings: {
      secrets: {},
      variables: {},
    },
  });
  const testDef: TestDefinition = {
    name: 'login',
    description: 'Verify login.',
    setup: [],
    steps: ['Open login.'],
    expected_state: ['The dashboard is visible.'],
    sourcePath: path.join(runDir, 'workspace', '.finalrun', 'tests', 'login.yaml'),
    relativePath: 'login.yaml',
    testId: 'login',
  };
  const recordingPath = path.join(runDir, 'tests', 'login', 'recording.mp4');

  try {
    await writer.init();
    await fsp.mkdir(path.dirname(recordingPath), { recursive: true });
    await fsp.writeFile(recordingPath, 'artifact-native-recording', 'utf-8');

    const testRecord = await writer.writeTestRecord(
      testDef,
      createTestExecutionResult({
        recording: {
          filePath: recordingPath,
          startedAt: '2026-03-17T18:00:00.000Z',
          completedAt: '2026-03-17T18:00:01.000Z',
        },
      }),
      {
        secrets: {},
        variables: {},
      },
    );

    assert.equal(testRecord.recordingFile, 'tests/login/recording.mp4');
    assert.equal(await fsp.readFile(recordingPath, 'utf-8'), 'artifact-native-recording');
  } finally {
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test('runTests finalizes top-level artifacts when shared-session execution throws before a test completes', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-runner-'));
  writeWorkspaceConfig(rootDir);
  const testsDir = path.join(rootDir, '.finalrun', 'tests');
  const envDir = path.join(rootDir, '.finalrun', 'env');
  const secretEnvVar = 'FINALRUN_TEST_EMAIL_SECRET';
  const previousSecret = process.env[secretEnvVar];
  process.env[secretEnvVar] = 'person@example.com';
  fs.mkdirSync(testsDir, { recursive: true });
  fs.mkdirSync(envDir, { recursive: true });
  fs.writeFileSync(
    path.join(envDir, 'dev.yaml'),
    ['secrets:', `  email: \${${secretEnvVar}}`].join('\n'),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(testsDir, 'login.yaml'),
    ['name: login', 'steps:', '  - Enter ${secrets.email} on the login screen.'].join('\n'),
    'utf-8',
  );

  const originalPrepareTestSession = testRunnerDependencies.prepareTestSession;
  const originalExecuteTestOnSession = testRunnerDependencies.executeTestOnSession;
  let cleanupCalls = 0;

  testRunnerDependencies.prepareTestSession = async () =>
    createTestSession({
      cleanup: async () => {
        cleanupCalls += 1;
      },
    });
  testRunnerDependencies.executeTestOnSession = async () => {
    throw new Error('Driver failed for person@example.com before goal completion');
  };

  try {
    const result = await runTests({
      envName: 'dev',
      cwd: rootDir,
      selectors: ['login.yaml'],
      apiKeys: { openai: 'test-key' },
      defaults: { provider: 'openai', modelName: 'gpt-5.4-mini' },
    });

    assert.equal(result.success, false);
    assert.equal(result.testResults.length, 1);
    assert.equal(result.testResults[0]?.success, false);
    assert.equal(
      result.testResults[0]?.message,
      'Driver failed for ${secrets.email} before goal completion',
    );

    const summaryPath = path.join(result.runDir, 'summary.json');
    const runJsonPath = path.join(result.runDir, 'run.json');
    const resultPath = path.join(result.runDir, 'tests', 'login', 'result.json');
    const stepPath = path.join(result.runDir, 'tests', 'login', 'actions', '001.json');
    const screenshotPath = path.join(result.runDir, 'tests', 'login', 'screenshots', '001.jpg');
    const runnerLogPath = path.join(result.runDir, 'runner.log');

    for (const target of [
      summaryPath,
      runJsonPath,
      resultPath,
      stepPath,
      screenshotPath,
      runnerLogPath,
      result.runIndexPath,
    ]) {
      const stats = await fsp.stat(target);
      assert.equal(stats.isFile(), true);
    }

    const summaryJson = await fsp.readFile(summaryPath, 'utf-8');
    const testResultJson = await fsp.readFile(resultPath, 'utf-8');
    const stepJson = await fsp.readFile(stepPath, 'utf-8');
    const runnerLog = await fsp.readFile(runnerLogPath, 'utf-8');

    assert.equal(summaryJson.includes('person@example.com'), false);
    assert.equal(summaryJson.includes('${secrets.email}'), false);
    for (const content of [testResultJson, stepJson, runnerLog]) {
      assert.equal(content.includes('person@example.com'), false);
      assert.equal(content.includes('${secrets.email}'), true);
    }
    await assert.rejects(() => fsp.stat(path.join(result.runDir, 'index.html')));
  } finally {
    testRunnerDependencies.prepareTestSession = originalPrepareTestSession;
    testRunnerDependencies.executeTestOnSession = originalExecuteTestOnSession;
    assert.equal(cleanupCalls, 1);
    await fsp.rm(rootDir, { recursive: true, force: true });
    if (previousSecret === undefined) {
      delete process.env[secretEnvVar];
    } else {
      process.env[secretEnvVar] = previousSecret;
    }
  }
});

test('runTests succeeds without env config when the repo is env-free', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-env-free-runner-'));
  writeWorkspaceConfig(rootDir);
  const testsDir = path.join(rootDir, '.finalrun', 'tests');
  fs.mkdirSync(testsDir, { recursive: true });
  fs.writeFileSync(
    path.join(testsDir, 'smoke.yaml'),
    ['name: smoke', 'steps:', '  - Open the app.'].join('\n'),
    'utf-8',
  );

  const originalPrepareTestSession = testRunnerDependencies.prepareTestSession;
  const originalExecuteTestOnSession = testRunnerDependencies.executeTestOnSession;
  let cleanupCalls = 0;

  testRunnerDependencies.prepareTestSession = async () =>
    createTestSession({
      cleanup: async () => {
        cleanupCalls += 1;
      },
    });
  testRunnerDependencies.executeTestOnSession = async () =>
    createTestExecutionResult({
      analysis: 'The env-free smoke flow completed successfully.',
    });

  try {
    const result = await runTests({
      cwd: rootDir,
      selectors: ['smoke.yaml'],
      apiKeys: { openai: 'test-key' },
      defaults: { provider: 'openai', modelName: 'gpt-5.4-mini' },
    });

    assert.equal(result.success, true);
    assert.equal(result.testResults.length, 1);
    assert.match(result.runDir, /-none-android$/);

    const summaryPath = path.join(result.runDir, 'summary.json');
    const runJsonPath = path.join(result.runDir, 'run.json');
    const runnerLogPath = path.join(result.runDir, 'runner.log');

    for (const target of [summaryPath, runJsonPath, runnerLogPath, result.runIndexPath]) {
      const stats = await fsp.stat(target);
      assert.equal(stats.isFile(), true);
    }
    await assert.rejects(() => fsp.stat(path.join(result.runDir, 'index.html')));
  } finally {
    testRunnerDependencies.prepareTestSession = originalPrepareTestSession;
    testRunnerDependencies.executeTestOnSession = originalExecuteTestOnSession;
    assert.equal(cleanupCalls, 1);
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runTests records the suite subcommand in run metadata when invoked via finalrun suite', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-suite-command-'));
  writeWorkspaceConfig(rootDir);
  const testsDir = path.join(rootDir, '.finalrun', 'tests');
  const suitesDir = path.join(rootDir, '.finalrun', 'suites');
  fs.mkdirSync(testsDir, { recursive: true });
  fs.mkdirSync(suitesDir, { recursive: true });
  fs.writeFileSync(
    path.join(testsDir, 'smoke.yaml'),
    ['name: smoke', 'steps:', '  - Open the app.'].join('\n'),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(suitesDir, 'smoke.yaml'),
    ['name: smoke suite', 'tests:', '  - smoke.yaml'].join('\n'),
    'utf-8',
  );

  const originalPrepareTestSession = testRunnerDependencies.prepareTestSession;
  const originalExecuteTestOnSession = testRunnerDependencies.executeTestOnSession;
  let cleanupCalls = 0;

  testRunnerDependencies.prepareTestSession = async () =>
    createTestSession({
      cleanup: async () => {
        cleanupCalls += 1;
      },
    });
  testRunnerDependencies.executeTestOnSession = async () => createTestExecutionResult();

  try {
    const result = await runTests({
      cwd: rootDir,
      suitePath: 'smoke.yaml',
      apiKeys: { openai: 'test-key' },
      defaults: { provider: 'openai', modelName: 'gpt-5.4-mini' },
      invokedCommand: 'suite',
    });

    const runJson = JSON.parse(await fsp.readFile(path.join(result.runDir, 'run.json'), 'utf-8'));
    assert.equal(runJson.input.cli.command, 'finalrun suite smoke.yaml');
    assert.equal(runJson.input.cli.suitePath, 'smoke.yaml');
    assert.deepEqual(runJson.input.cli.selectors, []);
  } finally {
    testRunnerDependencies.prepareTestSession = originalPrepareTestSession;
    testRunnerDependencies.executeTestOnSession = originalExecuteTestOnSession;
    assert.equal(cleanupCalls, 1);
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runTests prepares one shared session for multiple tests and cleans it up once', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-shared-session-'));
  writeWorkspaceConfig(rootDir);
  const testsDir = path.join(rootDir, '.finalrun', 'tests');
  const envDir = path.join(rootDir, '.finalrun', 'env');
  fs.mkdirSync(testsDir, { recursive: true });
  fs.mkdirSync(envDir, { recursive: true });
  fs.writeFileSync(path.join(envDir, 'dev.yaml'), '{}\n', 'utf-8');
  fs.writeFileSync(
    path.join(testsDir, 'login.yaml'),
    ['name: login', 'steps:', '  - Open the login screen.'].join('\n'),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(testsDir, 'search.yaml'),
    ['name: search', 'steps:', '  - Search Wikipedia.'].join('\n'),
    'utf-8',
  );

  const originalPrepareTestSession = testRunnerDependencies.prepareTestSession;
  const originalExecuteTestOnSession = testRunnerDependencies.executeTestOnSession;
  let prepareCalls = 0;
  let cleanupCalls = 0;
  const executedCases: string[] = [];
  const recordingOutputPaths: string[] = [];
  const keepPartialFlags: boolean[] = [];

  testRunnerDependencies.prepareTestSession = async () => {
    prepareCalls += 1;
    return createTestSession({
      cleanup: async () => {
        cleanupCalls += 1;
      },
    });
  };
  testRunnerDependencies.executeTestOnSession = async (_session, config) => {
    if (config.recording) {
      executedCases.push(config.recording.testId);
      recordingOutputPaths.push(config.recording.outputFilePath ?? '');
      keepPartialFlags.push(config.recording.keepPartialOnFailure ?? false);
    }
    return createTestExecutionResult();
  };

  try {
    const result = await runTests({
      envName: 'dev',
      cwd: rootDir,
      selectors: ['login.yaml', 'search.yaml'],
      apiKeys: { openai: 'test-key' },
      defaults: { provider: 'openai', modelName: 'gpt-5.4-mini' },
    });

    assert.equal(result.success, true);
    assert.equal(result.testResults.length, 2);
    assert.equal(prepareCalls, 1);
    assert.equal(cleanupCalls, 1);
    assert.deepEqual(executedCases, ['login', 'search']);
    assert.deepEqual(recordingOutputPaths, [
      path.join(result.runDir, 'tests', 'login', 'recording.mp4'),
      path.join(result.runDir, 'tests', 'search', 'recording.mp4'),
    ]);
    assert.deepEqual(keepPartialFlags, [true, true]);
  } finally {
    testRunnerDependencies.prepareTestSession = originalPrepareTestSession;
    testRunnerDependencies.executeTestOnSession = originalExecuteTestOnSession;
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runTests uses mov artifact recording output paths for iOS tests', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-ios-recording-output-'));
  writeWorkspaceConfig(rootDir, 'ios');
  const testsDir = path.join(rootDir, '.finalrun', 'tests');
  const envDir = path.join(rootDir, '.finalrun', 'env');
  fs.mkdirSync(testsDir, { recursive: true });
  fs.mkdirSync(envDir, { recursive: true });
  fs.writeFileSync(path.join(envDir, 'dev.yaml'), '{}\n', 'utf-8');
  fs.writeFileSync(
    path.join(testsDir, 'login.yaml'),
    ['name: login', 'steps:', '  - Open the login screen.'].join('\n'),
    'utf-8',
  );

  const originalPrepareTestSession = testRunnerDependencies.prepareTestSession;
  const originalExecuteTestOnSession = testRunnerDependencies.executeTestOnSession;
  const recordingConfigs: Array<{
    testId: string;
    outputFilePath?: string;
    keepPartialOnFailure?: boolean;
  }> = [];

  testRunnerDependencies.prepareTestSession = async () => createTestSession({ platform: 'ios' });
  testRunnerDependencies.executeTestOnSession = async (_session, config) => {
    if (config.recording) {
      recordingConfigs.push({
        testId: config.recording.testId,
        outputFilePath: config.recording.outputFilePath,
        keepPartialOnFailure: config.recording.keepPartialOnFailure,
      });
    }
    return createTestExecutionResult({ platform: 'ios' });
  };

  try {
    const result = await runTests({
      envName: 'dev',
      cwd: rootDir,
      selectors: ['login.yaml'],
      platform: 'ios',
      apiKeys: { openai: 'test-key' },
      defaults: { provider: 'openai', modelName: 'gpt-5.4-mini' },
    });

    assert.equal(result.success, true);
    assert.deepEqual(recordingConfigs, [
      {
        testId: 'login',
        outputFilePath: path.join(result.runDir, 'tests', 'login', 'recording.mov'),
        keepPartialOnFailure: true,
      },
    ]);
  } finally {
    testRunnerDependencies.prepareTestSession = originalPrepareTestSession;
    testRunnerDependencies.executeTestOnSession = originalExecuteTestOnSession;
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runTests stops the batch after a shared-session failure and cleans up once', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-shared-session-failure-'));
  writeWorkspaceConfig(rootDir);
  const testsDir = path.join(rootDir, '.finalrun', 'tests');
  const envDir = path.join(rootDir, '.finalrun', 'env');
  fs.mkdirSync(testsDir, { recursive: true });
  fs.mkdirSync(envDir, { recursive: true });
  fs.writeFileSync(path.join(envDir, 'dev.yaml'), '{}\n', 'utf-8');
  fs.writeFileSync(
    path.join(testsDir, 'first.yaml'),
    ['name: first', 'steps:', '  - Open first flow.'].join('\n'),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(testsDir, 'second.yaml'),
    ['name: second', 'steps:', '  - Open second flow.'].join('\n'),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(testsDir, 'third.yaml'),
    ['name: third', 'steps:', '  - Open third flow.'].join('\n'),
    'utf-8',
  );

  const originalPrepareTestSession = testRunnerDependencies.prepareTestSession;
  const originalExecuteTestOnSession = testRunnerDependencies.executeTestOnSession;
  let cleanupCalls = 0;
  const executedCases: string[] = [];

  testRunnerDependencies.prepareTestSession = async () =>
    createTestSession({
      cleanup: async () => {
        cleanupCalls += 1;
      },
    });
  testRunnerDependencies.executeTestOnSession = async (_session, config) => {
    const testId = config.recording?.testId ?? 'unknown';
    executedCases.push(testId);
    if (testId === 'second') {
      throw new Error('gRPC client not connected');
    }
    return createTestExecutionResult();
  };

  try {
    const result = await runTests({
      envName: 'dev',
      cwd: rootDir,
      selectors: ['first.yaml', 'second.yaml', 'third.yaml'],
      apiKeys: { openai: 'test-key' },
      defaults: { provider: 'openai', modelName: 'gpt-5.4-mini' },
    });

    assert.equal(result.success, false);
    assert.equal(result.testResults.length, 2);
    assert.deepEqual(executedCases, ['first', 'second']);
    assert.equal(result.testResults[0]?.success, true);
    assert.equal(result.testResults[1]?.success, false);
    assert.match(result.testResults[1]?.message ?? '', /gRPC client not connected/);
    assert.equal(cleanupCalls, 1);
  } finally {
    testRunnerDependencies.prepareTestSession = originalPrepareTestSession;
    testRunnerDependencies.executeTestOnSession = originalExecuteTestOnSession;
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runTests stops remaining tests after a terminal AI provider failure', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-terminal-provider-failure-'));
  writeWorkspaceConfig(rootDir);
  const testsDir = path.join(rootDir, '.finalrun', 'tests');
  const envDir = path.join(rootDir, '.finalrun', 'env');
  fs.mkdirSync(testsDir, { recursive: true });
  fs.mkdirSync(envDir, { recursive: true });
  fs.writeFileSync(path.join(envDir, 'dev.yaml'), '{}\n', 'utf-8');
  fs.writeFileSync(
    path.join(testsDir, 'first.yaml'),
    ['name: first', 'steps:', '  - Open first flow.'].join('\n'),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(testsDir, 'second.yaml'),
    ['name: second', 'steps:', '  - Open second flow.'].join('\n'),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(testsDir, 'third.yaml'),
    ['name: third', 'steps:', '  - Open third flow.'].join('\n'),
    'utf-8',
  );

  const originalPrepareTestSession = testRunnerDependencies.prepareTestSession;
  const originalExecuteTestOnSession = testRunnerDependencies.executeTestOnSession;
  let cleanupCalls = 0;
  const executedCases: string[] = [];
  const terminalFailureMessage = 'AI provider error (openai/gpt-5.4-mini, HTTP 401): Unauthorized';

  testRunnerDependencies.prepareTestSession = async () =>
    createTestSession({
      cleanup: async () => {
        cleanupCalls += 1;
      },
    });
  testRunnerDependencies.executeTestOnSession = async (_session, config) => {
    const testId = config.recording?.testId ?? 'unknown';
    executedCases.push(testId);
    if (testId === 'second') {
      return createTestExecutionResult({
        success: false,
        status: 'failure',
        message: terminalFailureMessage,
        terminalFailure: {
          kind: 'provider',
          provider: 'openai',
          modelName: 'gpt-5.4-mini',
          statusCode: 401,
          message: terminalFailureMessage,
        },
      });
    }
    if (testId === 'third') {
      throw new Error('Third test should not execute after a terminal provider failure');
    }
    return createTestExecutionResult();
  };

  try {
    const result = await runTests({
      envName: 'dev',
      cwd: rootDir,
      selectors: ['first.yaml', 'second.yaml', 'third.yaml'],
      apiKeys: { openai: 'test-key' },
      defaults: { provider: 'openai', modelName: 'gpt-5.4-mini' },
    });

    assert.equal(result.success, false);
    assert.equal(result.status, 'failure');
    assert.deepEqual(executedCases, ['first', 'second']);
    assert.equal(result.testResults.length, 2);
    assert.equal(result.testResults[1]?.status, 'failure');
    assert.match(result.testResults[1]?.message ?? '', /HTTP 401/);
    assert.equal(cleanupCalls, 1);

    const summary = JSON.parse(
      await fsp.readFile(path.join(result.runDir, 'summary.json'), 'utf-8'),
    ) as {
      status: string;
      tests: Array<{ status: string }>;
    };
    assert.equal(summary.status, 'failure');
    assert.equal(summary.tests.length, 2);
    assert.equal(summary.tests[1]?.status, 'failure');

    const manifest = JSON.parse(
      await fsp.readFile(path.join(result.runDir, 'run.json'), 'utf-8'),
    ) as {
      run: {
        status: string;
        firstFailure?: { message?: string };
      };
      tests: Array<{ status: string }>;
    };
    assert.equal(manifest.run.status, 'failure');
    assert.equal(manifest.tests.length, 2);
    assert.equal(manifest.tests[1]?.status, 'failure');
    assert.match(manifest.run.firstFailure?.message ?? '', /HTTP 401/);

    const runnerLog = await fsp.readFile(path.join(result.runDir, 'runner.log'), 'utf-8');
    assert.match(runnerLog, /Stopping run after terminal AI provider failure/);
    assert.match(runnerLog, /AI provider error \(openai\/gpt-5.4-mini, HTTP 401\): Unauthorized/);
  } finally {
    testRunnerDependencies.prepareTestSession = originalPrepareTestSession;
    testRunnerDependencies.executeTestOnSession = originalExecuteTestOnSession;
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runTests aborts the batch after SIGINT and marks the active run as aborted', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-shared-session-abort-'));
  writeWorkspaceConfig(rootDir);
  const testsDir = path.join(rootDir, '.finalrun', 'tests');
  const envDir = path.join(rootDir, '.finalrun', 'env');
  fs.mkdirSync(testsDir, { recursive: true });
  fs.mkdirSync(envDir, { recursive: true });
  fs.writeFileSync(path.join(envDir, 'dev.yaml'), '{}\n', 'utf-8');
  fs.writeFileSync(
    path.join(testsDir, 'first.yaml'),
    ['name: first', 'steps:', '  - Open first flow.'].join('\n'),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(testsDir, 'second.yaml'),
    ['name: second', 'steps:', '  - Open second flow.'].join('\n'),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(testsDir, 'third.yaml'),
    ['name: third', 'steps:', '  - Open third flow.'].join('\n'),
    'utf-8',
  );

  const originalPrepareTestSession = testRunnerDependencies.prepareTestSession;
  const originalExecuteTestOnSession = testRunnerDependencies.executeTestOnSession;
  const originalAddSigintListener = testRunnerDependencies.addSigintListener;
  let cleanupCalls = 0;
  let sigintListener: (() => void) | undefined;
  const executedCases: string[] = [];

  testRunnerDependencies.addSigintListener = (listener) => {
    sigintListener = listener;
    return () => {
      if (sigintListener === listener) {
        sigintListener = undefined;
      }
    };
  };
  testRunnerDependencies.prepareTestSession = async () =>
    createTestSession({
      cleanup: async () => {
        cleanupCalls += 1;
      },
    });
  testRunnerDependencies.executeTestOnSession = async (_session, config) => {
    const testId = config.recording?.testId ?? 'unknown';
    executedCases.push(testId);
    if (testId === 'first') {
      assert.equal(typeof sigintListener, 'function');
      sigintListener?.();
      assert.equal(config.abortSignal?.aborted, true);
      return createTestExecutionResult({
        success: false,
        status: 'aborted',
        message: 'Goal execution was aborted',
        analysis: 'The run was aborted by the user.',
        totalIterations: 0,
        steps: [],
      });
    }
    return createTestExecutionResult();
  };

  try {
    const result = await runTests({
      envName: 'dev',
      cwd: rootDir,
      selectors: ['first.yaml', 'second.yaml', 'third.yaml'],
      apiKeys: { openai: 'test-key' },
      defaults: { provider: 'openai', modelName: 'gpt-5.4-mini' },
    });

    assert.equal(result.success, false);
    assert.equal(result.status, 'aborted');
    assert.deepEqual(executedCases, ['first']);
    assert.equal(result.testResults.length, 1);
    assert.equal(result.testResults[0]?.status, 'aborted');
    assert.equal(cleanupCalls, 1);

    const summary = JSON.parse(
      await fsp.readFile(path.join(result.runDir, 'summary.json'), 'utf-8'),
    ) as {
      status: string;
      tests: Array<{ status: string }>;
    };
    assert.equal(summary.status, 'aborted');
    assert.equal(summary.tests[0]?.status, 'aborted');

    const manifest = JSON.parse(
      await fsp.readFile(path.join(result.runDir, 'run.json'), 'utf-8'),
    ) as {
      run: { status: string };
      input: { tests: Array<unknown> };
      tests: Array<{ status: string }>;
    };
    assert.equal(manifest.run.status, 'aborted');
    assert.equal(manifest.input.tests.length, 3);
    assert.equal(manifest.tests.length, 1);
    assert.equal(manifest.tests[0]?.status, 'aborted');
  } finally {
    testRunnerDependencies.prepareTestSession = originalPrepareTestSession;
    testRunnerDependencies.executeTestOnSession = originalExecuteTestOnSession;
    testRunnerDependencies.addSigintListener = originalAddSigintListener;
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runTests requests a forced exit after a second SIGINT', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-shared-session-force-exit-'));
  writeWorkspaceConfig(rootDir);
  const testsDir = path.join(rootDir, '.finalrun', 'tests');
  const envDir = path.join(rootDir, '.finalrun', 'env');
  fs.mkdirSync(testsDir, { recursive: true });
  fs.mkdirSync(envDir, { recursive: true });
  fs.writeFileSync(path.join(envDir, 'dev.yaml'), '{}\n', 'utf-8');
  fs.writeFileSync(
    path.join(testsDir, 'first.yaml'),
    ['name: first', 'steps:', '  - Open first flow.'].join('\n'),
    'utf-8',
  );

  const originalPrepareTestSession = testRunnerDependencies.prepareTestSession;
  const originalExecuteTestOnSession = testRunnerDependencies.executeTestOnSession;
  const originalAddSigintListener = testRunnerDependencies.addSigintListener;
  const originalExitProcess = testRunnerDependencies.exitProcess;
  let sigintListener: (() => void) | undefined;
  let forcedExitCode: number | undefined;

  testRunnerDependencies.addSigintListener = (listener) => {
    sigintListener = listener;
    return () => {
      if (sigintListener === listener) {
        sigintListener = undefined;
      }
    };
  };
  testRunnerDependencies.exitProcess = ((code: number) => {
    forcedExitCode = code;
    return undefined as never;
  }) as typeof testRunnerDependencies.exitProcess;
  testRunnerDependencies.prepareTestSession = async () => createTestSession();
  testRunnerDependencies.executeTestOnSession = async () => {
    assert.equal(typeof sigintListener, 'function');
    sigintListener?.();
    sigintListener?.();
    return createTestExecutionResult({
      success: false,
      status: 'aborted',
      message: 'Goal execution was aborted',
      totalIterations: 0,
      steps: [],
    });
  };

  try {
    const result = await runTests({
      envName: 'dev',
      cwd: rootDir,
      selectors: ['first.yaml'],
      apiKeys: { openai: 'test-key' },
      defaults: { provider: 'openai', modelName: 'gpt-5.4-mini' },
    });

    assert.equal(forcedExitCode, 130);
    assert.equal(result.status, 'aborted');
    const runnerLog = await fsp.readFile(path.join(result.runDir, 'runner.log'), 'utf-8');
    assert.match(runnerLog, /Received second SIGINT — forcing exit\./);
  } finally {
    testRunnerDependencies.prepareTestSession = originalPrepareTestSession;
    testRunnerDependencies.executeTestOnSession = originalExecuteTestOnSession;
    testRunnerDependencies.addSigintListener = originalAddSigintListener;
    testRunnerDependencies.exitProcess = originalExitProcess;
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runTests releases the device session when SIGINT arrives during session preparation', async () => {
  const rootDir = createSingleTestWorkspace('finalrun-abort-after-prepare-');

  const originalPrepareTestSession = testRunnerDependencies.prepareTestSession;
  const originalExecuteTestOnSession = testRunnerDependencies.executeTestOnSession;
  const originalAddSigintListener = testRunnerDependencies.addSigintListener;
  let cleanupCalls = 0;
  let executeCalls = 0;
  let sigintListener: (() => void) | undefined;

  testRunnerDependencies.addSigintListener = (listener) => {
    sigintListener = listener;
    return () => {
      if (sigintListener === listener) {
        sigintListener = undefined;
      }
    };
  };
  testRunnerDependencies.prepareTestSession = async () => {
    // SIGINT lands while device preparation is in flight: the prepared
    // session is still handed back, and the runner must release it on the
    // abort path instead of stranding device resources.
    assert.equal(typeof sigintListener, 'function');
    sigintListener?.();
    return createTestSession({
      cleanup: async () => {
        cleanupCalls += 1;
      },
    });
  };
  testRunnerDependencies.executeTestOnSession = async () => {
    executeCalls += 1;
    return createTestExecutionResult();
  };

  try {
    await assert.rejects(
      () =>
        runTests({
          envName: 'dev',
          cwd: rootDir,
          selectors: ['login.yaml'],
          apiKeys: { openai: 'test-key' },
          defaults: { provider: 'openai', modelName: 'gpt-5.4-mini' },
        }),
      (error: unknown) => {
        assert.ok(error instanceof PreExecutionFailureError);
        assert.equal(error.phase, 'setup');
        assert.equal(error.message, 'Run aborted before execution.');
        assert.equal(error.exitCode, 130);
        return true;
      },
    );
    assert.equal(executeCalls, 0);
    assert.equal(cleanupCalls, 1);
    await assertNoRunArtifacts(rootDir);
  } finally {
    testRunnerDependencies.prepareTestSession = originalPrepareTestSession;
    testRunnerDependencies.executeTestOnSession = originalExecuteTestOnSession;
    testRunnerDependencies.addSigintListener = originalAddSigintListener;
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runTests removes every log sink it registered when validation fails before execution', async () => {
  const rootDir = createSingleTestWorkspace('finalrun-sink-cleanup-');

  // Spy on the public Logger sink API (no coupling to Logger internals):
  // every sink added during the run must be removed by the time it settles.
  const originalAddSink = Logger.addSink;
  const originalRemoveSink = Logger.removeSink;
  const danglingSinks = new Set<LoggerSink>();
  Logger.addSink = (sink: LoggerSink): void => {
    danglingSinks.add(sink);
    originalAddSink.call(Logger, sink);
  };
  Logger.removeSink = (sink: LoggerSink): void => {
    danglingSinks.delete(sink);
    originalRemoveSink.call(Logger, sink);
  };

  try {
    await assert.rejects(
      () =>
        runTests({
          envName: 'dev',
          cwd: rootDir,
          apiKeys: { openai: 'test-key' },
          defaults: { provider: 'openai', modelName: 'gpt-5.4-mini' },
        }),
      (error: unknown) => {
        assert.ok(error instanceof PreExecutionFailureError);
        assert.equal(error.phase, 'validation');
        assert.match(error.message, /At least one test selector is required/);
        return true;
      },
    );
    assert.equal(danglingSinks.size, 0);
  } finally {
    Logger.addSink = originalAddSink;
    Logger.removeSink = originalRemoveSink;
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runTests requires base app config even when the env file contains an app override', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-validation-failure-'));
  const testsDir = path.join(rootDir, '.finalrun', 'tests');
  const envDir = path.join(rootDir, '.finalrun', 'env');
  fs.mkdirSync(testsDir, { recursive: true });
  fs.mkdirSync(envDir, { recursive: true });
  fs.writeFileSync(
    path.join(envDir, 'dev.yaml'),
    ['app:', '  packageName: org.wikipedia'].join('\n'),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(testsDir, 'login.yaml'),
    ['name: login', 'steps:', '  - Open the login screen.'].join('\n'),
    'utf-8',
  );

  try {
    await assert.rejects(
      () =>
        runTests({
          envName: 'dev',
          cwd: rootDir,
          selectors: ['login.yaml'],
          apiKeys: { openai: 'test-key' },
          defaults: { provider: 'openai', modelName: 'gpt-5.4-mini' },
        }),
      (error: unknown) => {
        assert.ok(error instanceof PreExecutionFailureError);
        assert.equal(error.phase, 'validation');
        assert.match(
          error.message,
          /\.finalrun\/config\.yaml must define app\.packageName and\/or app\.bundleId/,
        );
        return true;
      },
    );
    await assertNoRunArtifacts(rootDir);
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runTests rejects validation failures before creating run artifacts', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-missing-selectors-'));
  writeWorkspaceConfig(rootDir);
  const testsDir = path.join(rootDir, '.finalrun', 'tests');
  const envDir = path.join(rootDir, '.finalrun', 'env');
  fs.mkdirSync(testsDir, { recursive: true });
  fs.mkdirSync(envDir, { recursive: true });
  fs.writeFileSync(path.join(envDir, 'dev.yaml'), '{}\n', 'utf-8');
  fs.writeFileSync(
    path.join(testsDir, 'login.yaml'),
    ['name: login', 'steps:', '  - Open the login screen.'].join('\n'),
    'utf-8',
  );

  try {
    await assert.rejects(
      () =>
        runTests({
          envName: 'dev',
          cwd: rootDir,
          apiKeys: { openai: 'test-key' },
          defaults: { provider: 'openai', modelName: 'gpt-5.4-mini' },
        }),
      (error: unknown) => {
        assert.ok(error instanceof PreExecutionFailureError);
        assert.equal(error.phase, 'validation');
        assert.match(error.message, /At least one test selector is required/);
        return true;
      },
    );
    await assertNoRunArtifacts(rootDir);
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runTests surfaces device setup diagnostics before execution without creating run artifacts', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-setup-buffering-'));
  writeWorkspaceConfig(rootDir);
  const testsDir = path.join(rootDir, '.finalrun', 'tests');
  const envDir = path.join(rootDir, '.finalrun', 'env');
  fs.mkdirSync(testsDir, { recursive: true });
  fs.mkdirSync(envDir, { recursive: true });
  fs.writeFileSync(path.join(envDir, 'dev.yaml'), '{}\n', 'utf-8');
  fs.writeFileSync(
    path.join(testsDir, 'login.yaml'),
    ['name: login', 'steps:', '  - Open the login screen.'].join('\n'),
    'utf-8',
  );

  const originalPrepareTestSession = testRunnerDependencies.prepareTestSession;

  testRunnerDependencies.prepareTestSession = async () => {
    Logger.i('Buffered setup log before runner.log exists');
    throw new DevicePreparationError('No runnable devices or startable targets were found.', [
      {
        scope: 'android-connected',
        summary: 'Android device discovery failed.',
        blocking: true,
        transcripts: [
          {
            command: 'adb devices -l',
            stdout: '',
            stderr: 'adb executable missing',
            exitCode: 1,
          },
        ],
      },
    ]);
  };

  try {
    await assert.rejects(
      () =>
        runTests({
          envName: 'dev',
          cwd: rootDir,
          selectors: ['login.yaml'],
          apiKeys: { openai: 'test-key' },
          defaults: { provider: 'openai', modelName: 'gpt-5.4-mini' },
        }),
      (error: unknown) => {
        assert.ok(error instanceof PreExecutionFailureError);
        assert.equal(error.phase, 'setup');
        assert.match(error.message, /Run setup failed before execution/);
        assert.match(error.message, /Command: adb devices -l/);
        assert.match(error.message, /stderr:\nadb executable missing/);
        return true;
      },
    );
    await assertNoRunArtifacts(rootDir);
  } finally {
    testRunnerDependencies.prepareTestSession = originalPrepareTestSession;
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runTests fails before prepareGoalSession when Android host preflight is blocked', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-android-preflight-failure-'));
  writeWorkspaceConfig(rootDir);
  const testsDir = path.join(rootDir, '.finalrun', 'tests');
  const envDir = path.join(rootDir, '.finalrun', 'env');
  fs.mkdirSync(testsDir, { recursive: true });
  fs.mkdirSync(envDir, { recursive: true });
  fs.writeFileSync(path.join(envDir, 'dev.yaml'), '{}\n', 'utf-8');
  fs.writeFileSync(
    path.join(testsDir, 'login.yaml'),
    ['name: login', 'steps:', '  - Open the login screen.'].join('\n'),
    'utf-8',
  );

  const originalPrepareTestSession = testRunnerDependencies.prepareTestSession;
  let prepareCalls = 0;
  testRunnerDependencies.prepareTestSession = async () => {
    prepareCalls += 1;
    return createTestSession();
  };
  testRunnerDependencies.runHostPreflight = async ({ requestedPlatforms }) => ({
    requestedPlatforms,
    checks: [
      {
        platform: 'android',
        status: 'error',
        id: 'adb',
        title: 'adb',
        summary: 'Required to communicate with Android devices.',
        detail: 'ADB was not found in ANDROID_HOME, ANDROID_SDK_ROOT, or PATH.',
        blocking: true,
      },
    ],
  });

  try {
    await assert.rejects(
      () =>
        runTests({
          envName: 'dev',
          cwd: rootDir,
          selectors: ['login.yaml'],
          platform: 'android',
          apiKeys: { openai: 'test-key' },
          defaults: { provider: 'openai', modelName: 'gpt-5.4-mini' },
        }),
      (error: unknown) => {
        assert.ok(error instanceof PreExecutionFailureError);
        assert.equal(error.phase, 'setup');
        assert.match(error.message, /Local device setup is blocked for android\./i);
        assert.match(error.message, /finalrun doctor --platform android/);
        return true;
      },
    );
    assert.equal(prepareCalls, 0);
    await assertNoRunArtifacts(rootDir);
  } finally {
    testRunnerDependencies.prepareTestSession = originalPrepareTestSession;
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runTests fails before prepareGoalSession when iOS host preflight is blocked', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-ios-preflight-failure-'));
  writeWorkspaceConfig(rootDir, 'ios');
  const testsDir = path.join(rootDir, '.finalrun', 'tests');
  const envDir = path.join(rootDir, '.finalrun', 'env');
  fs.mkdirSync(testsDir, { recursive: true });
  fs.mkdirSync(envDir, { recursive: true });
  fs.writeFileSync(path.join(envDir, 'dev.yaml'), '{}\n', 'utf-8');
  fs.writeFileSync(
    path.join(testsDir, 'login.yaml'),
    ['name: login', 'steps:', '  - Open the login screen.'].join('\n'),
    'utf-8',
  );

  const originalPrepareTestSession = testRunnerDependencies.prepareTestSession;
  let prepareCalls = 0;
  testRunnerDependencies.prepareTestSession = async () => {
    prepareCalls += 1;
    return createTestSession({ platform: 'ios' });
  };
  testRunnerDependencies.runHostPreflight = async ({ requestedPlatforms }) => ({
    requestedPlatforms,
    checks: [
      {
        platform: 'ios',
        status: 'error',
        id: 'xcrun',
        title: 'xcrun',
        summary: 'Required to access iOS simulator tooling.',
        detail: 'xcrun was not found in PATH.',
        blocking: true,
      },
    ],
  });

  try {
    await assert.rejects(
      () =>
        runTests({
          envName: 'dev',
          cwd: rootDir,
          selectors: ['login.yaml'],
          platform: 'ios',
          apiKeys: { openai: 'test-key' },
          defaults: { provider: 'openai', modelName: 'gpt-5.4-mini' },
        }),
      (error: unknown) => {
        assert.ok(error instanceof PreExecutionFailureError);
        assert.equal(error.phase, 'setup');
        assert.match(error.message, /Local device setup is blocked for ios\./i);
        assert.match(error.message, /finalrun doctor --platform ios/);
        return true;
      },
    );
    assert.equal(prepareCalls, 0);
    await assertNoRunArtifacts(rootDir);
  } finally {
    testRunnerDependencies.prepareTestSession = originalPrepareTestSession;
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runTests continues when one platform is healthy and the other is blocked', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-preflight-partial-'));
  writeWorkspaceConfig(rootDir, 'ios');
  const testsDir = path.join(rootDir, '.finalrun', 'tests');
  const envDir = path.join(rootDir, '.finalrun', 'env');
  fs.mkdirSync(testsDir, { recursive: true });
  fs.mkdirSync(envDir, { recursive: true });
  fs.writeFileSync(path.join(envDir, 'dev.yaml'), '{}\n', 'utf-8');
  fs.writeFileSync(
    path.join(testsDir, 'login.yaml'),
    ['name: login', 'steps:', '  - Open the login screen.'].join('\n'),
    'utf-8',
  );

  const originalPrepareTestSession = testRunnerDependencies.prepareTestSession;
  const originalExecuteTestOnSession = testRunnerDependencies.executeTestOnSession;
  let prepareCalls = 0;
  testRunnerDependencies.prepareTestSession = async () => {
    prepareCalls += 1;
    return createTestSession({ platform: 'ios' });
  };
  testRunnerDependencies.executeTestOnSession = async () =>
    createTestExecutionResult({
      platform: 'ios',
    });
  testRunnerDependencies.runHostPreflight = async ({ requestedPlatforms }) => ({
    requestedPlatforms,
    checks: [
      {
        platform: 'android',
        status: 'error',
        id: 'adb',
        title: 'adb',
        summary: 'Required to communicate with Android devices.',
        detail: 'ADB was not found in ANDROID_HOME, ANDROID_SDK_ROOT, or PATH.',
        blocking: true,
      },
      {
        platform: 'ios',
        status: 'ok',
        id: 'xcrun',
        title: 'xcrun',
        summary: 'Required to access iOS simulator tooling.',
        detail: '/usr/bin/xcrun',
        blocking: true,
      },
    ],
  });

  try {
    const result = await runTests({
      envName: 'dev',
      cwd: rootDir,
      selectors: ['login.yaml'],
      apiKeys: { openai: 'test-key' },
      defaults: { provider: 'openai', modelName: 'gpt-5.4-mini' },
    });

    assert.equal(result.success, true);
    assert.equal(prepareCalls, 1);
  } finally {
    testRunnerDependencies.prepareTestSession = originalPrepareTestSession;
    testRunnerDependencies.executeTestOnSession = originalExecuteTestOnSession;
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runTests requires --platform when both Android and iOS apps are configured', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-preflight-both-blocked-'));
  writeWorkspaceConfig(rootDir, 'both');
  const testsDir = path.join(rootDir, '.finalrun', 'tests');
  const envDir = path.join(rootDir, '.finalrun', 'env');
  fs.mkdirSync(testsDir, { recursive: true });
  fs.mkdirSync(envDir, { recursive: true });
  fs.writeFileSync(path.join(envDir, 'dev.yaml'), '{}\n', 'utf-8');
  fs.writeFileSync(
    path.join(testsDir, 'login.yaml'),
    ['name: login', 'steps:', '  - Open the login screen.'].join('\n'),
    'utf-8',
  );

  const originalPrepareTestSession = testRunnerDependencies.prepareTestSession;
  let prepareCalls = 0;
  testRunnerDependencies.prepareTestSession = async () => {
    prepareCalls += 1;
    return createTestSession();
  };
  testRunnerDependencies.runHostPreflight = async ({ requestedPlatforms }) => ({
    requestedPlatforms,
    checks: [
      {
        platform: 'android',
        status: 'error',
        id: 'adb',
        title: 'adb',
        summary: 'Required to communicate with Android devices.',
        detail: 'ADB was not found in ANDROID_HOME, ANDROID_SDK_ROOT, or PATH.',
        blocking: true,
      },
      {
        platform: 'ios',
        status: 'error',
        id: 'xcrun',
        title: 'xcrun',
        summary: 'Required to access iOS simulator tooling.',
        detail: 'xcrun was not found in PATH.',
        blocking: true,
      },
    ],
  });

  try {
    await assert.rejects(
      () =>
        runTests({
          envName: 'dev',
          cwd: rootDir,
          selectors: ['login.yaml'],
          apiKeys: { openai: 'test-key' },
          defaults: { provider: 'openai', modelName: 'gpt-5.4-mini' },
        }),
      (error: unknown) => {
        assert.ok(error instanceof PreExecutionFailureError);
        assert.equal(error.phase, 'validation');
        assert.match(
          error.message,
          /Both Android and iOS app identifiers are configured\. Pass --platform android or --platform ios\./,
        );
        return true;
      },
    );
    assert.equal(prepareCalls, 0);
    await assertNoRunArtifacts(rootDir);
  } finally {
    testRunnerDependencies.prepareTestSession = originalPrepareTestSession;
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});
