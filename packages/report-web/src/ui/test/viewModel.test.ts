// Characterization tests for the pure view-model layer. These pin what the
// code currently does — the run/test status a user is shown, which failure
// surfaces first, and how artifact paths resolve — against the unmodified
// source. No DOM, no React, no new dependencies.

import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentAction } from '@finalrun/common';
import type {
  ReportManifestSelectedTestRecord,
  ReportManifestTestRecord,
  ReportRunManifest,
} from '../../artifacts';
import {
  buildRunScopedArtifactPath,
  buildTestListItems,
  classifyTestStatus,
  deriveReportTitle,
  formatRelativeTime,
  formatVideoTimestamp,
  reportPayloadForController,
  resolveRunTarget,
  resolveStepReasoning,
  statusLabelLong,
  summarizeTestItems,
  toReportViewModel,
  type ReportTestListItem,
  type TestOutcomeStatus,
} from '../viewModel';

function makeStep(overrides: Partial<AgentAction> = {}): AgentAction {
  return {
    stepNumber: 1,
    iteration: 1,
    actionType: 'tap',
    naturalLanguageAction: 'Tap the button',
    reason: '',
    success: true,
    status: 'success',
    timestamp: '2026-07-27T10:00:00.000Z',
    ...overrides,
  };
}

function makeTestRecord(
  overrides: Partial<ReportManifestTestRecord> = {},
): ReportManifestTestRecord {
  return {
    testId: 'test-1',
    testName: 'Login works',
    sourcePath: '/abs/tests/login.yaml',
    relativePath: 'login.yaml',
    success: true,
    status: 'success',
    message: 'ok',
    platform: 'android',
    startedAt: '2026-07-27T10:00:00.000Z',
    completedAt: '2026-07-27T10:00:05.000Z',
    durationMs: 5000,
    steps: [],
    ...overrides,
  };
}

function makeSelected(
  overrides: Partial<ReportManifestSelectedTestRecord> = {},
): ReportManifestSelectedTestRecord {
  return {
    name: 'Login works',
    testId: 'test-1',
    relativePath: 'login.yaml',
    setup: [],
    steps: [],
    expected_state: [],
    ...overrides,
  };
}

function makeManifest(overrides: Partial<ReportRunManifest> = {}): ReportRunManifest {
  return {
    schemaVersion: 3,
    run: {
      runId: 'run-42',
      success: true,
      status: 'success',
      startedAt: '2026-07-27T10:00:00.000Z',
      completedAt: '2026-07-27T10:01:00.000Z',
      durationMs: 60000,
      envName: 'default',
      platform: 'android',
      model: { provider: 'anthropic', modelName: 'claude', label: 'Claude' },
      app: { source: 'config', label: 'app.apk' },
      selectors: [],
      counts: {
        tests: { total: 1, passed: 1, failed: 0 },
        steps: { total: 1, passed: 1, failed: 0 },
      },
    },
    input: {
      environment: { envName: 'default', variables: {}, secretReferences: [] },
      tests: [],
      cli: { command: 'run', selectors: [], debug: false },
    },
    tests: [],
    paths: { runJson: 'run.json', summaryJson: 'summary.json', log: 'run.log' },
    ...overrides,
  };
}

// --- classifyTestStatus: the status a user is told ---

test('classifyTestStatus: aborted wins even when success is true', () => {
  assert.equal(classifyTestStatus(makeTestRecord({ status: 'aborted', success: true })), 'aborted');
});

test('classifyTestStatus: successful test maps to success', () => {
  assert.equal(classifyTestStatus(makeTestRecord({ success: true, status: 'success' })), 'success');
});

test('classifyTestStatus: run_failure FIRST step turns a failed test into an error', () => {
  const rec = makeTestRecord({
    success: false,
    status: 'failure',
    steps: [makeStep({ actionType: 'run_failure' })],
  });
  assert.equal(classifyTestStatus(rec), 'error');
});

test('classifyTestStatus: run_failure NOT at the first step stays a plain failure', () => {
  const rec = makeTestRecord({
    success: false,
    status: 'failure',
    steps: [makeStep({ actionType: 'tap' }), makeStep({ actionType: 'run_failure' })],
  });
  assert.equal(classifyTestStatus(rec), 'failure');
});

test('classifyTestStatus: failed test with no steps maps to failure', () => {
  assert.equal(
    classifyTestStatus(makeTestRecord({ success: false, status: 'failure', steps: [] })),
    'failure',
  );
});

