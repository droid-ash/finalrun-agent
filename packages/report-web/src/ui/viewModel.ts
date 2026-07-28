// View-model helpers lifted verbatim from the legacy renderers.ts so the
// React components render the same data shape byte-for-byte. Pure functions
// only — no Node deps, safe to import from client components.

import type { AgentAction, RunTarget } from '@finalrun/common';
import type {
  ReportManifestSelectedTestRecord,
  ReportManifestTestRecord,
  ReportRunManifest,
} from '../artifacts';
import { buildArtifactRoute } from './routes';
import { formatLongDuration } from './format';

export type TestOutcomeStatus =
  | 'success'
  | 'failure'
  | 'error'
  | 'aborted'
  | 'not_executed';

export interface ReportTestListItem {
  input: ReportManifestSelectedTestRecord;
  executed?: ReportManifestTestRecord;
  status: TestOutcomeStatus;
  durationLabel: string;
}

export interface OutcomeSummary {
  total: number;
  success: number;
  aborted: number;
  failure: number;
  error: number;
  notExecuted: number;
}

export function toReportViewModel(manifest: ReportRunManifest): ReportRunManifest {
  const runId = manifest.run.runId;
  return {
    ...manifest,
    input: {
      ...manifest.input,
      suite: manifest.input.suite
        ? {
            ...manifest.input.suite,
            snapshotYamlPath: manifest.input.suite.snapshotYamlPath
              ? buildRunScopedArtifactPath(runId, manifest.input.suite.snapshotYamlPath)
              : undefined,
            snapshotJsonPath: manifest.input.suite.snapshotJsonPath
              ? buildRunScopedArtifactPath(runId, manifest.input.suite.snapshotJsonPath)
              : undefined,
          }
        : undefined,
      tests: manifest.input.tests.map((test) => toSelectedTestViewModel(runId, test)),
    },
    tests: manifest.tests.map((test) => toTestViewModel(runId, test)),
    paths: {
      ...manifest.paths,
      runJson: buildRunScopedArtifactPath(runId, manifest.paths.runJson),
      summaryJson: buildRunScopedArtifactPath(runId, manifest.paths.summaryJson),
      log: buildRunScopedArtifactPath(runId, manifest.paths.log),
      runContextJson: manifest.paths.runContextJson
        ? buildRunScopedArtifactPath(runId, manifest.paths.runContextJson)
        : undefined,
    },
  };
}

function toSelectedTestViewModel(
  runId: string,
  test: ReportManifestSelectedTestRecord,
): ReportManifestSelectedTestRecord {
  return {
    ...test,
    snapshotYamlPath: test.snapshotYamlPath
      ? buildRunScopedArtifactPath(runId, test.snapshotYamlPath)
      : undefined,
    snapshotJsonPath: test.snapshotJsonPath
      ? buildRunScopedArtifactPath(runId, test.snapshotJsonPath)
      : undefined,
  };
}

function toTestViewModel(runId: string, test: ReportManifestTestRecord): ReportManifestTestRecord {
  return {
    ...test,
    snapshotYamlPath: test.snapshotYamlPath
      ? buildRunScopedArtifactPath(runId, test.snapshotYamlPath)
      : undefined,
    snapshotJsonPath: test.snapshotJsonPath
      ? buildRunScopedArtifactPath(runId, test.snapshotJsonPath)
      : undefined,
    previewScreenshotPath: test.previewScreenshotPath
      ? buildRunScopedArtifactPath(runId, test.previewScreenshotPath)
      : undefined,
    resultJsonPath: test.resultJsonPath
      ? buildRunScopedArtifactPath(runId, test.resultJsonPath)
      : undefined,
    recordingFile: test.recordingFile
      ? buildRunScopedArtifactPath(runId, test.recordingFile)
      : undefined,
    deviceLogFile: test.deviceLogFile
      ? buildRunScopedArtifactPath(runId, test.deviceLogFile)
      : undefined,
    steps: test.steps.map((step) => ({
      ...step,
      screenshotFile: step.screenshotFile
        ? buildRunScopedArtifactPath(runId, step.screenshotFile)
        : undefined,
      stepJsonFile: step.stepJsonFile
        ? buildRunScopedArtifactPath(runId, step.stepJsonFile)
        : undefined,
    })),
    firstFailure: test.firstFailure
      ? {
          ...test.firstFailure,
          screenshotPath: test.firstFailure.screenshotPath
            ? buildRunScopedArtifactPath(runId, test.firstFailure.screenshotPath)
            : undefined,
          stepJsonPath: test.firstFailure.stepJsonPath
            ? buildRunScopedArtifactPath(runId, test.firstFailure.stepJsonPath)
            : undefined,
        }
      : undefined,
  };
}

export function buildRunScopedArtifactPath(runId: string, relativePath: string): string {
  // OSS uses this to turn a disk-relative path into an /artifacts/<runId>/…
  // HTTP route served by the local report server. Cloud, however, stores
  // asset references as absolute S3 (or other CDN) URLs — those must be
  // passed through unchanged. Without this guard the URL gets encoded
  // into a broken local path (e.g. `/artifacts/<runId>/https%3A//…`) and
  // <video>/<img> fail to load.
  if (isAbsoluteHttpUrl(relativePath)) return relativePath;
  return buildArtifactRoute(`${runId}/${relativePath}`);
}

