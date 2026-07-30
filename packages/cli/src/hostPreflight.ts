import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { PLATFORM_ANDROID, PLATFORM_IOS, type DeviceNodeResponse } from '@finalrun/common';
import { AndroidRecordingProvider, CliFilePathUtil, IOSRecordingProvider } from '@finalrun/device-node';

const execFileAsync = promisify(execFile);

export type HostPreflightRequestedPlatform =
  | typeof PLATFORM_ANDROID
  | typeof PLATFORM_IOS
  | 'all';

export type HostPreflightCheckedPlatform =
  | typeof PLATFORM_ANDROID
  | typeof PLATFORM_IOS;

export type HostPreflightPlatform =
  | HostPreflightCheckedPlatform
  | 'common';

export type HostPreflightStatus = 'ok' | 'error' | 'warning';

export interface HostPreflightCheck {
  platform: HostPreflightPlatform;
  status: HostPreflightStatus;
  id: string;
  title: string;
  summary: string;
  detail?: string;
  blocking: boolean;
}

export interface HostPreflightResult {
  requestedPlatforms: HostPreflightCheckedPlatform[];
  checks: HostPreflightCheck[];
}

export interface HostPreflightFilePathUtil {
  getADBPath(): Promise<string | null>;
  getDriverAppPath(): Promise<string | null>;
  getDriverTestAppPath(): Promise<string | null>;
  getResourceDir(): string;
}

export interface HostPreflightDependencies {
  createFilePathUtil(): HostPreflightFilePathUtil;
  execFile(file: string, args: readonly string[]): Promise<{
    stdout: string | Buffer;
    stderr: string | Buffer;
  }>;
  resolveCommand(command: string): Promise<string | null>;
  pathExists(candidatePath: string): Promise<boolean>;
  getPlatform(): NodeJS.Platform;
  checkAndroidRecordingAvailability(): Promise<DeviceNodeResponse>;
  checkIOSRecordingAvailability(): Promise<DeviceNodeResponse>;
}

/** POSIX command locator. */
const POSIX_COMMAND_LOCATOR = 'which';
/** Windows has no `which`; `where` is its equivalent. */
const WINDOWS_COMMAND_LOCATOR = 'where';

/**
 * Resolves `command` to an absolute path, or `null` when it is not on PATH.
 *
 * Branches on the platform because `which` does not exist on Windows: shelling
 * to it unconditionally makes *every* `checkCommandOnPath` result on a Windows
 * host a false negative — the command is reported missing whether or not it is
 * installed. Same `win32` branch shape as `upgradeCommand.ts` and
 * `reportServerManager.ts`, which already handle Windows this way.
 *
 * `where` can print several matches, one per line; the first is what the shell
 * would run, so only that line is taken (`which` prints a single line, so the
 * same split is a no-op there).
 *
 * The `overrides` are defaulted process boundaries — the child-process runner,
 * the platform, and the existence check — so the branch is reachable by a test
 * without stubbing globals.
 */
export async function resolveCommandPath(
  command: string,
  overrides?: {
    platform?: NodeJS.Platform;
    execFile?: HostPreflightDependencies['execFile'];
    access?: (candidatePath: string) => Promise<void>;
  },
): Promise<string | null> {
  const platform = overrides?.platform ?? process.platform;
  const execFileFn = overrides?.execFile ?? execFileAsync;
  const accessFn = overrides?.access ?? ((candidatePath: string) => fs.access(candidatePath));
  const locator = platform === 'win32' ? WINDOWS_COMMAND_LOCATOR : POSIX_COMMAND_LOCATOR;

  try {
    const { stdout } = await execFileFn(locator, [command]);
    const resolvedPath = stdout.toString().split(/\r?\n/)[0]?.trim();
    if (!resolvedPath) {
      return null;
    }
    await accessFn(resolvedPath);
    return resolvedPath;
  } catch {
    return null;
  }
}

