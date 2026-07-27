// Characterization tests for ReportWriter (260727-18tg).
//
// These tests pin the CURRENT behaviour of packages/cli/src/reportWriter.ts —
// they passed green against the unmodified source before the file was
// restructured, and must keep passing byte-for-byte unchanged afterwards.
// Real temp workspaces are used throughout; `fs` is never stubbed.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import type {
  RuntimeBindings,
  TestDefinition,
  TestResult,
} from '@finalrun/common';
import type { TestExecutionResult } from '@finalrun/goal-executor';
import { ReportWriter } from '../reportWriter.js';

const SECRET_VALUE = 'S3CR3T-VALUE-9000';
const SECRET_PLACEHOLDER = '${secrets.token}';

function createBindings(): RuntimeBindings {
  return {
    secrets: { token: SECRET_VALUE },
    variables: { language: 'Spanish' },
  };
}

function createWriter(runDir: string, bindings: RuntimeBindings = createBindings()): ReportWriter {
  return new ReportWriter({
    runDir,
    envName: 'staging',
    platform: 'android',
    runId: 'run-2026-03-20-staging-android',
    bindings,
  });
}

function createEnvironment(workspaceRoot: string, envPath?: string) {
  return {
    envName: 'staging',
    envPath,
    config: {
      app: undefined,
      secrets: { token: '${MY_TOKEN_ENV}' },
      variables: { language: 'Spanish' },
    },
    bindings: createBindings(),
    secretReferences: [{ key: 'token', envVar: 'MY_TOKEN_ENV' }],
  };
}

function createRunContext() {
  return {
    cli: {
      command: 'finalrun test',
      selectors: ['auth/login.yaml'],
      debug: false,
    },
    model: {
      provider: 'openai',
      modelName: 'gpt-5.4-mini',
      label: 'openai/gpt-5.4-mini',
    },
    app: { source: 'repo' as const, label: 'repo app' },
    target: { type: 'direct' as const },
  };
}

async function writeAuthoredTestYaml(sourcePath: string): Promise<void> {
  await fsp.mkdir(path.dirname(sourcePath), { recursive: true });
  await fsp.writeFile(
    sourcePath,
    [
      'name: login',
      'steps:',
      '  - Enter ${secrets.token} on the login screen.',
    ].join('\n'),
    'utf-8',
  );
}

function createExecutionResult(params?: Partial<TestExecutionResult>): TestExecutionResult {
  const result = {
    success: true,
    message: 'Goal completed.',
    platform: 'android',
    startedAt: '2026-03-20T10:00:00.000Z',
    completedAt: '2026-03-20T10:00:02.000Z',
    totalIterations: 1,
    steps: [],
    ...params,
  };
  return {
    ...result,
    status: result.status ?? (result.success ? 'success' : 'failure'),
  } as TestExecutionResult;
}

function createTestResult(params: Partial<TestResult> & { testId: string }): TestResult {
  return {
    testName: params.testId,
    sourcePath: '',
    relativePath: `${params.testId}.yaml`,
    success: true,
    status: 'success',
    message: 'ok',
    platform: 'android',
    startedAt: '2026-03-20T10:00:00.000Z',
    completedAt: '2026-03-20T10:00:01.000Z',
    durationMs: 1000,
    steps: [],
    ...params,
  };
}

async function listFilesRecursively(dir: string): Promise<string[]> {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursively(fullPath)));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

async function readJson(runDir: string, relative: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fsp.readFile(path.join(runDir, relative), 'utf-8'));
}

// --- writeRunInputs ----------------------------------------------------------

function createSourcedTestDef(sourcePath: string): TestDefinition {
  return {
    name: 'login',
    description: 'Verify a user can log in.',
    setup: ['Open ${variables.zeta} home.'],
    steps: ['Enter ${secrets.token} for ${variables.alpha}.'],
    expected_state: ['The feed is visible.'],
    sourcePath,
    relativePath: 'auth/login.yaml',
    testId: 'auth__login',
  };
}

function createInlineTestDef(): TestDefinition {
  return {
    name: 'inline',
    setup: [],
    steps: ['Tap the button.'],
    expected_state: [],
    relativePath: 'inline.yaml',
    testId: 'inline__test',
  };
}

/** Arranges the standard two-test + sourced-suite writeRunInputs fixture. */
async function arrangeRunInputs(runDir: string): Promise<void> {
  const workspaceRoot = path.join(runDir, 'workspace');
  const sourcedPath = path.join(workspaceRoot, '.finalrun', 'tests', 'auth', 'login.yaml');
  const suitePath = path.join(workspaceRoot, '.finalrun', 'suites', 'smoke.yaml');
  await writeAuthoredTestYaml(sourcedPath);
  await fsp.mkdir(path.dirname(suitePath), { recursive: true });
  await fsp.writeFile(suitePath, 'name: smoke\ntests:\n  - auth/login.yaml\n', 'utf-8');

  const writer = createWriter(runDir);
  await writer.init();
  await writer.writeRunInputs({
    workspaceRoot,
    environment: createEnvironment(
      workspaceRoot,
      path.join(workspaceRoot, '.finalrun', 'env', 'staging.yaml'),
    ),
    tests: [createSourcedTestDef(sourcedPath), createInlineTestDef()],
    suite: {
      suiteId: 'smoke',
      name: 'smoke suite',
      description: 'Smoke coverage.',
      tests: ['auth/login.yaml', 'inline.yaml'],
      sourcePath: suitePath,
    },
    effectiveGoals: new Map([['auth__login', 'Effective goal for login.']]),
    reasoning: 'high',
    ...createRunContext(),
  });
}