// --- buildTestListItems: which row a user sees per test ---

test('buildTestListItems joins selected tests to executed results by testId', () => {
  const executed = makeTestRecord({ testId: 't1', durationMs: 65000 });
  const manifest = makeManifest({ tests: [executed] });
  manifest.input.tests = [
    makeSelected({ testId: 't1' }),
    makeSelected({ testId: 't2', name: 'Signup works' }),
  ];
  const items = buildTestListItems(manifest);
  assert.equal(items.length, 2);
  assert.equal(items[0]?.status, 'success');
  assert.equal(items[0]?.durationLabel, '1m 5s');
  assert.equal(items[0]?.executed, executed);
  assert.equal(items[1]?.status, 'not_executed');
  assert.equal(items[1]?.durationLabel, 'NA');
  assert.equal(items[1]?.executed, undefined);
});

test('buildTestListItems synthesizes input records when nothing was selected', () => {
  const executed = makeTestRecord({ testId: 't1', status: 'aborted', success: false });
  const items = buildTestListItems(makeManifest({ tests: [executed] }));
  assert.equal(items.length, 1);
  assert.equal(items[0]?.status, 'aborted');
  assert.equal(items[0]?.durationLabel, '5s');
  assert.equal(items[0]?.executed, executed);
  assert.equal(items[0]?.input.name, 'Login works');
  assert.deepEqual(items[0]?.input.setup, []);
  assert.deepEqual(items[0]?.input.steps, []);
  assert.deepEqual(items[0]?.input.expected_state, []);
});

test('summarizeTestItems counts every outcome bucket', () => {
  const statuses: TestOutcomeStatus[] = [
    'success',
    'success',
    'failure',
    'error',
    'aborted',
    'not_executed',
  ];
  const items: ReportTestListItem[] = statuses.map((status) => ({
    input: makeSelected(),
    status,
    durationLabel: 'NA',
  }));
  assert.deepEqual(summarizeTestItems(items), {
    total: 6,
    success: 2,
    aborted: 1,
    failure: 1,
    error: 1,
    notExecuted: 1,
  });
});

// --- deriveReportTitle: what the report is called ---

test('deriveReportTitle prefers the suite name for suite runs', () => {
  const manifest = makeManifest();
  manifest.run.target = { type: 'suite', suiteName: 'Smoke Suite' };
  manifest.input.tests = [makeSelected()];
  assert.equal(deriveReportTitle(manifest), 'Smoke Suite');
});

test('deriveReportTitle uses the single selected test name when no suite name', () => {
  const manifest = makeManifest();
  manifest.input.tests = [makeSelected({ name: 'Login works' })];
  assert.equal(deriveReportTitle(manifest), 'Login works');
});

test('deriveReportTitle falls back to runId when the single test has no name', () => {
  const manifest = makeManifest();
  manifest.input.tests = [makeSelected({ name: '' })];
  assert.equal(deriveReportTitle(manifest), 'run-42');
});

test('deriveReportTitle labels multi-test runs as "+N more"', () => {
  const manifest = makeManifest();
  manifest.input.tests = [
    makeSelected({ name: 'Login works' }),
    makeSelected({ name: 'B' }),
    makeSelected({ name: 'C' }),
  ];
  assert.equal(deriveReportTitle(manifest), 'Login works +2 more');
});

test('deriveReportTitle falls back to runId when nothing was selected', () => {
  assert.equal(deriveReportTitle(makeManifest()), 'run-42');
});

test('resolveRunTarget defaults a missing target to direct', () => {
  assert.deepEqual(resolveRunTarget(makeManifest()), { type: 'direct' });
  const manifest = makeManifest();
  manifest.run.target = { type: 'suite', suiteId: 's1' };
  assert.deepEqual(resolveRunTarget(manifest), { type: 'suite', suiteId: 's1' });
});

// --- artifact path resolution ---

test('buildRunScopedArtifactPath scopes relative paths under /artifacts/<runId>', () => {
  assert.equal(
    buildRunScopedArtifactPath('run-42', 'shots/step 1.png'),
    '/artifacts/run-42/shots/step%201.png',
  );
});