export const hostPreflightDependencies: HostPreflightDependencies = {
  createFilePathUtil: () => new CliFilePathUtil(undefined, undefined, { downloadAssets: false }),
  execFile: execFileAsync,
  resolveCommand: async (command) => await resolveCommandPath(command),
  pathExists: async (candidatePath) => {
    try {
      await fs.access(candidatePath);
      return true;
    } catch {
      return false;
    }
  },
  getPlatform: () => process.platform,
  checkAndroidRecordingAvailability: async () =>
    await new AndroidRecordingProvider().checkAvailability(),
  checkIOSRecordingAvailability: async () =>
    await new IOSRecordingProvider().checkAvailability(),
};

export interface RunHostPreflightOptions {
  requestedPlatforms: HostPreflightCheckedPlatform[];
}

export type HostPreflightFormatMode = 'doctor' | 'test';

export async function runHostPreflight(
  options: RunHostPreflightOptions,
  dependencies: HostPreflightDependencies = hostPreflightDependencies,
): Promise<HostPreflightResult> {
  const requestedPlatforms = dedupePlatforms(options.requestedPlatforms);
  const filePathUtil = dependencies.createFilePathUtil();
  const checks: HostPreflightCheck[] = [];

  if (requestedPlatforms.includes(PLATFORM_ANDROID)) {
    checks.push(...await runAndroidChecks(filePathUtil, dependencies));
  }

  if (requestedPlatforms.includes(PLATFORM_IOS)) {
    checks.push(...await runIOSChecks(filePathUtil, dependencies));
  }

  return {
    requestedPlatforms,
    checks,
  };
}

export function resolveDoctorRequestedPlatforms(
  requestedPlatform: string | undefined,
  hostPlatform: NodeJS.Platform = process.platform,
): HostPreflightCheckedPlatform[] {
  const normalized = normalizeRequestedPlatform(requestedPlatform);
  if (normalized === PLATFORM_ANDROID) {
    return [PLATFORM_ANDROID];
  }
  if (normalized === PLATFORM_IOS) {
    return [PLATFORM_IOS];
  }
  if (normalized === 'all') {
    return [PLATFORM_ANDROID, PLATFORM_IOS];
  }
  return hostPlatform === 'darwin'
    ? [PLATFORM_ANDROID, PLATFORM_IOS]
    : [PLATFORM_ANDROID];
}

export function resolveTestRequestedPlatforms(
  requestedPlatform?: string,
): HostPreflightCheckedPlatform[] {
  const normalized = normalizeRequestedPlatform(requestedPlatform);
  if (normalized === PLATFORM_ANDROID) {
    return [PLATFORM_ANDROID];
  }
  if (normalized === PLATFORM_IOS) {
    return [PLATFORM_IOS];
  }
  return [PLATFORM_ANDROID, PLATFORM_IOS];
}

export function hasBlockingPreflightFailures(result: HostPreflightResult): boolean {
  return getBlockingChecks(result).length > 0;
}

export function shouldBlockLocalRunPreflight(result: HostPreflightResult): boolean {
  return result.requestedPlatforms.every((platform) =>
    getBlockingChecksForPlatform(result, platform).length > 0,
  );
}

export function formatHostPreflightReport(
  result: HostPreflightResult,
  mode: HostPreflightFormatMode,
): string {
  if (mode === 'doctor') {
    return formatDoctorReport(result);
  }
  return formatTestReport(result);
}

function formatDoctorReport(result: HostPreflightResult): string {
  const lines: string[] = [];
  for (const check of result.checks) {
    if (check.status === 'ok') {
      lines.push(`  ✓ ${check.title}`);
    } else if (check.status === 'error') {
      lines.push(`  ✗ ${check.title} — ${check.summary}`);
    } else {
      lines.push(`  ⚠ ${check.title} — ${check.summary}`);
    }
  }
  return lines.join('\n');
}