function isAbsoluteHttpUrl(value: string): boolean {
  return /^(?:https?:)?\/\//i.test(value);
}

export function buildTestListItems(manifest: ReportRunManifest): ReportTestListItem[] {
  const executedById = new Map(manifest.tests.map((test) => [test.testId, test]));
  const selectedTests = manifest.input.tests;
  if (selectedTests.length === 0) {
    return manifest.tests.map((test) => ({
      input: {
        testId: test.testId,
        name: test.testName,
        relativePath: test.relativePath,
        workspaceSourcePath: test.workspaceSourcePath,
        snapshotYamlPath: test.snapshotYamlPath,
        snapshotJsonPath: test.snapshotJsonPath,
        snapshotYamlText: test.snapshotYamlText,
        bindingReferences: test.bindingReferences,
        setup: [],
        steps: [],
        expected_state: [],
      },
      executed: test,
      status: classifyTestStatus(test),
      durationLabel: formatLongDuration(test.durationMs),
    }));
  }

  return selectedTests.map((selected) => {
    const executed = executedById.get(selected.testId!);
    return {
      input: selected,
      executed,
      status: executed ? classifyTestStatus(executed) : 'not_executed',
      durationLabel: executed ? formatLongDuration(executed.durationMs) : 'NA',
    };
  });
}

export function summarizeTestItems(items: ReportTestListItem[]): OutcomeSummary {
  return items.reduce<OutcomeSummary>(
    (summary, item) => {
      summary.total += 1;
      if (item.status === 'success') summary.success += 1;
      else if (item.status === 'aborted') summary.aborted += 1;
      else if (item.status === 'failure') summary.failure += 1;
      else if (item.status === 'error') summary.error += 1;
      else summary.notExecuted += 1;
      return summary;
    },
    { total: 0, success: 0, aborted: 0, failure: 0, error: 0, notExecuted: 0 },
  );
}

export function classifyTestStatus(test: ReportManifestTestRecord): TestOutcomeStatus {
  if (test.status === 'aborted') return 'aborted';
  if (test.success) return 'success';
  if (test.steps[0]?.actionType === 'run_failure') return 'error';
  return 'failure';
}

export function resolveRunTarget(manifest: ReportRunManifest): RunTarget {
  return manifest.run.target ?? { type: 'direct' };
}

export function deriveReportTitle(manifest: ReportRunManifest): string {
  const target = resolveRunTarget(manifest);
  if (target.type === 'suite' && target.suiteName) {
    return target.suiteName;
  }

  if (manifest.input.tests.length === 1) {
    return manifest.input.tests[0]?.name || manifest.run.runId;
  }

  if (manifest.input.tests.length > 1) {
    const first = manifest.input.tests[0];
    return `${first?.name || 'Selected tests'} +${manifest.input.tests.length - 1} more`;
  }

  return manifest.run.runId;
}

export function resolveStepReasoning(step: AgentAction): string | undefined {
  const title = normalizeStepText(step.naturalLanguageAction || step.actionType);
  for (const candidate of [step.thought?.think, step.thought?.plan, step.reason]) {
    const normalized = normalizeStepText(candidate);
    if (!normalized || normalized === title) {
      continue;
    }
    return normalized;
  }
  return undefined;
}

function normalizeStepText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export function formatRelativeTime(timestamp: string): string {
  // No clamp needed: a future timestamp floors to a negative totalMinutes,
  // which the `< 1` branch below maps to 'just now' exactly as 0 would.
  const deltaMs = Date.now() - new Date(timestamp).getTime();
  const totalMinutes = Math.floor(deltaMs / 60000);
  if (totalMinutes < 1) return 'just now';
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) return `${totalHours}h`;
  const totalDays = Math.floor(totalHours / 24);
  if (totalDays < 7) return `${totalDays}d`;
  const totalWeeks = Math.floor(totalDays / 7);
  return `${totalWeeks}w`;
}

export function formatVideoTimestamp(videoOffsetMs: number | undefined): string {
  if (videoOffsetMs === undefined) return '00:00';
  const wholeSeconds = Math.floor(Math.max(0, videoOffsetMs / 1000));
  const minutesPart = Math.floor(wholeSeconds / 60);
  const secondsPart = wholeSeconds % 60;
  return `${String(minutesPart).padStart(2, '0')}:${String(secondsPart).padStart(2, '0')}`;
}

export function statusLabelLong(status: TestOutcomeStatus): string {
  if (status === 'error') return 'Error';
  if (status === 'aborted') return 'Aborted';
  if (status === 'failure') return 'Failed';
  if (status === 'not_executed') return 'Not executed';
  return 'Passed';
}

// Reduced payload handed to the interactive controller. Only carries the
// fields the DOM-level logic needs (recording + per-step seek offsets +
// screenshot URLs for the cloud fallback path), so the script tag stays
// small even on huge suite runs.
export function reportPayloadForController(manifest: ReportRunManifest): {
  tests: Array<{
    testId: string;
    recordingFile?: string | null;
    steps: Array<{ videoOffsetMs?: number | null; screenshotFile?: string | null }>;
  }>;
} {
  return {
    tests: manifest.tests.map((test) => ({
      testId: test.testId,
      recordingFile: test.recordingFile,
      steps: test.steps.map((step) => ({
        videoOffsetMs: step.videoOffsetMs,
        screenshotFile: step.screenshotFile,
      })),
    })),
  };
}