test('buildRunScopedArtifactPath passes absolute HTTP(S) URLs through unchanged', () => {
  assert.equal(
    buildRunScopedArtifactPath('run-42', 'https://cdn.example.com/v.mp4'),
    'https://cdn.example.com/v.mp4',
  );
  assert.equal(
    buildRunScopedArtifactPath('run-42', 'HTTP://cdn.example.com/v.mp4'),
    'HTTP://cdn.example.com/v.mp4',
  );
  assert.equal(
    buildRunScopedArtifactPath('run-42', '//cdn.example.com/v.mp4'),
    '//cdn.example.com/v.mp4',
  );
});

test('toReportViewModel rewrites every relative artifact reference to a run-scoped route', () => {
  const executed = makeTestRecord({
    recordingFile: 'video.mp4',
    deviceLogFile: 'device.log',
    previewScreenshotPath: 'preview.png',
    resultJsonPath: 'result.json',
    snapshotYamlPath: 'snap.yaml',
    snapshotJsonPath: 'snap.json',
    steps: [makeStep({ screenshotFile: 'steps/1.png', stepJsonFile: 'steps/1.json' })],
    firstFailure: { message: 'boom', screenshotPath: 'fail.png', stepJsonPath: 'fail.json' },
  });
  const vm = toReportViewModel(makeManifest({ tests: [executed] }));
  const t = vm.tests[0];
  assert.ok(t, 'exactly one rewritten test record');
  const step = t.steps[0];
  assert.ok(step, 'the rewritten step survives');
  assert.ok(t.firstFailure, 'the rewritten firstFailure survives');
  assert.equal(t.recordingFile, '/artifacts/run-42/video.mp4');
  assert.equal(t.deviceLogFile, '/artifacts/run-42/device.log');
  assert.equal(t.previewScreenshotPath, '/artifacts/run-42/preview.png');
  assert.equal(t.resultJsonPath, '/artifacts/run-42/result.json');
  assert.equal(t.snapshotYamlPath, '/artifacts/run-42/snap.yaml');
  assert.equal(t.snapshotJsonPath, '/artifacts/run-42/snap.json');
  assert.equal(step.screenshotFile, '/artifacts/run-42/steps/1.png');
  assert.equal(step.stepJsonFile, '/artifacts/run-42/steps/1.json');
  assert.equal(t.firstFailure.screenshotPath, '/artifacts/run-42/fail.png');
  assert.equal(t.firstFailure.stepJsonPath, '/artifacts/run-42/fail.json');
  assert.equal(vm.paths.runJson, '/artifacts/run-42/run.json');
  assert.equal(vm.paths.summaryJson, '/artifacts/run-42/summary.json');
  assert.equal(vm.paths.log, '/artifacts/run-42/run.log');
});

test('toReportViewModel rewrites suite and selected-test snapshot paths', () => {
  const manifest = makeManifest();
  manifest.input.suite = {
    name: 'Smoke Suite',
    tests: ['login.yaml'],
    snapshotYamlPath: 'suite.yaml',
    snapshotJsonPath: 'suite.json',
  };
  manifest.input.tests = [makeSelected({ snapshotYamlPath: 'sel.yaml' })];
  const vm = toReportViewModel(manifest);
  assert.equal(vm.input.suite?.snapshotYamlPath, '/artifacts/run-42/suite.yaml');
  assert.equal(vm.input.suite?.snapshotJsonPath, '/artifacts/run-42/suite.json');
  assert.equal(vm.input.tests[0]?.snapshotYamlPath, '/artifacts/run-42/sel.yaml');
  assert.equal(vm.input.tests[0]?.snapshotJsonPath, undefined);
});

test('toReportViewModel leaves absent fields undefined and absolute URLs untouched', () => {
  const executed = makeTestRecord({ recordingFile: 'https://cdn.example.com/v.mp4' });
  const vm = toReportViewModel(makeManifest({ tests: [executed] }));
  assert.equal(vm.tests[0]?.recordingFile, 'https://cdn.example.com/v.mp4');
  assert.equal(vm.tests[0]?.deviceLogFile, undefined);
  assert.equal(vm.tests[0]?.firstFailure, undefined);
  assert.equal(vm.input.suite, undefined);
  assert.equal(vm.paths.runContextJson, undefined);
});

// --- resolveStepReasoning: which explanation surfaces on a step ---

test('resolveStepReasoning returns the first candidate that differs from the title', () => {
  const step = makeStep({
    naturalLanguageAction: 'Tap the button',
    thought: { think: '  Tap the button  ', plan: 'Open the menu first' },
    reason: 'fallback reason',
  });
  assert.equal(resolveStepReasoning(step), 'Open the menu first');
});