function formatTestReport(result: HostPreflightResult): string {
  const blockedPlatforms = result.requestedPlatforms.filter(
    (platform) => getBlockingChecksForPlatform(result, platform).length > 0,
  );
  if (blockedPlatforms.length === 0) {
    return 'Local device setup is ready.';
  }

  const heading =
    blockedPlatforms.length === 1
      ? `Local device setup is blocked for ${formatPlatformLabel(blockedPlatforms[0]!)}.`
      : 'Local device setup is blocked for Android and iOS.';

  const lines = [heading];
  for (const platform of blockedPlatforms) {
    lines.push('');
    lines.push(`${formatPlatformLabel(platform)} setup required:`);
    for (const check of getBlockingChecksForPlatform(result, platform)) {
      lines.push(...formatCheckLines(check));
    }
  }

  const doctorHint =
    blockedPlatforms.length === 1
      ? `Run 'finalrun doctor --platform ${blockedPlatforms[0]}' for a full readiness check.`
      : "Run 'finalrun doctor' for a full readiness check.";
  lines.push('');
  lines.push(doctorHint);
  return lines.join('\n');
}

function formatCheckLines(check: HostPreflightCheck): string[] {
  const lines = [`- ${check.title}: ${check.summary}`];
  if (check.detail) {
    lines.push(`  ${check.detail}`);
  }
  return lines;
}

function getBlockingChecks(result: HostPreflightResult): HostPreflightCheck[] {
  return result.checks.filter((check) => check.status === 'error' && check.blocking);
}

function getBlockingChecksForPlatform(
  result: HostPreflightResult,
  platform: HostPreflightCheckedPlatform,
): HostPreflightCheck[] {
  return result.checks.filter(
    (check) =>
      check.status === 'error' &&
      check.blocking &&
      (check.platform === platform || check.platform === 'common'),
  );
}

async function runAndroidChecks(
  filePathUtil: HostPreflightFilePathUtil,
  dependencies: HostPreflightDependencies,
): Promise<HostPreflightCheck[]> {
  const checks: HostPreflightCheck[] = [];
  const adbPath = await filePathUtil.getADBPath();
  checks.push(await checkResolvedCommand({
    platform: PLATFORM_ANDROID,
    id: 'adb',
    title: 'adb',
    summary: 'Required to communicate with Android devices.',
    detailWhenMissing:
      'ADB was not found in ANDROID_HOME, ANDROID_SDK_ROOT, or PATH.',
    detailWhenReady: adbPath ?? undefined,
    resolvedPath: adbPath,
    smokeArgs: ['version'],
    blocking: true,
    dependencies,
  }));

  checks.push(await checkCommandOnPath({
    platform: PLATFORM_ANDROID,
    id: 'emulator',
    title: 'emulator',
    summary: 'Required to discover and boot Android Virtual Devices.',
    detailWhenMissing: 'The Android emulator command was not found in PATH.',
    smokeArgs: ['-list-avds'],
    blocking: true,
    dependencies,
  }));

  checks.push(await checkProviderAvailability({
    platform: PLATFORM_ANDROID,
    id: 'scrcpy',
    title: 'scrcpy',
    summary: 'Required for Android screen recording during local runs.',
    response: await dependencies.checkAndroidRecordingAvailability(),
    blocking: true,
  }));

  const resourceDir = filePathUtil.getResourceDir();
  checks.push(await checkResolvedPath({
    platform: PLATFORM_ANDROID,
    id: 'android-driver-apk',
    title: 'Android driver APK',
    summary: 'Required FinalRun Android driver bundle is present.',
    missingSummary: 'Required FinalRun Android driver bundle is missing.',
    resolvedPath: await filePathUtil.getDriverAppPath(),
    fallbackDetail: path.join(resourceDir, 'android', 'app-debug.apk'),
    blocking: true,
    dependencies,
  }));

  checks.push(await checkResolvedPath({
    platform: PLATFORM_ANDROID,
    id: 'android-driver-test-apk',
    title: 'Android test runner APK',
    summary: 'Required FinalRun Android instrumentation bundle is present.',
    missingSummary: 'Required FinalRun Android instrumentation bundle is missing.',
    resolvedPath: await filePathUtil.getDriverTestAppPath(),
    fallbackDetail: path.join(resourceDir, 'android', 'app-debug-androidTest.apk'),
    blocking: true,
    dependencies,
  }));

  return checks;
}

