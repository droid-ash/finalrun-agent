import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { openAsBlob } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import AdmZip from 'adm-zip';
import { Logger } from '@finalrun/common';
import { prepareAppForUpload, type PreparedApp } from './appBundle.js';
import { parseTimeoutMsFromEnv } from './timeoutEnv.js';

// Minimal projection of the CLI's CheckRunnerResult needed by submission.
// Cloud-core does not depend on the CLI's check pipeline; the orchestrator
// (CLI bin) is responsible for producing this shape.
export interface CheckedSpecs {
  tests: Array<{
    sourcePath?: string;
    relativePath?: string;
    name?: string;
  }>;
  suite?: {
    sourcePath?: string;
    relativePath?: string;
    name?: string;
  };
}

export interface SubmitRunInput {
  /** Pre-validated tests + (optional) suite produced by the CLI's checkRunner. */
  checked: CheckedSpecs;
  /** Workspace root containing .finalrun/config.yaml and .finalrun/env/. */
  workspaceRoot: string;
  /** Original positional selectors from the CLI invocation (for display + form data). */
  selectors: string[];
  suitePath?: string;
  envName?: string;
  platform?: string;
  appPath?: string;
  /** Non-secret variables from the env YAML, recorded on the run row.
   *  Secrets are intentionally not forwarded. */
  variables?: Record<string, string>;
  /** Verbatim CLI invocation string for the run record (e.g. "finalrun cloud test ..."). */
  command: string;
  /** Cloud service base URL. */
  cloudUrl: string;
  /** API key sent in the Authorization header. */
  apiKey: string;
}

export interface SubmitRunResult {
  runId: string;
  statusUrl: string;
  appFilename?: string;
}

// Generous timeout to accommodate large APK/IPA uploads on slow uplinks while
// still catching genuinely stalled connections. Override with
// FINALRUN_SUBMIT_TIMEOUT_MS for ultra-large uploads or low-bandwidth tests.
const SUBMIT_TIMEOUT_MS = parseTimeoutMsFromEnv('FINALRUN_SUBMIT_TIMEOUT_MS', 30 * 60 * 1000);

type AppMode = { type: 'file'; prepared: PreparedApp } | { type: 'server-default' };

interface FileToZip {
  absolutePath: string;
  relativePath: string;
}

/** Minimal projection of the ora spinner used by the submission phases.
 *  ora is ESM-only and loaded via dynamic import inside submitRun, so a
 *  structural view avoids a CJS type-import resolution-mode coupling. */
interface SubmitSpinner {
  fail(text?: string): void;
  succeed(text?: string): void;
}

/** Per-call state shared by the submission phases below. */
interface SubmissionContext {
  readonly input: SubmitRunInput;
  readonly appMode: AppMode;
  readonly spinner: SubmitSpinner;
  readonly uploadStart: number;
  /** Seconds elapsed when the response arrived, formatted; set after the fetch resolves. */
  elapsed: string;
}