test('resolveStepReasoning prefers think over plan when both differ from the title', () => {
  // Precedence pin: the existing tests only exercise think when it EQUALS the
  // title, so swapping the think/plan candidate order would survive them.
  const step = makeStep({
    naturalLanguageAction: 'Tap the button',
    thought: { think: 'Check the toolbar first', plan: 'Open the menu first' },
    reason: 'fallback reason',
  });
  assert.equal(resolveStepReasoning(step), 'Check the toolbar first');
});

test('resolveStepReasoning falls back to reason and trims whitespace', () => {
  const step = makeStep({ naturalLanguageAction: 'Tap', reason: '  do it carefully  ' });
  assert.equal(resolveStepReasoning(step), 'do it carefully');
});

test('resolveStepReasoning returns undefined when nothing differs from the title', () => {
  const step = makeStep({ naturalLanguageAction: 'Tap', thought: { think: 'Tap' }, reason: ' ' });
  assert.equal(resolveStepReasoning(step), undefined);
});

test('resolveStepReasoning titles by actionType when naturalLanguageAction is empty', () => {
  const step = makeStep({ naturalLanguageAction: '', actionType: 'tap', reason: 'tap' });
  assert.equal(resolveStepReasoning(step), undefined);
});

// --- time and label formatting ---

test('formatRelativeTime buckets minutes/hours/days/weeks against a frozen clock', () => {
  const realNow = Date.now;
  Date.now = () => new Date('2026-07-27T12:00:00.000Z').getTime();
  try {
    assert.equal(formatRelativeTime('2026-07-27T11:59:30.000Z'), 'just now');
    assert.equal(formatRelativeTime('2026-07-27T11:15:00.000Z'), '45m');
    assert.equal(formatRelativeTime('2026-07-27T09:00:00.000Z'), '3h');
    // 24h→day boundary from both sides: 23h stays in the hours bucket, exactly
    // 24h tips into days (the existing 3h/3d values cannot see a moved boundary).
    assert.equal(formatRelativeTime('2026-07-26T13:00:00.000Z'), '23h');
    assert.equal(formatRelativeTime('2026-07-26T12:00:00.000Z'), '1d');
    assert.equal(formatRelativeTime('2026-07-24T12:00:00.000Z'), '3d');
    assert.equal(formatRelativeTime('2026-07-06T12:00:00.000Z'), '3w');
    assert.equal(formatRelativeTime('2026-07-27T13:00:00.000Z'), 'just now');
  } finally {
    Date.now = realNow;
  }
});

test('formatVideoTimestamp renders mm:ss with zero and undefined clamped to 00:00', () => {
  assert.equal(formatVideoTimestamp(undefined), '00:00');
  assert.equal(formatVideoTimestamp(0), '00:00');
  assert.equal(formatVideoTimestamp(-500), '00:00');
  assert.equal(formatVideoTimestamp(1499), '00:01');
  // Truncation boundary: 1900ms must truncate DOWN to 00:01 (1499 rounds the
  // same under Math.round and Math.floor; only this value pins the floor).
  assert.equal(formatVideoTimestamp(1900), '00:01');
  assert.equal(formatVideoTimestamp(65000), '01:05');
  assert.equal(formatVideoTimestamp(3661000), '61:01');
});

test('statusLabelLong maps every outcome to its user-facing label', () => {
  assert.equal(statusLabelLong('success'), 'Passed');
  assert.equal(statusLabelLong('failure'), 'Failed');
  assert.equal(statusLabelLong('error'), 'Error');
  assert.equal(statusLabelLong('aborted'), 'Aborted');
  assert.equal(statusLabelLong('not_executed'), 'Not executed');
});

// --- controller payload ---

test('reportPayloadForController strips everything but recording and seek data', () => {
  const executed = makeTestRecord({
    recordingFile: 'v.mp4',
    steps: [makeStep({ videoOffsetMs: 1200, screenshotFile: 's.png' })],
  });
  const payload = reportPayloadForController(makeManifest({ tests: [executed] }));
  assert.deepEqual(payload, {
    tests: [
      {
        testId: 'test-1',
        recordingFile: 'v.mp4',
        steps: [{ videoOffsetMs: 1200, screenshotFile: 's.png' }],
      },
    ],
  });
});