async function runIOSChecks(
  filePathUtil: HostPreflightFilePathUtil,
  dependencies: HostPreflightDependencies,
): Promise<HostPreflightCheck[]> {
  const checks: HostPreflightCheck[] = [];
  const hostPlatform = dependencies.getPlatform();
  checks.push(
    hostPlatform === 'darwin'
      ? createReadyCheck({
        platform: PLATFORM_IOS,
        id: 'macos-host',
        title: 'macOS host',
        summary: 'macOS is available for iOS simulator support.',
        detail: 'darwin',
        blocking: true,
      })
      : createIssueCheck({
        platform: PLATFORM_IOS,
        status: 'error',
        id: 'macos-host',
        title: 'macOS host',
        summary: 'iOS simulator support requires macOS.',
        detail: `Current host platform: ${hostPlatform}`,
        blocking: true,
      }),
  );

  checks.push(await checkCommandOnPath({
    platform: PLATFORM_IOS,
    id: 'xcrun',
    title: 'xcrun',
    summary: 'Required to access iOS simulator tooling.',
    detailWhenMissing: 'xcrun was not found in PATH.',
    smokeArgs: ['--help'],
    blocking: true,
    dependencies,
  }));

  checks.push(await checkProviderAvailability({
    platform: PLATFORM_IOS,
    id: 'xcrun-simctl',
    title: 'xcrun simctl',
    summary: 'Required for iOS simulator recording and control.',
    response: await dependencies.checkIOSRecordingAvailability(),
    blocking: true,
  }));

  checks.push(await checkCommandOnPath({
    platform: PLATFORM_IOS,
    id: 'unzip',
    title: 'unzip',
    summary: 'Required to unpack the bundled iOS driver archives.',
    detailWhenMissing: 'unzip was not found in PATH.',
    smokeArgs: ['-v'],
    blocking: true,
    dependencies,
  }));

  const bashPath = '/bin/bash';
  checks.push(
    await checkFixedPath({
      platform: PLATFORM_IOS,
      id: 'bash',
      title: '/bin/bash',
      summary: 'Required for some iOS simulator shell helpers.',
      detailWhenMissing: `${bashPath} is not available on this host.`,
      candidatePath: bashPath,
      blocking: true,
      dependencies,
    }),
  );

  checks.push(await checkCommandOnPath({
    platform: PLATFORM_IOS,
    id: 'plutil',
    title: 'plutil',
    summary: 'Required to parse simulator app metadata.',
    detailWhenMissing: 'plutil was not found in PATH.',
    smokeArgs: ['-help'],
    blocking: true,
    dependencies,
  }));

  const resourceDir = filePathUtil.getResourceDir();
  checks.push(await checkFixedPath({
    platform: PLATFORM_IOS,
    id: 'ios-driver-archive',
    title: 'iOS driver archive',
    summary: 'Bundled FinalRun iOS driver archive is present.',
    missingSummary: 'Bundled FinalRun iOS driver archive is missing.',
    detailWhenMissing: `Missing ${path.join(resourceDir, 'ios', 'finalrun-ios.zip')}`,
    candidatePath: path.join(resourceDir, 'ios', 'finalrun-ios.zip'),
    blocking: true,
    dependencies,
  }));
  checks.push(await checkFixedPath({
    platform: PLATFORM_IOS,
    id: 'ios-driver-runner-archive',
    title: 'iOS test runner archive',
    summary: 'Bundled FinalRun iOS test runner archive is present.',
    missingSummary: 'Bundled FinalRun iOS test runner archive is missing.',
    detailWhenMissing: `Missing ${path.join(resourceDir, 'ios', 'finalrun-ios-test-Runner.zip')}`,
    candidatePath: path.join(resourceDir, 'ios', 'finalrun-ios-test-Runner.zip'),
    blocking: true,
    dependencies,
  }));

  checks.push(await checkCommandOnPath({
    platform: PLATFORM_IOS,
    id: 'ffmpeg',
    title: 'ffmpeg',
    summary: 'Used to compress iOS recordings after capture.',
    detailWhenMissing: 'ffmpeg was not found in PATH.',
    smokeArgs: ['-version'],
    blocking: false,
    dependencies,
  }));
  checks.push(await checkCommandOnPath({
    platform: PLATFORM_IOS,
    id: 'applesimutils',
    title: 'applesimutils',
    summary: 'Used for simulator permission helpers.',
    detailWhenMissing: 'applesimutils was not found in PATH.',
    smokeArgs: ['--version'],
    blocking: false,
    dependencies,
  }));
  checks.push(await checkCommandOnPath({
    platform: PLATFORM_IOS,
    id: 'lsof',
    title: 'lsof',
    summary: 'Used for stale iOS driver port cleanup.',
    detailWhenMissing: 'lsof was not found in PATH.',
    smokeArgs: ['-v'],
    blocking: false,
    dependencies,
  }));
  checks.push(await checkCommandOnPath({
    platform: PLATFORM_IOS,
    id: 'ps',
    title: 'ps',
    summary: 'Used for stale iOS driver process inspection.',
    detailWhenMissing: 'ps was not found in PATH.',
    smokeArgs: ['-p', String(process.pid)],
    blocking: false,
    dependencies,
  }));
  checks.push(await checkCommandOnPath({
    platform: PLATFORM_IOS,
    id: 'kill',
    title: 'kill',
    summary: 'Used for stale iOS driver process cleanup.',
    detailWhenMissing: 'kill was not found in PATH.',
    smokeArgs: ['-l'],
    blocking: false,
    dependencies,
  }));

  return checks;
}

