import { spawn, execFile, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import {
  DeviceAppInfo,
  Logger,
  type SingleArgument,
} from '@finalrun/common';
import { toCommandFailureResult } from '../commandFailure.js';

const execFileAsync = promisify(execFile);

type ExecFileFn = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

export const IOS_DRIVER_RUNNER_BUNDLE_ID = 'app.finalrun.iosUITests.xctrunner';

export interface IOSDriverProcessHandle {
  pid?: number;
  exitCode?: number | null;
  killed?: boolean;
  stdout?: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

export interface IOSCommandResult {
  success: boolean;
  message?: string;
  stdout?: string;
  stderr?: string;
  data?: Record<string, unknown>;
}

const IOS_PERMISSION_KEYS = [
  'calendar',
  'camera',
  'contacts',
  'homeKit',
  'location',
  'medialibrary',
  'microphone',
  'motion',
  'notifications',
  'photos',
  'reminders',
  'siri',
  'speech',
  'userTracking',
];

const IOS_SIMCTL_PERMISSION_SERVICES: Record<string, string> = {
  calendar: 'calendar',
  contacts: 'contacts',
  location: 'location-always',
  medialibrary: 'media-library',
  microphone: 'microphone',
  motion: 'motion',
  photos: 'photos',
  reminders: 'reminders',
  siri: 'siri',
};

const IOS_APPLESIMUTILS_PERMISSION_NAMES: Record<string, string> = {
  homeKit: 'homekit',
};

export class SimctlClient {
  private _execFileFn: ExecFileFn;
  private _spawnFn: typeof spawn;

  constructor(params?: { execFileFn?: ExecFileFn; spawnFn?: typeof spawn }) {
    this._execFileFn = params?.execFileFn ?? execFileAsync;
    this._spawnFn = params?.spawnFn ?? spawn;
  }

  async installApp(deviceId: string, appPath: string): Promise<boolean> {
    const result = await this._runCommand(
      'xcrun',
      ['simctl', 'install', deviceId, appPath],
      `Failed to install iOS app on ${deviceId}`,
    );
    if (result.success) {
      Logger.i(`Installed iOS app on ${deviceId}: ${appPath}`);
    }
    return result.success;
  }

  async uninstallApp(deviceId: string, bundleId: string): Promise<IOSCommandResult> {
    return await this._runCommand(
      'xcrun',
      ['simctl', 'uninstall', deviceId, bundleId],
      `Failed to uninstall ${bundleId} on ${deviceId}`,
      { suppressErrorLog: true },
    );
  }

  async openUrl(deviceId: string, deeplink: string): Promise<boolean> {
    const result = await this._runCommand(
      'xcrun',
      ['simctl', 'openurl', deviceId, deeplink],
      `Failed to open iOS deeplink on ${deviceId}`,
    );
    if (result.success) {
      Logger.i(`Opened iOS deeplink on ${deviceId}: ${deeplink}`);
    }
    return result.success;
  }

  async terminateAppResult(deviceId: string, bundleId: string): Promise<IOSCommandResult> {
    const result = await this._runCommand(
      'xcrun',
      ['simctl', 'terminate', deviceId, bundleId],
      `Failed to terminate ${bundleId} on ${deviceId}`,
      { suppressErrorLog: true },
    );
    if (
      !result.success &&
      result.message?.includes('found nothing to terminate')
    ) {
      return {
        success: true,
        message: 'App was not running',
      };
    }

    return result;
  }

  async terminateApp(deviceId: string, bundleId: string): Promise<void> {
    await this.terminateAppResult(deviceId, bundleId);
  }

  async launchApp(
    deviceId: string,
    bundleId: string,
    argumentsMap?: Record<string, SingleArgument>,
  ): Promise<IOSCommandResult> {
    const args = ['simctl', 'launch', deviceId, bundleId];
    const launchArgs: string[] = [];

    for (const [argumentKey, argumentValue] of Object.entries(argumentsMap ?? {})) {
      const key = argumentValue.key || argumentKey;
      if (argumentValue.type.toLowerCase() === 'env') {
        args.push('--env', `${key}=${argumentValue.value}`);
      } else {
        launchArgs.push(argumentValue.value);
      }
    }

    if (launchArgs.length > 0) {
      args.push('--args', ...launchArgs);
    }

    return await this._runCommand(
      'xcrun',
      args,
      `Failed to launch ${bundleId} on ${deviceId}`,
    );
  }

  async bringAppToForeground(
    deviceId: string,
    bundleId: string,
    argumentsMap?: Record<string, SingleArgument>,
  ): Promise<IOSCommandResult> {
    return await this.launchApp(deviceId, bundleId, argumentsMap);
  }

  async setLocation(
    deviceId: string,
    latitude: string,
    longitude: string,
  ): Promise<IOSCommandResult> {
    return await this._runCommand(
      'xcrun',
      ['simctl', 'location', deviceId, 'set', `${latitude},${longitude}`],
      `Failed to set iOS location on ${deviceId}`,
    );
  }

  async clearLocation(deviceId: string): Promise<IOSCommandResult> {
    return await this._runCommand(
      'xcrun',
      ['simctl', 'location', deviceId, 'clear'],
      `Failed to clear iOS location on ${deviceId}`,
    );
  }

  async pressButton(deviceId: string, button: string): Promise<IOSCommandResult> {
    const normalizedButton = this._normalizeButtonName(button);
    const simctlButton =
      normalizedButton === 'power'
        ? 'lock'
        : normalizedButton === 'menu'
          ? 'home'
          : normalizedButton;

    if (!['home', 'lock', 'volumeup', 'volumedown'].includes(simctlButton)) {
      return {
        success: false,
        message: `iOS simctl button is not mapped: ${button}`,
        data: { handled: false },
      };
    }

    const result = await this._runCommand(
      'xcrun',
      ['simctl', 'io', deviceId, 'ui', simctlButton],
      `Failed to press iOS button ${button} on ${deviceId}`,
    );
    return {
      ...result,
      data: { handled: true },
    };
  }

  async allowAllPermissions(
    deviceId: string,
    bundleId: string,
  ): Promise<IOSCommandResult> {
    const simctlResult = await this._runCommand(
      'xcrun',
      ['simctl', 'privacy', deviceId, 'grant', 'all', bundleId],
      `Failed to grant iOS simulator permissions for ${bundleId} on ${deviceId}`,
    );
    if (!simctlResult.success) {
      return simctlResult;
    }

    const applesimutilsPermissions = Object.fromEntries(
      IOS_PERMISSION_KEYS.filter(
        (permission) => !(permission in IOS_SIMCTL_PERMISSION_SERVICES),
      ).map((permission) => [permission, 'allow']),
    );

    const applesimutilsResult = await this._applyApplesimutilsPermissions(
      deviceId,
      bundleId,
      applesimutilsPermissions,
    );
    if (!applesimutilsResult.success) {
      return applesimutilsResult;
    }

    return this._mergePermissionResults([
      {
        success: true,
        data: {
          appliedPermissions: Object.keys(IOS_SIMCTL_PERMISSION_SERVICES),
        },
      },
      applesimutilsResult,
    ]);
  }

  async togglePermissions(
    deviceId: string,
    bundleId: string,
    permissions: Record<string, string>,
  ): Promise<IOSCommandResult> {
    const simctlPermissions: Record<string, string> = {};
    const applesimutilsPermissions: Record<string, string> = {};

    for (const [permissionName, action] of Object.entries(permissions)) {
      if (permissionName in IOS_SIMCTL_PERMISSION_SERVICES) {
        simctlPermissions[permissionName] = action;
      } else {
        applesimutilsPermissions[permissionName] = action;
      }
    }

    const simctlResult = await this._applySimctlPermissions(
      deviceId,
      bundleId,
      simctlPermissions,
    );
    if (!simctlResult.success) {
      return simctlResult;
    }

    const applesimutilsResult = await this._applyApplesimutilsPermissions(
      deviceId,
      bundleId,
      applesimutilsPermissions,
    );
    if (!applesimutilsResult.success) {
      return applesimutilsResult;
    }

    return this._mergePermissionResults([simctlResult, applesimutilsResult]);
  }

  async isApplesimutilsInstalled(): Promise<boolean> {
    const result = await this._runCommand(
      'which',
      ['applesimutils'],
      'Failed to resolve applesimutils',
      { suppressErrorLog: true },
    );
    return result.success && Boolean(result.stdout);
  }

  async clearClipboard(deviceId: string): Promise<IOSCommandResult> {
    return await this._runCommand(
      '/bin/bash',
      ['-c', `echo -n "" | xcrun simctl pbcopy ${deviceId}`],
      `Failed to clear simulator clipboard on ${deviceId}`,
    );
  }

  async clearSafariData(deviceId: string): Promise<IOSCommandResult> {
    const result = await this._runCommand(
      'xcrun',
      ['simctl', 'spawn', deviceId, 'rm', '-rf', 'Library/Safari'],
      `Failed to clear Safari data on ${deviceId}`,
      { suppressErrorLog: true },
    );
    if (
      !result.success &&
      result.message?.includes('No such file or directory')
    ) {
      return {
        success: true,
        message: 'Safari data already clean',
      };
    }
    return result;
  }

  async resetAllPermissions(deviceId: string): Promise<IOSCommandResult> {
    return await this._runCommand(
      'xcrun',
      ['simctl', 'privacy', deviceId, 'reset', 'all'],
      `Failed to reset simulator permissions on ${deviceId}`,
    );
  }

  async uninstallUserApps(deviceId: string): Promise<IOSCommandResult> {
    const metadata = await this._listInstalledAppMetadata(deviceId);
    if (!metadata.success || !metadata.data?.['apps']) {
      return {
        success: false,
        message: metadata.message ?? 'Failed to load installed simulator apps',
      };
    }

    const apps = metadata.data['apps'] as Array<Record<string, unknown>>;
    const bundleIds = apps
      .filter((app) => app['bundleId'] !== IOS_DRIVER_RUNNER_BUNDLE_ID)
      .filter((app) => app['applicationType'] === 'User')
      .map((app) => app['bundleId'] as string);

    for (const bundleId of bundleIds) {
      const uninstallResult = await this.uninstallApp(deviceId, bundleId);
      if (!uninstallResult.success) {
        return uninstallResult;
      }
    }

    return {
      success: true,
      message: `Uninstalled ${bundleIds.length} user apps`,
    };
  }

  async listInstalledApps(deviceId: string): Promise<DeviceAppInfo[]> {
    const metadata = await this._listInstalledAppMetadata(deviceId);
    if (!metadata.success || !metadata.data?.['apps']) {
      return [];
    }

    return (metadata.data['apps'] as Array<Record<string, unknown>>)
      .map(
        (app) =>
          new DeviceAppInfo({
            packageName: app['bundleId'] as string,
            name: app['name'] as string,
            version: (app['version'] as string | null | undefined) ?? null,
          }),
      )
      .sort((left, right) => left.packageName.localeCompare(right.packageName));
  }

  async listInstalledAppIds(deviceId: string): Promise<string[]> {
    const apps = await this.listInstalledApps(deviceId);
    return DeviceAppInfo.getAppIdList(apps);
  }

  async isAppInstalled(
    deviceId: string,
    bundleId: string,
  ): Promise<IOSCommandResult> {
    // Go through _listInstalledAppMetadata directly rather than
    // listInstalledAppIds: the latter swallows simctl/plutil query failures
    // into an empty array, which would mask "couldn't query" as "not
    // installed" and falsely abort launches on transient simulator errors.
    const metadata = await this._listInstalledAppMetadata(deviceId);
    if (!metadata.success || !metadata.data?.['apps']) {
      return {
        success: false,
        message:
          metadata.message ?? `Failed to query installed apps on ${deviceId}`,
        data: { bundleId, installed: false, checkFailed: true },
      };
    }

    const apps = metadata.data['apps'] as Array<Record<string, unknown>>;
    const installed = apps.some((app) => app['bundleId'] === bundleId);
    return {
      success: installed,
      message: installed
        ? `App installed: ${bundleId}`
        : `App not installed: ${bundleId}`,
      data: { bundleId, installed },
    };
  }

  async getAppExecutableName(deviceId: string, bundleId: string): Promise<string | null> {
    const metadata = await this._listInstalledAppMetadata(deviceId);
    if (!metadata.success || !metadata.data?.['apps']) return null;
    const apps = metadata.data['apps'] as Array<Record<string, unknown>>;
    const app = apps.find((a) => a['bundleId'] === bundleId);
    return (app?.['executableName'] as string) ?? null;
  }

  startDriver(deviceId: string, port: number): IOSDriverProcessHandle {
    const child = this._spawnFn(
      'xcrun',
      [
        'simctl',
        'launch',
        '--console',
        '--terminate-running-process',
        deviceId,
        IOS_DRIVER_RUNNER_BUNDLE_ID,
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          SIMCTL_CHILD_port: String(port),
          SIMCTL_CHILD_app_perfect_device_id: deviceId,
        },
      },
    ) as ChildProcess;

    Logger.d(
      `Starting iOS driver: xcrun simctl launch --console --terminate-running-process ${deviceId} ${IOS_DRIVER_RUNNER_BUNDLE_ID}`,
    );
    return child as IOSDriverProcessHandle;
  }

  private async _listInstalledAppMetadata(deviceId: string): Promise<IOSCommandResult> {
    const result = await this._runCommand(
      '/bin/bash',
      ['-c', `xcrun simctl listapps ${deviceId} | plutil -convert json - -o -`],
      `Failed to list iOS apps on ${deviceId}`,
    );
    if (!result.success) {
      return result;
    }

    try {
      const parsed = JSON.parse(result.stdout ?? '') as Record<string, unknown>;
      const apps: Array<Record<string, unknown>> = [];

      for (const [key, value] of Object.entries(parsed)) {
        const app = this._parseAppRecord(key, value);
        if (app) {
          apps.push(app);
        }
      }

      return {
        success: true,
        data: { apps },
      };
    } catch (error) {
      return {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : `Failed to parse iOS app metadata: ${String(error)}`,
      };
    }
  }

  /** Parse one `simctl listapps` record into the app-metadata shape; null when it is not an app record. */
  private _parseAppRecord(
    key: string,
    value: unknown,
  ): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const valueRecord = value as Record<string, unknown>;
    const bundleId =
      this._trimmed(valueRecord['CFBundleIdentifier']) ||
      this._trimmed(valueRecord['bundleIdentifier']) ||
      this._trimmed(valueRecord['bundleId']) ||
      key.trim();
    if (!bundleId) {
      return null;
    }

    return { bundleId, ...this._appRecordDetails(valueRecord, key, bundleId) };
  }

  private _appRecordDetails(
    valueRecord: Record<string, unknown>,
    key: string,
    bundleId: string,
  ): Record<string, unknown> {
    const fallbackName = key.trim() || bundleId;
    const name =
      this._trimmed(valueRecord['CFBundleDisplayName']) ||
      this._trimmed(valueRecord['CFBundleName']) ||
      fallbackName;
    const version = this._trimmed(valueRecord['CFBundleVersion']) ?? null;
    const applicationType =
      this._trimmed(valueRecord['ApplicationType']) ??
      (bundleId.startsWith('com.apple.') ? 'System' : 'User');
    const executableName = this._trimmed(valueRecord['CFBundleExecutable']) ?? null;

    return { name, version, applicationType, executableName };
  }

  /**
   * Replaces the eight inline `(value as string | undefined)?.trim()` casts.
   *
   * Cast semantics are identical, but the *thrown message* is not: if a record
   * carries a non-string, non-null value (a malformed `Info.plist` with, say,
   * `CFBundleVersion: 17`), V8 builds the TypeError text from the source
   * expression, so it now reads `value?.trim is not a function` where the
   * inline form read `valueRecord.CFBundleVersion?.trim is not a function`.
   * That string is caught by `_listInstalledAppMetadata` and propagated
   * verbatim as `message` by `uninstallUserApps` and `isAppInstalled`, so it is
   * user-reachable. The delta is accepted, not overlooked: the throw class,
   * throw point, success/failure classification and returned data are all
   * unchanged, and neither string is a designed diagnostic — both leak an
   * internal expression name. Preserving the old text is impossible without
   * re-inlining all eight call sites, which is what put the enclosing method
   * over the complexity ceiling.
   */
  private _trimmed(value: unknown): string | undefined {
    return (value as string | undefined)?.trim();
  }

  private async _applySimctlPermissions(
    deviceId: string,
    bundleId: string,
    permissions: Record<string, string>,
  ): Promise<IOSCommandResult> {
    const appliedPermissions: string[] = [];

    for (const [permissionName, action] of Object.entries(permissions)) {
      const service = IOS_SIMCTL_PERMISSION_SERVICES[permissionName];
      if (!service) {
        continue;
      }

      let privacyAction: 'grant' | 'revoke' | 'reset';
      switch (action) {
        case 'allow':
          privacyAction = 'grant';
          break;
        case 'deny':
          privacyAction = 'revoke';
          break;
        case 'unset':
          privacyAction = 'reset';
          break;
        default:
          return {
            success: false,
            message: `Invalid action for ${permissionName}: ${action}`,
          };
      }

      const result = await this._runCommand(
        'xcrun',
        ['simctl', 'privacy', deviceId, privacyAction, service, bundleId],
        `Failed to update iOS ${permissionName} permission for ${bundleId} on ${deviceId}`,
      );
      if (!result.success) {
        return result;
      }
      appliedPermissions.push(permissionName);
    }

    return appliedPermissions.length > 0
      ? {
          success: true,
          data: { appliedPermissions },
        }
      : {
          success: true,
        };
  }

  private async _applyApplesimutilsPermissions(
    deviceId: string,
    bundleId: string,
    permissions: Record<string, string>,
  ): Promise<IOSCommandResult> {
    const translatedPermissions: string[] = [];
    const permissionNames = Object.keys(permissions);

    for (const [permissionName, action] of Object.entries(permissions)) {
      const translated = this._translateApplesimutilsPermission(
        permissionName,
        action,
      );
      if (translated === null) {
        return {
          success: false,
          message: `Invalid action for ${permissionName}: ${action}`,
        };
      }
      translatedPermissions.push(translated);
    }

    if (translatedPermissions.length === 0) {
      return { success: true };
    }

    if (!(await this.isApplesimutilsInstalled())) {
      const warning =
        `Skipped pre-granting iOS permissions because applesimutils is not installed: ${permissionNames.join(', ')}`;
      Logger.w(warning);
      return {
        success: true,
        message: warning,
        data: {
          skippedPermissions: permissionNames,
          permissionWarning: warning,
        },
      };
    }

    const result = await this._runCommand(
      'applesimutils',
      [
        '--byId',
        deviceId,
        '--bundle',
        bundleId,
        '--setPermissions',
        translatedPermissions.join(','),
      ],
      `Failed to update iOS permissions for ${bundleId} on ${deviceId}`,
    );
    if (!result.success) {
      return result;
    }

    return {
      success: true,
      data: {
        appliedPermissions: permissionNames,
      },
    };
  }

  /**
   * Translate one permission/action pair into an applesimutils
   * `name=value` token; null when the action is invalid.
   */
  private _translateApplesimutilsPermission(
    permissionName: string,
    action: string,
  ): string | null {
    let translatedValue: string;
    switch (action) {
      case 'allow':
        translatedValue = 'YES';
        break;
      case 'deny':
        translatedValue = 'NO';
        break;
      case 'unset':
        translatedValue = 'unset';
        break;
      default:
        return null;
    }

    const translatedPermissionName =
      IOS_APPLESIMUTILS_PERMISSION_NAMES[permissionName] ?? permissionName;
    return `${translatedPermissionName}=${translatedValue}`;
  }

  private _mergePermissionResults(
    results: IOSCommandResult[],
  ): IOSCommandResult {
    const messages = results
      .map((result) => result.message)
      .filter((message): message is string => Boolean(message));
    const appliedPermissions = results.flatMap((result) =>
      Array.isArray(result.data?.['appliedPermissions'])
        ? (result.data?.['appliedPermissions'] as string[])
        : [],
    );
    const skippedPermissions = results.flatMap((result) =>
      Array.isArray(result.data?.['skippedPermissions'])
        ? (result.data?.['skippedPermissions'] as string[])
        : [],
    );
    const permissionWarning = results.find(
      (result) => typeof result.data?.['permissionWarning'] === 'string',
    )?.data?.['permissionWarning'] as string | undefined;

    const data: Record<string, unknown> = {};
    if (appliedPermissions.length > 0) {
      data['appliedPermissions'] = appliedPermissions;
    }
    if (skippedPermissions.length > 0) {
      data['skippedPermissions'] = skippedPermissions;
    }
    if (permissionWarning) {
      data['permissionWarning'] = permissionWarning;
    }

    return {
      success: true,
      message: messages.length > 0 ? messages.join(' ') : undefined,
      data: Object.keys(data).length > 0 ? data : undefined,
    };
  }

  private async _runCommand(
    file: string,
    args: readonly string[],
    failurePrefix: string,
    options?: { suppressErrorLog?: boolean },
  ): Promise<IOSCommandResult> {
    try {
      const { stdout, stderr } = await this._execFileFn(file, args);
      const stdoutText = stdout.toString().trim();
      const stderrText = stderr.toString().trim();
      return {
        success: true,
        message: stderrText || stdoutText || undefined,
        stdout: stdoutText,
        stderr: stderrText,
      };
    } catch (error) {
      const result = toCommandFailureResult(failurePrefix, error);
      if (!options?.suppressErrorLog) {
        Logger.e(failurePrefix, error);
      }
      return result;
    }
  }

  private _normalizeButtonName(button: string): string {
    return button.trim().toLowerCase().replace(/[\s-]+/g, '');
  }
}