test('writeRunInputs pins the input file family and run-context key omission', async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-rw-inputs-'));
  try {
    await arrangeRunInputs(runDir);

    // File family under input/.
    for (const relative of [
      'input/run-context.json',
      'input/env.snapshot.yaml',
      'input/env.json',
      'input/suite.snapshot.yaml',
      'input/suite.json',
      'input/tests/auth__login.yaml',
      'input/tests/auth__login.json',
      'input/tests/inline__test.json',
    ]) {
      assert.equal((await fsp.stat(path.join(runDir, relative))).isFile(), true, relative);
    }
    // A test without a sourcePath gets no YAML snapshot.
    await assert.rejects(() => fsp.stat(path.join(runDir, 'input', 'tests', 'inline__test.yaml')));

    // run-context.json: reasoning present when given, features key absent when undefined.
    const runContext = await readJson(runDir, 'input/run-context.json');
    assert.equal(runContext['reasoning'], 'high');
    assert.equal('features' in runContext, false);
    assert.deepEqual(runContext['target'], { type: 'direct' });
    assert.equal((runContext['model'] as { label: string }).label, 'openai/gpt-5.4-mini');
  } finally {
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test('writeRunInputs pins the environment snapshots to reference forms only', async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-rw-env-'));
  try {
    await arrangeRunInputs(runDir);

    // env.snapshot.yaml carries the CONFIG secret form (env-var placeholder), never the value.
    const envSnapshotRaw = await fsp.readFile(path.join(runDir, 'input', 'env.snapshot.yaml'), 'utf-8');
    const envSnapshot = YAML.parse(envSnapshotRaw);
    assert.deepEqual(envSnapshot.secrets, { token: '${MY_TOKEN_ENV}' });
    assert.deepEqual(envSnapshot.variables, { language: 'Spanish' });
    assert.equal(envSnapshotRaw.includes(SECRET_VALUE), false);

    // env.json: reference record only — no secrets map at all.
    const envJson = await readJson(runDir, 'input/env.json');
    assert.equal(envJson['envName'], 'staging');
    assert.equal(envJson['workspaceEnvPath'], '.finalrun/env/staging.yaml');
    assert.equal(envJson['snapshotYamlPath'], 'input/env.snapshot.yaml');
    assert.equal(envJson['snapshotJsonPath'], 'input/env.json');
    assert.deepEqual(envJson['secretReferences'], [{ key: 'token', envVar: 'MY_TOKEN_ENV' }]);
    assert.equal('secrets' in envJson, false);
  } finally {
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test('writeRunInputs pins test snapshot records, reference collection, and the suite record', async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-rw-snapshots-'));
  try {
    await arrangeRunInputs(runDir);

    // Sourced-test snapshot JSON: identity, display path, sorted binding references, authored fields.
    const sourcedJson = await readJson(runDir, 'input/tests/auth__login.json');
    assert.equal(sourcedJson['testId'], 'auth__login');
    assert.equal(sourcedJson['testName'], 'login');
    assert.equal(sourcedJson['relativePath'], 'auth/login.yaml');
    assert.equal(sourcedJson['workspaceSourcePath'], '.finalrun/tests/auth/login.yaml');
    assert.deepEqual(sourcedJson['bindingReferences'], {
      variables: ['alpha', 'zeta'],
      secrets: ['token'],
    });
    assert.equal(sourcedJson['description'], 'Verify a user can log in.');
    assert.deepEqual(sourcedJson['steps'], ['Enter ${secrets.token} for ${variables.alpha}.']);

    // Inline-test snapshot JSON: workspaceSourcePath and description keys are OMITTED, not null.
    const inlineJson = await readJson(runDir, 'input/tests/inline__test.json');
    assert.equal('workspaceSourcePath' in inlineJson, false);
    assert.equal('description' in inlineJson, false);
    assert.deepEqual(inlineJson['bindingReferences'], { variables: [], secrets: [] });

    // suite.json: resolved record incl. snapshot paths and resolved test ids.
    const suiteJson = await readJson(runDir, 'input/suite.json');
    assert.equal(suiteJson['suiteId'], 'smoke');
    assert.equal(suiteJson['workspaceSourcePath'], '.finalrun/suites/smoke.yaml');
    assert.equal(suiteJson['snapshotYamlPath'], 'input/suite.snapshot.yaml');
    assert.equal(suiteJson['snapshotJsonPath'], 'input/suite.json');
    assert.deepEqual(suiteJson['resolvedTestIds'], ['auth__login', 'inline__test']);
  } finally {
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test('writeRunInputs pins the sourceless suite and the out-of-workspace display path', async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-rw-inputs-edge-'));
  const workspaceRoot = path.join(runDir, 'workspace');
  const outsidePath = path.join(runDir, 'elsewhere', 'ext.yaml');
  try {
    await writeAuthoredTestYaml(outsidePath);
    const outsideTest: TestDefinition = {
      name: 'external',
      setup: [],
      steps: ['Tap.'],
      expected_state: [],
      sourcePath: outsidePath,
      relativePath: 'ext.yaml',
      testId: 'ext__test',
    };

    const writer = createWriter(runDir);
    await writer.init();
    await writer.writeRunInputs({
      workspaceRoot,
      environment: createEnvironment(workspaceRoot),
      tests: [outsideTest],
      suite: { suiteId: 'adhoc', name: 'adhoc suite', tests: ['ext.yaml'] },
      effectiveGoals: new Map(),
      ...createRunContext(),
    });

    // No suite sourcePath: no YAML snapshot file, and the path key is omitted from suite.json.
    await assert.rejects(() => fsp.stat(path.join(runDir, 'input', 'suite.snapshot.yaml')));
    const suiteJson = await readJson(runDir, 'input/suite.json');
    assert.equal('snapshotYamlPath' in suiteJson, false);
    assert.equal(suiteJson['snapshotJsonPath'], 'input/suite.json');

    // A source outside the workspace root keeps its full path (posix-separated).
    const outsideJson = await readJson(runDir, 'input/tests/ext__test.json');
    assert.equal(outsideJson['workspaceSourcePath'], outsidePath.split(path.sep).join('/'));

    // No envPath: workspaceEnvPath omitted from env.json.
    const envJson = await readJson(runDir, 'input/env.json');
    assert.equal('workspaceEnvPath' in envJson, false);
  } finally {
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

// --- writeTestRecord ---------------------------------------------------------

/** Arranges recording/device-log sources and a two-step success result, then writes the record. */
async function arrangeSuccessRecord(runDir: string): Promise<TestResult> {
  const recordingSource = path.join(runDir, 'source-recording.mp4');
  const deviceLogSource = path.join(runDir, 'source-device.log');
  await fsp.mkdir(runDir, { recursive: true });
  await fsp.writeFile(recordingSource, 'fake-video-data', 'utf-8');
  await fsp.writeFile(deviceLogSource, `boot ok token=${SECRET_VALUE} ready\n`, 'utf-8');

  const testDef: TestDefinition = {
    name: 'login',
    setup: [],
    steps: ['Log in.'],
    expected_state: [],
    relativePath: 'auth/login.yaml',
    testId: 'auth__login',
  };
  const screenshot = `data:image/jpeg;base64,${Buffer.from('fake-shot-1').toString('base64')}`;
  const result = createExecutionResult({
    message: `Logged in with ${SECRET_VALUE}.`,
    analysis: `Analysis mentions ${SECRET_VALUE}.`,
    recording: {
      filePath: recordingSource,
      startedAt: '2026-03-20T10:00:00.000Z',
      completedAt: '2026-03-20T10:00:02.000Z',
    },
    deviceLog: {
      filePath: deviceLogSource,
      startedAt: '2026-03-20T10:00:00.100Z',
      completedAt: '2026-03-20T10:00:01.900Z',
    },
    steps: [
      {
        iteration: 1,
        action: 'input_text',
        reason: `Enter ${SECRET_VALUE}.`,
        success: true,
        screenshot,
        timestamp: '2026-03-20T10:00:01.000Z',
        durationMs: 700,
      },
      {
        iteration: 2,
        action: 'tap',
        reason: 'Submit.',
        success: true,
        timestamp: '2026-03-20T10:00:01.500Z',
        durationMs: 300,
      },
    ],
  });

  const writer = createWriter(runDir);
  await writer.init();
  return await writer.writeTestRecord(testDef, result, createBindings());
}

test('writeTestRecord pins the success record, artifact copies, and device-log redaction', async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-rw-record-'));
  try {
    const record = await arrangeSuccessRecord(runDir);

    assert.equal(record.status, 'success');
    assert.equal(record.durationMs, 2000);
    assert.equal(record.recordingFile, 'tests/auth__login/recording.mp4');
    assert.equal(record.recordingStartedAt, '2026-03-20T10:00:00.000Z');
    assert.equal(record.deviceLogFile, 'tests/auth__login/device.log');
    assert.equal(record.deviceLogStartedAt, '2026-03-20T10:00:00.100Z');
    assert.equal(record.deviceLogCompletedAt, '2026-03-20T10:00:01.900Z');

    // The recording is copied to the pinned path.
    assert.equal(
      await fsp.readFile(path.join(runDir, 'tests', 'auth__login', 'recording.mp4'), 'utf-8'),
      'fake-video-data',
    );

    // result.json mirrors the returned record with redacted message/analysis.
    const resultJson = await readJson(runDir, 'tests/auth__login/result.json');
    assert.equal(resultJson['message'], `Logged in with ${SECRET_PLACEHOLDER}.`);
    assert.equal(resultJson['analysis'], `Analysis mentions ${SECRET_PLACEHOLDER}.`);

    // The device log is copied then redacted in place.
    const copiedLog = await fsp.readFile(
      path.join(runDir, 'tests', 'auth__login', 'device.log'),
      'utf-8',
    );
    assert.equal(copiedLog, `boot ok token=${SECRET_PLACEHOLDER} ready\n`);
  } finally {
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test('writeTestRecord pins per-step artifacts, screenshot decode, and video offsets', async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-rw-steps-'));
  try {
    await arrangeSuccessRecord(runDir);

    // The decoded screenshot lands at the pinned path; no file for a screenshotless step.
    assert.equal(
      await fsp.readFile(path.join(runDir, 'tests', 'auth__login', 'screenshots', '001.jpg'), 'utf-8'),
      'fake-shot-1',
    );
    await assert.rejects(() =>
      fsp.stat(path.join(runDir, 'tests', 'auth__login', 'screenshots', '002.jpg')),
    );

    const stepJson = await readJson(runDir, 'tests/auth__login/actions/001.json');
    assert.equal(stepJson['stepNumber'], 1);
    assert.equal(stepJson['videoOffsetMs'], 1000);
    assert.equal(stepJson['reason'], `Enter ${SECRET_PLACEHOLDER}.`);
    assert.equal(stepJson['screenshotFile'], 'tests/auth__login/screenshots/001.jpg');
    assert.equal(stepJson['stepJsonFile'], 'tests/auth__login/actions/001.json');

    // Second step has no screenshot: key omitted, videoOffset computed from its own timestamp.
    const stepJson2 = await readJson(runDir, 'tests/auth__login/actions/002.json');
    assert.equal('screenshotFile' in stepJson2, false);
    assert.equal(stepJson2['videoOffsetMs'], 1500);
  } finally {
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test('writeTestRecord pins the aborted status, missing artifact sources, and the duration clamp', async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-rw-missing-'));
  try {
    const testDef: TestDefinition = {
      name: 'flaky',
      setup: [],
      steps: ['Do a thing.'],
      expected_state: [],
      relativePath: 'flaky.yaml',
      testId: 'flaky__test',
    };
    const result = createExecutionResult({
      success: false,
      status: 'aborted',
      message: 'Run aborted.',
      // completedAt earlier than startedAt: durationMs clamps to 0.
      startedAt: '2026-03-20T10:00:05.000Z',
      completedAt: '2026-03-20T10:00:00.000Z',
      recording: {
        filePath: path.join(runDir, 'missing-recording.mp4'),
        startedAt: '2026-03-20T10:00:00.000Z',
      },
      deviceLog: {
        filePath: path.join(runDir, 'missing-device.log'),
        startedAt: '2026-03-20T10:00:00.100Z',
        completedAt: '2026-03-20T10:00:01.900Z',
      },
    });

    const writer = createWriter(runDir);
    await writer.init();
    const record = await writer.writeTestRecord(testDef, result, createBindings());

    assert.equal(record.status, 'aborted');
    assert.equal(record.durationMs, 0);
    assert.equal(record.recordingFile, undefined);
    assert.equal(record.deviceLogFile, undefined);
    // The timestamps are still carried even when the artifact file is missing.
    assert.equal(record.recordingStartedAt, '2026-03-20T10:00:00.000Z');
    assert.equal(record.deviceLogStartedAt, '2026-03-20T10:00:00.100Z');

    const resultJson = await readJson(runDir, 'tests/flaky__test/result.json');
    assert.equal(resultJson['status'], 'aborted');
    assert.equal('recordingFile' in resultJson, false);
    assert.equal('deviceLogFile' in resultJson, false);
    await assert.rejects(() => fsp.stat(path.join(runDir, 'tests', 'flaky__test', 'device.log')));
    await assert.rejects(() =>
      fsp.stat(path.join(runDir, 'tests', 'flaky__test', 'recording.mp4')),
    );
  } finally {
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

// --- writeTestFailureRecord ----------------------------------------------------

/** Writes the synthetic pre-execution failure record for a secret-bearing message. */
async function arrangeFailureRecord(runDir: string): Promise<TestResult> {
  const testDef: TestDefinition = {
    name: 'login',
    setup: [],
    steps: ['Log in.'],
    expected_state: [],
    relativePath: 'auth/login.yaml',
    testId: 'auth__login',
  };
  const writer = createWriter(runDir);
  await writer.init();
  return await writer.writeTestFailureRecord({
    test: testDef,
    bindings: createBindings(),
    message: `Setup failed: token ${SECRET_VALUE} rejected.`,
    platform: 'android',
    startedAt: '2026-03-20T10:00:00.000Z',
    completedAt: '2026-03-20T10:00:03.000Z',
  });
}

test('writeTestFailureRecord pins the synthetic failure record and result shape', async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-rw-failure-'));
  try {
    const record = await arrangeFailureRecord(runDir);

    assert.equal(record.success, false);
    assert.equal(record.status, 'error');
    assert.equal(record.message, `Setup failed: token ${SECRET_PLACEHOLDER} rejected.`);
    assert.equal(record.durationMs, 3000);
    assert.equal(record.steps.length, 1);

    // Placeholder screenshot is a real JPEG (SOI marker).
    const placeholder = await fsp.readFile(
      path.join(runDir, 'tests', 'auth__login', 'screenshots', '001.jpg'),
    );
    assert.equal(placeholder[0], 0xff);
    assert.equal(placeholder[1], 0xd8);

    // result.json: status 'error', exactly one step, and NO analysis key (undefined is omitted).
    const resultJson = await readJson(runDir, 'tests/auth__login/result.json');
    assert.equal(resultJson['status'], 'error');
    assert.equal((resultJson['steps'] as unknown[]).length, 1);
    assert.equal('analysis' in resultJson, false);
  } finally {
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test('writeTestFailureRecord pins the synthetic failure step JSON', async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-rw-failure-step-'));
  try {
    await arrangeFailureRecord(runDir);

    const stepJson = await readJson(runDir, 'tests/auth__login/actions/001.json');
    assert.equal(stepJson['actionType'], 'run_failure');
    assert.equal(stepJson['stepNumber'], 1);
    assert.equal(stepJson['iteration'], 1);
    assert.equal(stepJson['success'], false);
    assert.equal(stepJson['status'], 'failure');
    assert.equal(
      stepJson['naturalLanguageAction'],
      'Run setup failed before the first recorded agent action.',
    );
    assert.equal(stepJson['analysis'], 'No executable agent step completed before the run failed.');
    assert.equal(stepJson['reason'], `Setup failed: token ${SECRET_PLACEHOLDER} rejected.`);
    assert.equal(stepJson['errorMessage'], `Setup failed: token ${SECRET_PLACEHOLDER} rejected.`);
    assert.deepEqual(stepJson['trace'], {
      step: 1,
      action: 'run_failure',
      status: 'failure',
      totalMs: 3000,
      spans: [],
      failureReason: `Setup failed: token ${SECRET_PLACEHOLDER} rejected.`,
    });
  } finally {
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

// --- finalize ------------------------------------------------------------------

/** Runs the full passing-run lifecycle (inputs, one record, finalize) and returns the summary. */
async function arrangePassingFinalize(runDir: string) {
  const workspaceRoot = path.join(runDir, 'workspace');
  const sourcedPath = path.join(workspaceRoot, '.finalrun', 'tests', 'auth', 'login.yaml');
  await writeAuthoredTestYaml(sourcedPath);
  const testDef: TestDefinition = {
    name: 'login',
    description: 'Verify a user can log in.',
    setup: ['Reset the app.'],
    steps: ['Log in.'],
    expected_state: ['The feed is visible.'],
    sourcePath: sourcedPath,
    relativePath: 'auth/login.yaml',
    testId: 'auth__login',
  };
  const screenshot = `data:image/jpeg;base64,${Buffer.from('shot').toString('base64')}`;
  const result = createExecutionResult({
    steps: [
      {
        iteration: 1,
        action: 'tap',
        reason: 'Log in.',
        success: true,
        screenshot,
        timestamp: '2026-03-20T10:00:01.000Z',
      },
      { iteration: 2, action: 'assert', reason: 'Check feed.', success: true },
    ],
  });

  const writer = createWriter(runDir);
  await writer.init();
  await writer.writeRunInputs({
    workspaceRoot,
    environment: createEnvironment(workspaceRoot),
    tests: [testDef],
    effectiveGoals: new Map([[testDef.testId!, 'Effective goal for login.']]),
    ...createRunContext(),
  });
  const record = await writer.writeTestRecord(testDef, result, createBindings());
  return await writer.finalize({
    startedAt: '2026-03-20T10:00:00.000Z',
    completedAt: '2026-03-20T10:00:05.000Z',
    tests: [record],
  });
}

test('finalize pins the passing-run summary shape', async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-rw-finalize-'));
  try {
    const summary = await arrangePassingFinalize(runDir);

    assert.equal(summary.success, true);
    assert.equal(summary.status, 'success');
    assert.equal(summary.durationMs, 5000);

    const summaryJson = await readJson(runDir, 'summary.json');
    assert.equal(summaryJson['runId'], 'run-2026-03-20-staging-android');
    assert.equal(summaryJson['testCount'], 1);
    assert.equal(summaryJson['passedCount'], 1);
    assert.equal(summaryJson['failedCount'], 0);
    assert.equal(summaryJson['stepCount'], 2);
    assert.deepEqual(summaryJson['variables'], { language: 'Spanish' });
    const summaryTests = summaryJson['tests'] as Array<{ resultFile: string }>;
    assert.equal(summaryTests[0]!.resultFile, 'tests/auth__login/result.json');
    assert.equal(summaryJson['runJsonFile'], 'run.json');
    assert.equal('failurePhase' in summaryJson, false);
  } finally {
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test('finalize pins the passing-run manifest run block, paths, and key omission', async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-rw-manifest-'));
  try {
    await arrangePassingFinalize(runDir);

    const manifest = await readJson(runDir, 'run.json');
    const run = manifest['run'] as Record<string, unknown>;
    assert.equal(manifest['schemaVersion'], 3);
    assert.equal(run['status'], 'success');
    assert.deepEqual(run['counts'], {
      tests: { total: 1, passed: 1, failed: 0 },
      steps: { total: 2, passed: 2, failed: 0 },
    });
    assert.deepEqual(run['model'], createRunContext().model);
    assert.deepEqual(run['selectors'], ['auth/login.yaml']);
    assert.equal('firstFailure' in run, false);
    assert.equal('diagnosticsSummary' in run, false);
    assert.deepEqual(manifest['paths'], {
      runJson: 'run.json',
      summaryJson: 'summary.json',
      log: 'runner.log',
      runContextJson: 'input/run-context.json',
    });
    // No suite was given: the suite key is omitted from input, not present-and-null.
    const input = manifest['input'] as Record<string, unknown>;
    assert.equal('suite' in input, false);
    assert.equal((input['environment'] as { envName: string }).envName, 'staging');
    assert.equal((input['tests'] as unknown[]).length, 1);
  } finally {
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test('finalize pins the manifest test record enrichment from snapshots', async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-rw-manifest-test-'));
  try {
    await arrangePassingFinalize(runDir);

    const manifest = await readJson(runDir, 'run.json');
    const manifestTest = (manifest['tests'] as Array<Record<string, unknown>>)[0]!;
    assert.deepEqual(manifestTest['authored'], {
      name: 'login',
      description: 'Verify a user can log in.',
      setup: ['Reset the app.'],
      steps: ['Log in.'],
      expected_state: ['The feed is visible.'],
    });
    assert.equal(manifestTest['effectiveGoal'], 'Effective goal for login.');
    assert.equal(manifestTest['snapshotYamlPath'], 'input/tests/auth__login.yaml');
    assert.equal(manifestTest['snapshotJsonPath'], 'input/tests/auth__login.json');
    assert.equal(manifestTest['workspaceSourcePath'], '.finalrun/tests/auth/login.yaml');
    assert.deepEqual(manifestTest['counts'], {
      executionStepsTotal: 2,
      executionStepsPassed: 2,
      executionStepsFailed: 0,
    });
    assert.equal('firstFailure' in manifestTest, false);
    assert.equal(manifestTest['previewScreenshotPath'], 'tests/auth__login/screenshots/001.jpg');
    assert.equal(manifestTest['resultJsonPath'], 'tests/auth__login/result.json');
  } finally {
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test('finalize pins the aborted run finalized without run inputs', async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-rw-aborted-'));
  try {
    const writer = createWriter(runDir);
    await writer.init();
    const summary = await writer.finalize({
      startedAt: '2026-03-20T10:00:00.000Z',
      completedAt: '2026-03-20T10:00:01.000Z',
      tests: [],
      successOverride: false,
      statusOverride: 'aborted',
      failurePhase: 'setup',
      diagnosticsSummary: `Emulator crashed during boot (${SECRET_VALUE}).`,
    });

    assert.equal(summary.success, false);
    assert.equal(summary.status, 'aborted');
    assert.equal(summary.failurePhase, 'setup');
    assert.equal(summary.testCount, 0);

    const manifest = await readJson(runDir, 'run.json');
    const run = manifest['run'] as Record<string, unknown>;
    assert.equal(run['success'], false);
    assert.equal(run['status'], 'aborted');
    assert.equal(run['failurePhase'], 'setup');
    // diagnosticsSummary is a verbatim passthrough: the writer applies NO redaction to
    // it (unlike messages/analyses/log lines). Pinned with a bindings-secret substring
    // so any future redaction of this field shows up as a deliberate behaviour change.
    assert.equal(run['diagnosticsSummary'], `Emulator crashed during boot (${SECRET_VALUE}).`);
    // No failed test exists, so first failure falls back to the diagnostics summary.
    assert.deepEqual(run['firstFailure'], {
      message: `Emulator crashed during boot (${SECRET_VALUE}).`,
    });
    // writeRunInputs never ran: runContextJson is omitted from paths entirely.
    assert.equal('runContextJson' in (manifest['paths'] as object), false);
    // The constructor-seeded environment record is still emitted.
    const input = manifest['input'] as Record<string, unknown>;
    const environment = input['environment'] as Record<string, unknown>;
    assert.equal(environment['envName'], 'staging');
    assert.deepEqual(environment['variables'], { language: 'Spanish' });
    assert.deepEqual(environment['secretReferences'], []);
    assert.deepEqual(input['tests'], []);
  } finally {
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

// --- first-failure precedence -----------------------------------------------

function createPassingPrecedenceResult(): TestResult {
  return createTestResult({
    testId: 'pass__test',
    steps: [
      {
        stepNumber: 1,
        iteration: 1,
        actionType: 'tap',
        naturalLanguageAction: 'Tap.',
        reason: 'Tap.',
        success: true,
        status: 'success',
        timestamp: '2026-03-20T10:00:01.000Z',
        screenshotFile: 'tests/pass__test/screenshots/001.jpg',
      },
    ],
  });
}

function createFailingPrecedenceResult(): TestResult {
  return createTestResult({
    testId: 'fail__test',
    success: false,
    status: 'failure',
    message: 'test-level message',
    steps: [
      {
        stepNumber: 1,
        iteration: 1,
        actionType: 'tap',
        naturalLanguageAction: 'Tap.',
        reason: 'Tap.',
        success: true,
        status: 'success',
        timestamp: '2026-03-20T10:00:01.000Z',
        screenshotFile: 'tests/fail__test/screenshots/001.jpg',
      },
      {
        stepNumber: 2,
        iteration: 2,
        actionType: 'assert',
        naturalLanguageAction: 'Check.',
        reason: 'Check.',
        success: false,
        status: 'failure',
        timestamp: '2026-03-20T10:00:02.000Z',
        screenshotFile: 'tests/fail__test/screenshots/002.jpg',
        stepJsonFile: 'tests/fail__test/actions/002.json',
        // Carries BOTH candidate fields so the errorMessage > trace.failureReason
        // rung of the precedence chain is load-bearing.
        errorMessage: 'step error message',
        trace: {
          step: 2,
          action: 'assert',
          status: 'failure',
          totalMs: 100,
          spans: [],
          failureReason: 'trace reason',
        },
      },
      {
        stepNumber: 3,
        iteration: 3,
        actionType: 'tap',
        naturalLanguageAction: 'Retry.',
        reason: 'Retry.',
        success: false,
        status: 'failure',
        timestamp: '2026-03-20T10:00:03.000Z',
        errorMessage: 'later error',
      },
    ],
  });
}

/** First failed step carries ONLY trace.failureReason: pins the middle rung. */
function createTraceOnlyPrecedenceResult(): TestResult {
  return createTestResult({
    testId: 'trace__test',
    success: false,
    status: 'failure',
    message: 'trace test-level message',
    steps: [
      {
        stepNumber: 1,
        iteration: 1,
        actionType: 'assert',
        naturalLanguageAction: 'Check.',
        reason: 'Check.',
        success: false,
        status: 'failure',
        timestamp: '2026-03-20T10:00:01.000Z',
        trace: {
          step: 1,
          action: 'assert',
          status: 'failure',
          totalMs: 50,
          spans: [],
          failureReason: 'trace-only reason',
        },
      },
    ],
  });
}

/** First failed step carries NEITHER field: pins the test.message rung. */
function createBareFailurePrecedenceResult(): TestResult {
  return createTestResult({
    testId: 'bare__test',
    success: false,
    status: 'failure',
    message: 'bare test-level message',
    steps: [
      {
        stepNumber: 1,
        iteration: 1,
        actionType: 'tap',
        naturalLanguageAction: 'Tap.',
        reason: 'Tap.',
        success: false,
        status: 'failure',
        timestamp: '2026-03-20T10:00:01.000Z',
      },
    ],
  });
}

async function arrangePrecedenceFinalize(runDir: string): Promise<void> {
  const writer = createWriter(runDir);
  await writer.init();
  await writer.finalize({
    startedAt: '2026-03-20T10:00:00.000Z',
    completedAt: '2026-03-20T10:00:05.000Z',
    tests: [
      createPassingPrecedenceResult(),
      createFailingPrecedenceResult(),
      createTraceOnlyPrecedenceResult(),
      createBareFailurePrecedenceResult(),
    ],
  });
}

test('finalize pins first-failure precedence and preview selection', async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-rw-firstfailure-'));
  try {
    await arrangePrecedenceFinalize(runDir);

    const manifest = await readJson(runDir, 'run.json');
    const summaryJson = await readJson(runDir, 'summary.json');
    const manifestTests = manifest['tests'] as Array<Record<string, unknown>>;

    // Default success derivation: one failed test fails the run.
    assert.equal(summaryJson['success'], false);
    assert.equal(summaryJson['status'], 'failure');

    // First FAILED step wins; the full message precedence chain is
    // errorMessage -> trace.failureReason -> test.message, one rung per fixture:
    // rung 1 — the step carries BOTH fields and errorMessage wins.
    const failingRecord = manifestTests[1]!;
    assert.deepEqual(failingRecord['firstFailure'], {
      testId: 'fail__test',
      testName: 'fail__test',
      stepNumber: 2,
      actionType: 'assert',
      message: 'step error message',
      screenshotPath: 'tests/fail__test/screenshots/002.jpg',
      stepJsonPath: 'tests/fail__test/actions/002.json',
    });
    // rung 2 — no errorMessage: trace.failureReason wins over test.message.
    const traceRecord = manifestTests[2]!;
    assert.equal(
      (traceRecord['firstFailure'] as Record<string, unknown>)['message'],
      'trace-only reason',
    );
    // rung 3 — neither step field: the test-level message is the fallback.
    const bareRecord = manifestTests[3]!;
    assert.equal(
      (bareRecord['firstFailure'] as Record<string, unknown>)['message'],
      'bare test-level message',
    );
    // The run-level first failure is the first failed test's own record.
    assert.deepEqual((manifest['run'] as Record<string, unknown>)['firstFailure'], failingRecord['firstFailure']);
    // Preview screenshot prefers the first FAILED step that has one.
    assert.equal(failingRecord['previewScreenshotPath'], 'tests/fail__test/screenshots/002.jpg');
    assert.equal(manifestTests[0]!['previewScreenshotPath'], 'tests/pass__test/screenshots/001.jpg');
    assert.deepEqual(failingRecord['counts'], {
      executionStepsTotal: 3,
      executionStepsPassed: 1,
      executionStepsFailed: 2,
    });
  } finally {
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test('finalize pins the authored fallback for tests never registered via writeRunInputs', async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-rw-fallback-'));
  try {
    await arrangePrecedenceFinalize(runDir);

    const manifest = await readJson(runDir, 'run.json');
    const passingRecord = (manifest['tests'] as Array<Record<string, unknown>>)[0]!;
    // No snapshot was registered for these tests: the authored fallback applies.
    assert.deepEqual(passingRecord['authored'], {
      name: 'pass__test',
      setup: [],
      steps: [],
      expected_state: [],
    });
    assert.equal('description' in (passingRecord['authored'] as object), false);
    assert.equal(passingRecord['snapshotYamlPath'], '');
    assert.equal(passingRecord['snapshotJsonPath'], '');
    assert.deepEqual(passingRecord['bindingReferences'], { variables: [], secrets: [] });
    assert.equal(passingRecord['effectiveGoal'], '');
  } finally {
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test('finalize synthesizes a run-level first failure for a failed test with no failed step', async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-rw-synth-failure-'));
  try {
    const failing = createTestResult({
      testId: 'odd__test',
      success: false,
      status: 'failure',
      message: 'Expected state was not reached.',
      steps: [
        {
          stepNumber: 1,
          iteration: 1,
          actionType: 'tap',
          naturalLanguageAction: 'Tap.',
          reason: 'Tap.',
          success: true,
          status: 'success',
          timestamp: '2026-03-20T10:00:01.000Z',
          screenshotFile: 'tests/odd__test/screenshots/001.jpg',
        },
      ],
    });

    const writer = createWriter(runDir);
    await writer.init();
    await writer.finalize({
      startedAt: '2026-03-20T10:00:00.000Z',
      completedAt: '2026-03-20T10:00:05.000Z',
      tests: [failing],
    });

    const manifest = await readJson(runDir, 'run.json');
    // The test record itself has no firstFailure (no failed step)...
    assert.equal('firstFailure' in (manifest['tests'] as Array<object>)[0]!, false);
    // ...so the run-level record is synthesized from the failed test.
    assert.deepEqual((manifest['run'] as Record<string, unknown>)['firstFailure'], {
      testId: 'odd__test',
      testName: 'odd__test',
      message: 'Expected state was not reached.',
      screenshotPath: 'tests/odd__test/screenshots/001.jpg',
    });
  } finally {
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

// --- whole-directory secret sweep ---------------------------------------------

/** One execution step with the resolved secret planted in every redactable field. */
function createSweepStep() {
  return {
    iteration: 1,
    action: 'input_text',
    reason: `Enter ${SECRET_VALUE}.`,
    naturalLanguageAction: `Step 1: enter ${SECRET_VALUE}.`,
    analysis: `Typed ${SECRET_VALUE}.`,
    thought: {
      plan: `Plan uses ${SECRET_VALUE}.`,
      think: `Think about ${SECRET_VALUE}.`,
      act: `Act with ${SECRET_VALUE}.`,
    },
    actionPayload: {
      text: SECRET_VALUE,
      url: `https://example.com?token=${SECRET_VALUE}`,
    },
    success: false,
    errorMessage: `Rejected ${SECRET_VALUE}.`,
    timestamp: '2026-03-20T10:00:01.000Z',
    trace: {
      step: 1,
      action: 'input_text',
      status: 'failure' as const,
      totalMs: 900,
      failureReason: `Trace failure ${SECRET_VALUE}.`,
      spans: [
        {
          name: 'action.device',
          startMs: 0,
          durationMs: 900,
          status: 'failure' as const,
          detail: `span detail ${SECRET_VALUE}`,
        },
      ],
    },
    timing: {
      totalMs: 900,
      spans: [
        {
          name: 'action.device',
          durationMs: 900,
          status: 'failure' as const,
          detail: `timing detail ${SECRET_VALUE}`,
        },
      ],
    },
  };
}

/** The two test definitions and secret-laden execution result for the sweep. */
async function createSweepFixtures(workspaceRoot: string, deviceLogSource: string) {
  const sourcedPath = path.join(workspaceRoot, '.finalrun', 'tests', 'auth', 'login.yaml');
  await writeAuthoredTestYaml(sourcedPath);
  const testDef: TestDefinition = {
    name: 'login',
    setup: [],
    steps: ['Enter ${secrets.token}.'],
    expected_state: [],
    sourcePath: sourcedPath,
    relativePath: 'auth/login.yaml',
    testId: 'auth__login',
  };
  const failedDef: TestDefinition = {
    name: 'broken',
    setup: [],
    steps: ['Never runs.'],
    expected_state: [],
    relativePath: 'broken.yaml',
    testId: 'broken__test',
  };
  const result = createExecutionResult({
    message: `Done with ${SECRET_VALUE}.`,
    analysis: `Saw ${SECRET_VALUE}.`,
    deviceLog: {
      filePath: deviceLogSource,
      startedAt: '2026-03-20T10:00:00.100Z',
      completedAt: '2026-03-20T10:00:01.900Z',
    },
    steps: [createSweepStep()],
  });
  return { testDef, failedDef, result };
}

/** Full writer lifecycle with the secret planted in every caller-provided surface. */
async function runSweepLifecycle(
  runDir: string,
  workspaceRoot: string,
  deviceLogSource: string,
): Promise<void> {
  const { testDef, failedDef, result } = await createSweepFixtures(
    workspaceRoot,
    deviceLogSource,
  );
  const writer = createWriter(runDir);
  await writer.init();
  await writer.writeRunInputs({
    workspaceRoot,
    environment: createEnvironment(
      workspaceRoot,
      path.join(workspaceRoot, '.finalrun', 'env', 'staging.yaml'),
    ),
    tests: [testDef, failedDef],
    effectiveGoals: new Map([[testDef.testId!, 'Enter ${secrets.token}.']]),
    ...createRunContext(),
  });
  writer.createLoggerSink()({
    level: 1,
    levelName: 'INFO',
    message: `sink message ${SECRET_VALUE}`,
    args: [],
    renderedMessage: `[finalrun] sink message ${SECRET_VALUE}`,
    timestamp: '2026-03-20T10:00:00.500Z',
    tag: 'finalrun',
  });
  writer.appendLogLine(`log line ${SECRET_VALUE}`);
  writer.appendRawBlock(`raw block ${SECRET_VALUE} without trailing newline`);

  const record = await writer.writeTestRecord(testDef, result, createBindings());
  const failureRecord = await writer.writeTestFailureRecord({
    test: failedDef,
    bindings: createBindings(),
    message: `Setup exploded with ${SECRET_VALUE}.`,
    platform: 'android',
    startedAt: '2026-03-20T10:00:00.000Z',
    completedAt: '2026-03-20T10:00:01.000Z',
  });
  // NOTE: diagnosticsSummary is deliberately excluded here — finalize passes it
  // through VERBATIM (no redaction; pinned by the aborted-run test). Callers own
  // its content, and no in-repo caller feeds it secret-bearing text.
  await writer.finalize({
    startedAt: '2026-03-20T10:00:00.000Z',
    completedAt: '2026-03-20T10:00:05.000Z',
    tests: [record, failureRecord],
  });
}

test('no resolved secret value survives anywhere in the emitted run directory', async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-rw-sweep-'));
  const workspaceRoot = path.join(runDir, 'workspace');
  const deviceLogSource = path.join(os.tmpdir(), `finalrun-rw-sweep-log-${process.pid}.log`);
  try {
    await fsp.writeFile(deviceLogSource, `device saw ${SECRET_VALUE}\n`, 'utf-8');
    await runSweepLifecycle(runDir, workspaceRoot, deviceLogSource);

    // The workspace fixture is input, not writer output — exclude it from the sweep.
    const emitted = (await listFilesRecursively(runDir)).filter(
      (filePath) => !filePath.startsWith(workspaceRoot + path.sep),
    );
    assert.equal(emitted.length > 0, true);
    for (const filePath of emitted) {
      const contents = await fsp.readFile(filePath);
      assert.equal(
        contents.includes(SECRET_VALUE),
        false,
        `resolved secret leaked into ${filePath}`,
      );
    }

    // Redaction wrote placeholders, and appendRawBlock added the missing newline.
    const runnerLog = await fsp.readFile(path.join(runDir, 'runner.log'), 'utf-8');
    assert.equal(runnerLog.includes(`sink message ${SECRET_PLACEHOLDER}`), true);
    assert.equal(runnerLog.includes(`log line ${SECRET_PLACEHOLDER}`), true);
    assert.equal(
      runnerLog.includes(`raw block ${SECRET_PLACEHOLDER} without trailing newline\n`),
      true,
    );
  } finally {
    await fsp.rm(deviceLogSource, { force: true });
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});
