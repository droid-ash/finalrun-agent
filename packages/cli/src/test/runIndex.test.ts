import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { RunManifest, RunTarget } from '@finalrun/common';
import { formatRunIndexForConsole, rebuildRunIndex } from '../runIndex.js';

function createRunManifest(
  runId: string,
  success: boolean,
  target: RunTarget = { type: 'direct' },
): RunManifest {
  return {
    schemaVersion: 2,
    run: {
      runId,
      success,
      status: success ? 'success' : 'failure',
      startedAt: '2026-03-23T18:00:00.000Z',
      completedAt: '2026-03-23T18:00:10.000Z',
      durationMs: 10000,
      envName: 'dev',
      platform: 'android',
      model: {
        provider: 'openai',
        modelName: 'gpt-5.4-mini',
        label: 'openai/gpt-5.4-mini',
      },
      app: {
        source: 'repo',
        label: 'repo app',
      },
      selectors: ['login.yaml'],
      target,
      counts: {
        tests: {
          total: 1,
          passed: success ? 1 : 0,
          failed: success ? 0 : 1,
        },
        steps: {
          total: 1,
          passed: success ? 1 : 0,
          failed: success ? 0 : 1,
        },
      },
      firstFailure: success
        ? undefined
        : {
            testId: 'login',
            testName: 'login',
            message: 'button not found',
            screenshotPath: 'tests/login/screenshots/001.jpg',
          },
    },
    input: {
      environment: {
        envName: 'dev',
        variables: {},
        secretReferences: [],
      },
      tests: [],
      cli: {
        command: 'finalrun test',
        selectors: ['login.yaml'],
        debug: false,
      },
    },
    tests: [],
    paths: {
      runJson: 'run.json',
      summaryJson: 'summary.json',
      log: 'runner.log',
    },
  };
}

test('rebuildRunIndex writes runs.json from run.json files', async () => {
  const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-run-index-'));
  const runId = '2026-03-23T18-00-00.000Z-dev-android';
  const runDir = path.join(artifactsDir, runId);
  await fsp.mkdir(runDir, { recursive: true });
  await fsp.writeFile(
    path.join(runDir, 'run.json'),
    JSON.stringify(createRunManifest(runId, false), null, 2),
    'utf-8',
  );

  try {
    const index = await rebuildRunIndex(artifactsDir);
    assert.equal(index.runs.length, 1);
    assert.equal(index.runs[0]?.runId, runId);

    const runsJsonPath = path.join(artifactsDir, 'runs.json');
    const stats = await fsp.stat(runsJsonPath);
    assert.equal(stats.isFile(), true);

    const runsJson = JSON.parse(await fsp.readFile(runsJsonPath, 'utf-8'));
    assert.equal(runsJson.runs[0]?.firstFailure?.message, 'button not found');
    assert.equal(runsJson.runs[0]?.paths.runJson, `${runId}/run.json`);
  } finally {
    await fsp.rm(artifactsDir, { recursive: true, force: true });
  }
});

test('rebuildRunIndex carries compact suite target metadata into runs.json', async () => {
  const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-suite-run-index-'));
  const runId = '2026-03-24T08-10-11.000Z-dev-android';
  const runDir = path.join(artifactsDir, runId);
  await fsp.mkdir(runDir, { recursive: true });
  await fsp.writeFile(
    path.join(runDir, 'run.json'),
    JSON.stringify(
      createRunManifest(runId, true, {
        type: 'suite',
        suiteId: 'login_suite',
        suiteName: 'login suite',
        suitePath: 'login_suite.yaml',
      }),
      null,
      2,
    ),
    'utf-8',
  );

  try {
    const index = await rebuildRunIndex(artifactsDir);
    assert.deepEqual(index.runs[0]?.target, {
      type: 'suite',
      suiteId: 'login_suite',
      suiteName: 'login suite',
      suitePath: 'login_suite.yaml',
    });
  } finally {
    await fsp.rm(artifactsDir, { recursive: true, force: true });
  }
});

test('formatRunIndexForConsole prints ABORT for aborted runs', () => {
  const output = formatRunIndexForConsole({
    schemaVersion: 1,
    generatedAt: '2026-03-23T18:00:00.000Z',
    runs: [
      {
        runId: '2026-03-23T18-00-00.000Z-dev-android',
        success: false,
        status: 'aborted',
        startedAt: '2026-03-23T18:00:00.000Z',
        completedAt: '2026-03-23T18:00:10.000Z',
        durationMs: 10000,
        envName: 'dev',
        platform: 'android',
        modelLabel: 'openai/gpt-5.4-mini',
        appLabel: 'repo app',
        testCount: 2,
        passedCount: 0,
        failedCount: 1,
        stepCount: 1,
        paths: {
          runJson: '2026-03-23T18-00-00.000Z-dev-android/run.json',
          log: '2026-03-23T18-00-00.000Z-dev-android/runner.log',
        },
      },
    ],
  });

  assert.match(output, /^Status {2}Env/m);
  assert.match(output, /ABORT/);
});