async function checkProviderAvailability(params: {
  platform: HostPreflightPlatform;
  id: string;
  title: string;
  summary: string;
  response: DeviceNodeResponse;
  blocking: boolean;
}): Promise<HostPreflightCheck> {
  if (params.response.success) {
    return createReadyCheck({
      platform: params.platform,
      id: params.id,
      title: params.title,
      summary: params.summary,
      detail: params.response.message ?? undefined,
      blocking: params.blocking,
    });
  }

  return createIssueCheck({
    platform: params.platform,
    status: params.blocking ? 'error' : 'warning',
    id: params.id,
    title: params.title,
    summary: params.summary,
    detail: params.response.message ?? undefined,
    blocking: params.blocking,
  });
}

async function checkCommandOnPath(params: {
  platform: HostPreflightPlatform;
  id: string;
  title: string;
  summary: string;
  detailWhenMissing: string;
  smokeArgs: readonly string[];
  blocking: boolean;
  dependencies: HostPreflightDependencies;
}): Promise<HostPreflightCheck> {
  const resolvedPath = await params.dependencies.resolveCommand(params.title);
  return await checkResolvedCommand({
    platform: params.platform,
    id: params.id,
    title: params.title,
    summary: params.summary,
    detailWhenMissing: params.detailWhenMissing,
    detailWhenReady: resolvedPath ?? undefined,
    resolvedPath,
    smokeArgs: params.smokeArgs,
    blocking: params.blocking,
    dependencies: params.dependencies,
  });
}

async function checkResolvedCommand(params: {
  platform: HostPreflightPlatform;
  id: string;
  title: string;
  summary: string;
  detailWhenMissing: string;
  detailWhenReady?: string;
  resolvedPath: string | null;
  smokeArgs: readonly string[];
  blocking: boolean;
  dependencies: HostPreflightDependencies;
}): Promise<HostPreflightCheck> {
  if (!params.resolvedPath) {
    return createIssueCheck({
      platform: params.platform,
      status: params.blocking ? 'error' : 'warning',
      id: params.id,
      title: params.title,
      summary: params.summary,
      detail: params.detailWhenMissing,
      blocking: params.blocking,
    });
  }

  try {
    await params.dependencies.execFile(params.resolvedPath, params.smokeArgs);
    return createReadyCheck({
      platform: params.platform,
      id: params.id,
      title: params.title,
      summary: params.summary,
      detail: params.detailWhenReady,
      blocking: params.blocking,
    });
  } catch (error) {
    return createIssueCheck({
      platform: params.platform,
      status: params.blocking ? 'error' : 'warning',
      id: params.id,
      title: params.title,
      summary: params.summary,
      detail: formatCommandFailure(params.resolvedPath, params.smokeArgs, error),
      blocking: params.blocking,
    });
  }
}