export async function submitRun(input: SubmitRunInput): Promise<SubmitRunResult> {
  Logger.i('Preparing cloud run...');

  const appMode = resolveAppMode(input);

  // Each temp file is released by a finally whose try opens immediately after
  // its acquisition: the outer scope covers the temp .app.zip that
  // resolveAppMode may have prepared (so a throw while collecting or zipping
  // specs cannot orphan it), and the inner scope covers the spec zip written
  // just above it. The inner finally runs first, so the spec zip is unlinked
  // before the app zip.
  try {
    const filesToZip = collectFilesToZip(input);

    Logger.i(`Zipping ${filesToZip.length} file(s)...`);
    const zipPath = writeSpecZip(filesToZip);

    try {
      const formData = await buildSubmissionForm(input, appMode, zipPath);
      const spinnerMessage = buildSpinnerMessage(input, appMode);
      const uploadStart = Date.now();
      const { default: ora } = await import('ora');
      const ctx: SubmissionContext = {
        input,
        appMode,
        spinner: ora(spinnerMessage).start(),
        uploadStart,
        elapsed: '',
      };

      const response = await sendSubmitRequest(ctx, formData);
      ctx.elapsed = ((Date.now() - ctx.uploadStart) / 1000).toFixed(1);
      const runId = await parseSubmitResponse(ctx, response);
      return reportSubmitSuccess(ctx, runId);
    } finally {
      try {
        fs.unlinkSync(zipPath);
      } catch {
        // ignore cleanup errors
      }
    }
  } finally {
    if (appMode.type === 'file' && appMode.prepared.isTempZip) {
      try {
        fs.unlinkSync(appMode.prepared.uploadPath);
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

// Resolve app — either from --app flag or let the server auto-pick
// the latest app_upload for this org + platform at submit time.
// Client-side inspection was intentionally removed: the server validates
// the binary (platform, simulator-compatibility, packageName) authoritatively
// after upload, and dropping the inspection step keeps the slim binary lean.
// For .app directories (iOS simulator builds), prepareAppForUpload zips
// them on the fly into a temp .app.zip; submitRun's OUTER finally cleans that
// up — outer because it must cover spec collection and zipping too.
function resolveAppMode(input: SubmitRunInput): AppMode {
  if (input.appPath) {
    return { type: 'file', prepared: prepareAppForUpload(input.appPath) };
  }
  const platformLabel = input.platform?.trim() || 'the run target';
  console.log(`\n  No --app provided; server will use the latest app uploaded for ${platformLabel}.\n`);
  return { type: 'server-default' };
}

function collectFilesToZip(input: SubmitRunInput): FileToZip[] {
  const filesToZip: FileToZip[] = [];

  if (input.checked.suite?.sourcePath && input.checked.suite.relativePath) {
    filesToZip.push({
      absolutePath: input.checked.suite.sourcePath,
      relativePath: path.join('suites', input.checked.suite.relativePath),
    });
  }

  for (const spec of input.checked.tests) {
    if (!spec.sourcePath || !spec.relativePath) continue;
    filesToZip.push({
      absolutePath: spec.sourcePath,
      relativePath: path.join('tests', spec.relativePath),
    });
  }

  const configPath = path.join(input.workspaceRoot, '.finalrun', 'config.yaml');
  if (fs.existsSync(configPath)) {
    filesToZip.push({
      absolutePath: configPath,
      relativePath: 'config.yaml',
    });
  }

  // Ship the env file matching the *resolved* env name the caller computed
  // (--env if passed, else config.yaml's `env:` field, else nothing). The
  // CLI orchestrator passes the resolved value here, not the raw flag, so
  // a workspace with `env: dev` in config.yaml gets env/dev.yaml shipped
  // even when the user didn't repeat --env=dev on the command line.
  // Uploading just the one in-use env file (instead of every YAML under
  // .finalrun/env/) avoids leaking other environments' bindings to the
  // cloud submission.
  if (input.envName) {
    const envDir = path.join(input.workspaceRoot, '.finalrun', 'env');
    const candidates = [`${input.envName}.yaml`, `${input.envName}.yml`];
    for (const candidate of candidates) {
      const envPath = path.join(envDir, candidate);
      if (fs.existsSync(envPath)) {
        filesToZip.push({
          absolutePath: envPath,
          relativePath: path.join('env', candidate),
        });
        break;
      }
    }
  }

  return filesToZip;
}

function writeSpecZip(filesToZip: FileToZip[]): string {
  const zip = new AdmZip();
  for (const file of filesToZip) {
    const dir = path.dirname(file.relativePath);
    zip.addLocalFile(file.absolutePath, dir);
  }

  // Timestamp keeps an orphaned temp file diagnosable; the random component is
  // what makes concurrent submissions collision-proof (same-millisecond runs
  // would otherwise share one path and corrupt/unlink each other's upload).
  const zipPath = path.join(os.tmpdir(), `finalrun-cloud-${Date.now()}-${randomUUID()}.zip`);
  zip.writeZip(zipPath);
  return zipPath;
}

// Display name: suite name for suite runs, test name for single-test runs,
// "<first> + N more" for multi-test runs, null otherwise.
function deriveRunName(input: SubmitRunInput): string | null {
  if (input.suitePath) {
    return input.checked.suite?.name ?? path.basename(input.suitePath, path.extname(input.suitePath));
  }
  if (input.checked.tests.length === 1) {
    return input.checked.tests[0]?.name ?? null;
  }
  if (input.checked.tests.length > 1) {
    const first = input.checked.tests[0]?.name ?? path.basename(input.checked.tests[0]?.relativePath ?? '');
    const remaining = input.checked.tests.length - 1;
    return `${first} + ${remaining} more`;
  }
  return null;
}

// Run type classification. The server falls back to its own classification
// if this field is omitted.
function deriveRunType(input: SubmitRunInput): 'single_test' | 'multi_test' | 'suite' {
  if (input.suitePath) return 'suite';
  return input.checked.tests.length === 1 ? 'single_test' : 'multi_test';
}

async function buildSubmissionForm(
  input: SubmitRunInput,
  appMode: AppMode,
  zipPath: string,
): Promise<FormData> {
  const formData = new FormData();
  const zipBuffer = fs.readFileSync(zipPath);
  formData.append('file', new Blob([zipBuffer]), 'specs.zip');
  formData.append('command', input.command);
  formData.append('selectors', JSON.stringify(input.selectors));
  formData.append('runType', deriveRunType(input));

  const runName = deriveRunName(input);
  if (runName) {
    formData.append('name', runName);
  }
  if (input.suitePath) {
    formData.append('suitePath', input.suitePath);
  }
  if (input.envName) {
    formData.append('envName', input.envName);
  }
  if (input.variables && Object.keys(input.variables).length > 0) {
    formData.append('variables', JSON.stringify(input.variables));
  }
  if (input.platform) {
    formData.append('platform', input.platform);
  }

  if (appMode.type === 'file') {
    // Stream the file into the multipart body so a large APK/.app.zip isn't
    // pulled into memory just to wrap as a Blob.
    const { uploadPath, filename: appFileName } = appMode.prepared;
    const appBlob = await openAsBlob(uploadPath);
    formData.append('appFile', appBlob, appFileName);
    formData.append('appFilename', appFileName);
  }

  return formData;
}

function buildSpinnerMessage(input: SubmitRunInput, appMode: AppMode): string {
  const submissionLabel = input.suitePath
    ? `suite ${path.basename(input.suitePath)} (${input.checked.tests.length} test(s))`
    : `${input.checked.tests.length} test(s)`;

  if (appMode.type === 'file') {
    const { filename, size } = appMode.prepared;
    return `Uploading ${filename} (${formatBytes(size)}) and submitting ${submissionLabel}...`;
  }
  // server-default: no app fields on the request; server picks latest
  return `Submitting ${submissionLabel} (using latest uploaded app)...`;
}

async function sendSubmitRequest(ctx: SubmissionContext, formData: FormData): Promise<Response> {
  const url = `${ctx.input.cloudUrl}/api/v1/execute`;
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ctx.input.apiKey}` },
      body: formData,
      signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
    });
  } catch (e) {
    const elapsed = ((Date.now() - ctx.uploadStart) / 1000).toFixed(1);
    const isTimeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    ctx.spinner.fail(
      isTimeout
        ? `Upload timed out after ${elapsed}s — connection stalled.`
        : `Upload failed after ${elapsed}s`,
    );
    throw e;
  }
}

async function parseSubmitResponse(ctx: SubmissionContext, response: Response): Promise<string> {
  if (response.status !== 201) {
    ctx.spinner.fail(`Submission failed after ${ctx.elapsed}s (HTTP ${response.status})`);
    const body = await response.text();
    throw new Error(`Cloud service returned ${response.status}: ${body}`);
  }

  // Validate response shape before declaring success on the spinner. Wrap
  // the JSON parse so a malformed/empty body (proxy injecting HTML,
  // truncated response) fails the spinner instead of leaving it hung.
  let result: { success: boolean; runId?: string; error?: string };
  try {
    result = await response.json() as typeof result;
  } catch (e) {
    ctx.spinner.fail(`Submission succeeded but server returned an unparseable body`);
    throw e;
  }
  if (!result.success || !result.runId) {
    ctx.spinner.fail(`Submission rejected by server`);
    throw new Error(
      `Cloud submission failed: ${result.error ?? JSON.stringify(result)}`,
    );
  }
  return result.runId;
}

function reportSubmitSuccess(ctx: SubmissionContext, runId: string): SubmitRunResult {
  const { appMode, input } = ctx;
  if (appMode.type === 'file') {
    ctx.spinner.succeed(`Uploaded ${formatBytes(appMode.prepared.size)} in ${ctx.elapsed}s`);
  } else {
    ctx.spinner.succeed(`Submitted in ${ctx.elapsed}s`);
  }

  // Fire-and-forget: print the polling URL and return.
  const statusUrl = `${input.cloudUrl}/runs/${runId}`;
  console.log(`\n\x1b[32m✓ Run submitted\x1b[0m`);
  console.log(`  Run ID:      ${runId}`);
  console.log(`  Status URL:  ${statusUrl}`);
  console.log(`\n  The run is now queued. Use the status URL above to track progress.`);

  let appFilename: string | undefined;
  if (appMode.type === 'file') {
    appFilename = appMode.prepared.filename;
    console.log(`\n  \x1b[33mTip:\x1b[0m You don't need to upload the app every time. Without --app,`);
    console.log(`       FinalRun uses your latest uploaded app (${appFilename}).`);
  }

  return { runId, statusUrl, appFilename };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