async function checkResolvedPath(params: {
  platform: HostPreflightPlatform;
  id: string;
  title: string;
  summary: string;
  missingSummary: string;
  resolvedPath: string | null;
  fallbackDetail: string;
  blocking: boolean;
  dependencies: HostPreflightDependencies;
}): Promise<HostPreflightCheck> {
  if (params.resolvedPath) {
    return createReadyCheck({
      platform: params.platform,
      id: params.id,
      title: params.title,
      summary: params.summary,
      detail: params.resolvedPath,
      blocking: params.blocking,
    });
  }

  return createIssueCheck({
    platform: params.platform,
    status: params.blocking ? 'error' : 'warning',
    id: params.id,
    title: params.title,
    summary: params.missingSummary,
    detail: params.fallbackDetail,
    blocking: params.blocking,
  });
}

async function checkFixedPath(params: {
  platform: HostPreflightPlatform;
  id: string;
  title: string;
  summary: string;
  missingSummary?: string;
  detailWhenMissing: string;
  candidatePath: string;
  blocking: boolean;
  dependencies: HostPreflightDependencies;
}): Promise<HostPreflightCheck> {
  if (await params.dependencies.pathExists(params.candidatePath)) {
    return createReadyCheck({
      platform: params.platform,
      id: params.id,
      title: params.title,
      summary: params.summary,
      detail: params.candidatePath,
      blocking: params.blocking,
    });
  }

  return createIssueCheck({
    platform: params.platform,
    status: params.blocking ? 'error' : 'warning',
    id: params.id,
    title: params.title,
    summary: params.missingSummary ?? params.summary,
    detail: params.detailWhenMissing,
    blocking: params.blocking,
  });
}

function createReadyCheck(params: {
  platform: HostPreflightPlatform;
  id: string;
  title: string;
  summary: string;
  detail?: string;
  blocking: boolean;
}): HostPreflightCheck {
  return {
    platform: params.platform,
    status: 'ok',
    id: params.id,
    title: params.title,
    summary: params.summary,
    detail: params.detail,
    blocking: params.blocking,
  };
}

function createIssueCheck(params: {
  platform: HostPreflightPlatform;
  status: 'error' | 'warning';
  id: string;
  title: string;
  summary: string;
  detail?: string;
  blocking: boolean;
}): HostPreflightCheck {
  return {
    platform: params.platform,
    status: params.status,
    id: params.id,
    title: params.title,
    summary: params.summary,
    detail: params.detail,
    blocking: params.blocking,
  };
}

function formatCommandFailure(
  file: string,
  args: readonly string[],
  error: unknown,
): string {
  const command = [file, ...args].join(' ');
  const message = error instanceof Error ? error.message : String(error);
  return `${command} failed: ${message}`;
}

function normalizeRequestedPlatform(
  requestedPlatform?: string,
): HostPreflightRequestedPlatform | undefined {
  if (!requestedPlatform) {
    return undefined;
  }

  const normalized = requestedPlatform.toLowerCase();
  if (
    normalized === PLATFORM_ANDROID ||
    normalized === PLATFORM_IOS ||
    normalized === 'all'
  ) {
    return normalized;
  }
  return undefined;
}

function dedupePlatforms(
  platforms: HostPreflightCheckedPlatform[],
): HostPreflightCheckedPlatform[] {
  const seen = new Set<HostPreflightCheckedPlatform>();
  const deduped: HostPreflightCheckedPlatform[] = [];
  for (const platform of platforms) {
    if (seen.has(platform)) {
      continue;
    }
    seen.add(platform);
    deduped.push(platform);
  }
  return deduped;
}

function formatPlatformLabel(platform: HostPreflightCheckedPlatform): string {
  return platform === PLATFORM_ANDROID ? 'Android' : 'iOS';
}
