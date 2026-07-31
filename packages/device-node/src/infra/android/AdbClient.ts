import { execFile } from 'child_process';
import { promisify } from 'util';
import * as net from 'node:net';
import {
  DEFAULT_GRPC_PORT_START,
  Logger,
  type SingleArgument,
} from '@finalrun/common';
import { toCommandFailureResult } from '../commandFailure.js';

const execFileAsync = promisify(execFile);

/**
 * Range of host ports the AdbClient is allowed to use for the gRPC driver
 * forward. Each device gets one port from this pool, used as both the
 * host-side and device-side port (forward target = forward source).
 *
 * 100 slots starting from DEFAULT_GRPC_PORT_START.
 */
const PORT_RANGE_START = DEFAULT_GRPC_PORT_START;
const PORT_RANGE_END = PORT_RANGE_START + 100;

type ExecFileFn = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

export interface AndroidSwipeParams {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  durationMs: number;
}

export interface AndroidCommandResult {
  success: boolean;
  message?: string;
  stdout?: string;
  stderr?: string;
  data?: Record<string, unknown>;
}

export const ANDROID_DRIVER_APP_PACKAGE_NAME = 'app.finalrun.android';
export const ANDROID_DRIVER_TEST_PACKAGE_NAME = 'app.finalrun.android.test';

const ANDROID_KEY_CODES: Record<string, string> = {
  enter: 'KEYCODE_ENTER',
  return: 'KEYCODE_ENTER',
  backspace: 'KEYCODE_DEL',
  delete: 'KEYCODE_DEL',
  back: 'KEYCODE_BACK',
  home: 'KEYCODE_HOME',
  lock: 'KEYCODE_LOCK',
  power: 'KEYCODE_POWER',
  volume_up: 'KEYCODE_VOLUME_UP',
  volumeup: 'KEYCODE_VOLUME_UP',
  volume_down: 'KEYCODE_VOLUME_DOWN',
  volumedown: 'KEYCODE_VOLUME_DOWN',
  escape: 'KEYCODE_ESCAPE',
  esc: 'KEYCODE_ESCAPE',
  tab: 'KEYCODE_TAB',
  up: 'KEYCODE_DPAD_UP',
  down: 'KEYCODE_DPAD_DOWN',
  left: 'KEYCODE_DPAD_LEFT',
  right: 'KEYCODE_DPAD_RIGHT',
  center: 'KEYCODE_DPAD_CENTER',
  play_pause: 'KEYCODE_MEDIA_PLAY_PAUSE',
  stop: 'KEYCODE_MEDIA_STOP',
  next: 'KEYCODE_MEDIA_NEXT',
  previous: 'KEYCODE_MEDIA_PREVIOUS',
  rewind: 'KEYCODE_MEDIA_REWIND',
  fast_forward: 'KEYCODE_MEDIA_FAST_FORWARD',
  menu: 'KEYCODE_MENU',
};

const ANDROID_PERMISSION_TRANSLATIONS: Record<string, string[]> = {
  location: [
    'android.permission.ACCESS_FINE_LOCATION',
    'android.permission.ACCESS_COARSE_LOCATION',
    'android.permission.ACCESS_BACKGROUND_LOCATION',
  ],
  camera: ['android.permission.CAMERA'],
  contacts: [
    'android.permission.READ_CONTACTS',
    'android.permission.WRITE_CONTACTS',
  ],
  phone: [
    'android.permission.CALL_PHONE',
    'android.permission.ANSWER_PHONE_CALLS',
  ],
  microphone: ['android.permission.RECORD_AUDIO'],
  bluetooth: [
    'android.permission.BLUETOOTH_CONNECT',
    'android.permission.BLUETOOTH_SCAN',
  ],
  storage: [
    'android.permission.WRITE_EXTERNAL_STORAGE',
    'android.permission.READ_EXTERNAL_STORAGE',
  ],
  notifications: ['android.permission.POST_NOTIFICATIONS'],
  medialibrary: [
    'android.permission.WRITE_EXTERNAL_STORAGE',
    'android.permission.READ_EXTERNAL_STORAGE',
    'android.permission.READ_MEDIA_AUDIO',
    'android.permission.READ_MEDIA_IMAGES',
    'android.permission.READ_MEDIA_VIDEO',
  ],
  calendar: [
    'android.permission.WRITE_CALENDAR',
    'android.permission.READ_CALENDAR',
  ],
  sms: [
    'android.permission.READ_SMS',
    'android.permission.RECEIVE_SMS',
    'android.permission.SEND_SMS',
  ],
  overlay: ['SYSTEM_ALERT_WINDOW'],
};

/**
 * True when `pm grant` / `pm revoke` failed because the target package does not declare the
 * permission in its manifest (`Package … has not requested permission …`). Used for best-effort
 * `allowAllPermissions` (still defaulted true) so undeclared permissions are skipped, not errors.
 */
export function isUndeclaredPermissionGrantFailure(stderrOrMessage: string): boolean {
  return stderrOrMessage.toLowerCase().includes('has not requested permission');
}

export class AdbClient {
  /** deviceSerial -> port currently allocated for that device */
  private _portMap: Map<string, number> = new Map();
  /** ports currently in use across all devices (set of allocated values) */
  private _allocatedPorts: Set<number> = new Set();
  /**
   * Async mutex serializing port allocate/release/cleanup. Without this,
   * two concurrent forwardPort() calls can both pass _isPortBindable() for
   * the same port and both reserve it.
   */
  private _allocationMutex: Promise<void> = Promise.resolve();
  private _execFileFn: ExecFileFn;

  constructor(params?: { execFileFn?: ExecFileFn }) {
    this._execFileFn = params?.execFileFn ?? execFileAsync;
  }

  /**
   * Run `fn` while holding the allocation mutex. Ensures only one
   * allocate/release/cleanup runs at a time across all callers.
   */
  private async _withAllocationLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this._allocationMutex;
    let releaseLock!: () => void;
    this._allocationMutex = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    try {
      await previous;
      return await fn();
    } finally {
      releaseLock();
    }
  }

  /**
   * Set up the host->device port forward and return the allocated host port.
   *
   * The same port is used on BOTH sides of the forward (`tcp:N -> tcp:N`)
   * so the driver app's `-e port N` argument lines up with the forward
   * destination. The `devicePort` argument is ignored and kept for backwards
   * compatibility — earlier versions hardcoded it to DEFAULT_GRPC_PORT_START
   * which caused host/device port drift across runs.
   */
  async forwardPort(
    adbPath: string,
    deviceSerial: string,
    _devicePort?: number,
  ): Promise<number> {
    const localPort = await this._allocatePort(deviceSerial);

    try {
      await this._execFileFn(adbPath, [
        '-s',
        deviceSerial,
        'forward',
        `tcp:${localPort}`,
        `tcp:${localPort}`,
      ]);
    } catch (error) {
      // adb forward failed — return the reservation to the pool so the
      // port can be reused. The caller will see the rethrown error.
      await this._releasePort(deviceSerial);
      throw error;
    }

    Logger.d(
      `Port forwarded: localhost:${localPort} -> ${deviceSerial}:${localPort}`,
    );
    return localPort;
  }

  async removePortForward(adbPath: string, deviceSerial: string): Promise<void> {
    const port = this._portMap.get(deviceSerial);
    if (port === undefined) {
      return;
    }

    try {
      await this._execFileFn(adbPath, [
        '-s',
        deviceSerial,
        'forward',
        '--remove',
        `tcp:${port}`,
      ]);
    } catch {
      // Ignore best-effort cleanup failures.
    }

    await this._releasePort(deviceSerial);
  }

  /**
   * Nuke every adb forward across all attached devices. Call this on process
   * startup to clean up stale forwards left behind by a previous crashed
   * device-node process.
   */
  async removeAllPortForwards(adbPath: string): Promise<void> {
    try {
      await this._execFileFn(adbPath, ['forward', '--remove-all']);
      Logger.d('Removed all stale adb forwards');
    } catch (error) {
      // "no devices/emulators found" is expected at cold startup — adb
      // requires a target device for `forward --remove-all`. Anything else
      // is unusual but still best-effort.
      const message = error instanceof Error ? error.message : String(error);
      if (!/no devices\/emulators found/i.test(message)) {
        Logger.w('Failed to remove all adb forwards (ignoring)', error as Error);
      }
    }
    // Reset in-memory pool too — the OS state was just wiped (or there's
    // nothing to reset because no devices are attached). Take the lock so
    // this can't race with an in-flight allocation.
    await this._withAllocationLock(async () => {
      this._portMap.clear();
      this._allocatedPorts.clear();
    });
  }

  getForwardedPort(deviceSerial: string): number | undefined {
    return this._portMap.get(deviceSerial);
  }

  async installApp(
    adbPath: string,
    deviceSerial: string,
    apkPath: string,
  ): Promise<boolean> {
    const result = await this._runAdb(
      adbPath,
      ['-s', deviceSerial, 'install', '-r', '-g', apkPath],
      `Failed to install APK on ${deviceSerial}`,
    );
    if (result.success) {
      Logger.i(`Installed APK on ${deviceSerial}: ${apkPath}`);
    }
    return result.success;
  }

  // Install a FinalRun-owned APK (driver or test runner). If the install fails
  // and the package is already present (almost always a signature mismatch
  // from a prior build), uninstall it and retry once. Skipped when the package
  // is absent — uninstall can't fix unrelated failures (storage, ABI, USB).
  async installDriverApp(
    adbPath: string,
    deviceSerial: string,
    apkPath: string,
    packageName: string,
  ): Promise<boolean> {
    if (await this.installApp(adbPath, deviceSerial, apkPath)) {
      return true;
    }

    const existing = await this.isPackageInstalled(adbPath, deviceSerial, packageName);
    if (!existing.success) {
      return false;
    }

    Logger.w(
      `Driver install failed and ${packageName} already on ${deviceSerial}; uninstalling and retrying once`,
    );
    await this.uninstallApp(adbPath, deviceSerial, packageName);
    return await this.installApp(adbPath, deviceSerial, apkPath);
  }

  async uninstallApp(
    adbPath: string,
    deviceSerial: string,
    packageName: string,
  ): Promise<void> {
    await this._runAdb(
      adbPath,
      ['-s', deviceSerial, 'uninstall', packageName],
      `Failed to uninstall ${packageName} on ${deviceSerial}`,
      { suppressErrorLog: true },
    );
  }

  async openDeepLink(
    adbPath: string,
    deviceSerial: string,
    deeplink: string,
  ): Promise<boolean> {
    const result = await this._runAdb(
      adbPath,
      [
        '-s',
        deviceSerial,
        'shell',
        'am',
        'start',
        '-W',
        '-a',
        'android.intent.action.VIEW',
        '-d',
        deeplink,
      ],
      `Failed to open Android deeplink on ${deviceSerial}`,
    );
    if (result.success) {
      Logger.i(`Opened Android deeplink on ${deviceSerial}: ${deeplink}`);
    }
    return result.success;
  }

  async swipe(
    adbPath: string,
    deviceSerial: string,
    params: AndroidSwipeParams,
  ): Promise<AndroidCommandResult> {
    return await this._runAdb(
      adbPath,
      [
        '-s',
        deviceSerial,
        'shell',
        'input',
        'swipe',
        String(params.startX),
        String(params.startY),
        String(params.endX),
        String(params.endY),
        String(params.durationMs),
      ],
      `Android swipe failed on ${deviceSerial}`,
    );
  }

  async runCommand(
    adbPath: string,
    deviceSerial: string,
    command: string,
  ): Promise<AndroidCommandResult> {
    const parts = command.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
      return {
        success: false,
        message: 'Android command failed: command was empty',
      };
    }

    return await this._runAdb(
      adbPath,
      ['-s', deviceSerial, ...parts],
      `Android command failed on ${deviceSerial}`,
    );
  }

  async isKeyboardOpen(
    adbPath: string,
    deviceSerial: string,
  ): Promise<AndroidCommandResult> {
    const result = await this._runAdb(
      adbPath,
      ['-s', deviceSerial, 'shell', 'dumpsys', 'input_method'],
      `Failed to inspect keyboard state on ${deviceSerial}`,
    );
    if (!result.success) {
      return result;
    }

    const visible = (result.stdout ?? '').includes('mInputShown=true');
    return {
      success: visible,
      message: visible ? 'Keyboard is visible' : 'Keyboard is hidden',
      stdout: result.stdout,
      stderr: result.stderr,
      data: { visible },
    };
  }

  async hideKeyboard(
    adbPath: string,
    deviceSerial: string,
  ): Promise<AndroidCommandResult> {
    const keyboardState = await this.isKeyboardOpen(adbPath, deviceSerial);
    if (keyboardState.data?.['visible'] !== true) {
      return {
        success: true,
        message: 'Keyboard is already hidden',
      };
    }

    return await this.performKeyPress(adbPath, deviceSerial, 'back');
  }

  async clearAppData(
    adbPath: string,
    deviceSerial: string,
    packageName: string,
  ): Promise<AndroidCommandResult> {
    return await this._runAdb(
      adbPath,
      ['-s', deviceSerial, 'shell', 'pm', 'clear', packageName],
      `Failed to clear app data for ${packageName} on ${deviceSerial}`,
    );
  }

  async forceStop(
    adbPath: string,
    deviceSerial: string,
    packageName: string,
    options?: { suppressErrorLog?: boolean },
  ): Promise<AndroidCommandResult> {
    return await this._runAdb(
      adbPath,
      ['-s', deviceSerial, 'shell', 'am', 'force-stop', packageName],
      `Failed to force-stop ${packageName} on ${deviceSerial}`,
      { suppressErrorLog: options?.suppressErrorLog },
    );
  }

  /**
   * Best-effort check for whether a package has any live process on the
   * device. Uses `pidof <pkg>`; behaviour across Android versions varies
   * (empty stdout vs. non-zero exit when no match), so "any signal that
   * something is still running" is treated as running. Errors are treated as
   * not-running so teardown pollers don't hang on a disconnected device.
   */
  async isProcessRunning(
    adbPath: string,
    deviceSerial: string,
    packageName: string,
  ): Promise<boolean> {
    const result = await this._runAdb(
      adbPath,
      ['-s', deviceSerial, 'shell', 'pidof', packageName],
      `Failed to check process for ${packageName} on ${deviceSerial}`,
      { suppressErrorLog: true },
    );
    return result.success && !!result.stdout && result.stdout.length > 0;
  }

  async performKeyPress(
    adbPath: string,
    deviceSerial: string,
    key: string,
  ): Promise<AndroidCommandResult> {
    const normalizedKey = this._normalizeKeyName(key);
    const adbKey = ANDROID_KEY_CODES[normalizedKey];
    if (!adbKey) {
      return {
        success: false,
        message: `Android key is not mapped for adb: ${key}`,
        data: { handled: false },
      };
    }

    const result = await this._runAdb(
      adbPath,
      ['-s', deviceSerial, 'shell', 'input', 'keyevent', adbKey],
      `Failed to press Android key ${key} on ${deviceSerial}`,
    );
    return {
      ...result,
      data: { handled: true },
    };
  }

  async back(adbPath: string, deviceSerial: string): Promise<AndroidCommandResult> {
    return await this.performKeyPress(adbPath, deviceSerial, 'back');
  }

  async home(adbPath: string, deviceSerial: string): Promise<AndroidCommandResult> {
    return await this.performKeyPress(adbPath, deviceSerial, 'home');
  }

  async rotate(
    adbPath: string,
    deviceSerial: string,
  ): Promise<AndroidCommandResult> {
    const currentRotation = await this._runAdb(
      adbPath,
      ['-s', deviceSerial, 'shell', 'settings', 'get', 'system', 'user_rotation'],
      `Failed to read Android rotation on ${deviceSerial}`,
    );
    if (!currentRotation.success) {
      return currentRotation;
    }

    const current = Number.parseInt((currentRotation.stdout ?? '').trim(), 10);
    const nextRotation = current === 1 || current === 3 ? 0 : 1;
    const orientation = nextRotation === 0 ? 'portrait' : 'landscape';

    const disableAutoRotate = await this._runAdb(
      adbPath,
      [
        '-s',
        deviceSerial,
        'shell',
        'settings',
        'put',
        'system',
        'accelerometer_rotation',
        '0',
      ],
      `Failed to disable Android auto-rotate on ${deviceSerial}`,
    );
    if (!disableAutoRotate.success) {
      return disableAutoRotate;
    }

    const result = await this._runAdb(
      adbPath,
      [
        '-s',
        deviceSerial,
        'shell',
        'settings',
        'put',
        'system',
        'user_rotation',
        String(nextRotation),
      ],
      `Failed to rotate Android device ${deviceSerial}`,
    );
    return {
      ...result,
      data: {
        orientation,
      },
    };
  }

  async bringAppToForeground(
    adbPath: string,
    deviceSerial: string,
    packageName: string,
  ): Promise<AndroidCommandResult> {
    return await this._runAdb(
      adbPath,
      [
        '-s',
        deviceSerial,
        'shell',
        'monkey',
        '-p',
        packageName,
        '-c',
        'android.intent.category.LAUNCHER',
        '1',
      ],
      `Failed to foreground ${packageName} on ${deviceSerial}`,
    );
  }

  async launchAppCli(
    adbPath: string,
    deviceSerial: string,
    packageName: string,
    argumentsMap?: Record<string, SingleArgument>,
  ): Promise<AndroidCommandResult> {
    const resolveResult = await this._runAdb(
      adbPath,
      [
        '-s',
        deviceSerial,
        'shell',
        'cmd',
        'package',
        'resolve-activity',
        '--brief',
        packageName,
        '-c',
        'android.intent.category.LAUNCHER',
      ],
      `Failed to resolve Android launcher activity for ${packageName} on ${deviceSerial}`,
    );
    if (!resolveResult.success) {
      return resolveResult;
    }

    const component = (resolveResult.stdout ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1);

    if (!component) {
      return {
        success: false,
        message: `Failed to resolve launcher component for ${packageName}`,
      };
    }

    const args = [
      '-s',
      deviceSerial,
      'shell',
      'am',
      'start',
      '-W',
      '-n',
      component,
    ];

    for (const [argumentKey, argumentValue] of Object.entries(argumentsMap ?? {})) {
      args.push('-e', argumentValue.key || argumentKey, argumentValue.value);
    }

    return await this._runAdb(
      adbPath,
      args,
      `Failed to launch ${packageName} on ${deviceSerial}`,
    );
  }

  async listInstalledPackageIds(
    adbPath: string,
    deviceSerial: string,
    options?: { userOnly?: boolean },
  ): Promise<string[]> {
    const result = await this._runAdb(
      adbPath,
      [
        '-s',
        deviceSerial,
        'shell',
        'pm',
        'list',
        'packages',
        ...(options?.userOnly ? ['-3'] : []),
      ],
      `Failed to list Android packages on ${deviceSerial}`,
    );
    if (!result.success) {
      return [];
    }

    return (result.stdout ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.replace(/^package:/, ''))
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right));
  }

  async isPackageInstalled(
    adbPath: string,
    deviceSerial: string,
    packageName: string,
  ): Promise<AndroidCommandResult> {
    const packages = await this.listInstalledPackageIds(adbPath, deviceSerial);
    const installed = packages.includes(packageName);
    return {
      success: installed,
      message: installed
        ? `App installed: ${packageName}`
        : `App not installed: ${packageName}`,
      data: {
        packageName,
        installed,
      },
    };
  }

  async isAirplaneModeOn(
    adbPath: string,
    deviceSerial: string,
  ): Promise<boolean> {
    const result = await this._runAdb(
      adbPath,
      [
        '-s',
        deviceSerial,
        'shell',
        'settings',
        'get',
        'global',
        'airplane_mode_on',
      ],
      `Failed to read airplane mode state on ${deviceSerial}`,
      { suppressErrorLog: true },
    );
    return (result.stdout ?? '').trim() === '1';
  }

  async toggleAirplaneMode(
    adbPath: string,
    deviceSerial: string,
    enabled: boolean,
    sdkVersion?: string | number | null,
  ): Promise<AndroidCommandResult> {
    const parsedApiLevel =
      typeof sdkVersion === 'number'
        ? sdkVersion
        : typeof sdkVersion === 'string'
          ? Number.parseInt(sdkVersion, 10)
          : Number.NaN;

    if (Number.isFinite(parsedApiLevel) && parsedApiLevel < 29) {
      return await this._toggleAirplaneModeLegacy(adbPath, deviceSerial, enabled);
    }

    return await this._runAdb(
      adbPath,
      [
        '-s',
        deviceSerial,
        'shell',
        'cmd',
        'connectivity',
        'airplane-mode',
        enabled ? 'enable' : 'disable',
      ],
      `Failed to toggle airplane mode on ${deviceSerial}`,
    );
  }

  /** Pre-API-29 fallback: write the global setting, then broadcast the change. */
  private async _toggleAirplaneModeLegacy(
    adbPath: string,
    deviceSerial: string,
    enabled: boolean,
  ): Promise<AndroidCommandResult> {
    const stateResult = await this._runAdb(
      adbPath,
      [
        '-s',
        deviceSerial,
        'shell',
        'settings',
        'put',
        'global',
        'airplane_mode_on',
        enabled ? '1' : '0',
      ],
      `Failed to set airplane mode state on ${deviceSerial}`,
    );
    if (!stateResult.success) {
      return stateResult;
    }

    return await this._runAdb(
      adbPath,
      [
        '-s',
        deviceSerial,
        'shell',
        'am',
        'broadcast',
        '-a',
        'android.intent.action.AIRPLANE_MODE',
        '--ez',
        'state',
        enabled ? 'true' : 'false',
      ],
      `Failed to broadcast airplane mode change on ${deviceSerial}`,
    );
  }

  async toggleInternet(
    adbPath: string,
    deviceSerial: string,
    enable: boolean,
    sdkVersion?: string | number | null,
  ): Promise<AndroidCommandResult> {
    if (enable && (await this.isAirplaneModeOn(adbPath, deviceSerial))) {
      const airplaneResult = await this.toggleAirplaneMode(
        adbPath,
        deviceSerial,
        false,
        sdkVersion,
      );
      if (!airplaneResult.success) {
        return airplaneResult;
      }
    }

    const wifiResult = await this._runAdb(
      adbPath,
      [
        '-s',
        deviceSerial,
        'shell',
        'svc',
        'wifi',
        enable ? 'enable' : 'disable',
      ],
      `Failed to toggle Wi-Fi on ${deviceSerial}`,
    );
    if (!wifiResult.success) {
      return wifiResult;
    }

    return await this._runAdb(
      adbPath,
      [
        '-s',
        deviceSerial,
        'shell',
        'svc',
        'data',
        enable ? 'enable' : 'disable',
      ],
      `Failed to toggle mobile data on ${deviceSerial}`,
    );
  }

  async allowAllPermissions(
    adbPath: string,
    deviceSerial: string,
    packageName: string,
  ): Promise<AndroidCommandResult> {
    const permissions = Object.fromEntries(
      Object.keys(ANDROID_PERMISSION_TRANSLATIONS).map((permission) => [
        permission,
        'allow',
      ]),
    );
    return await this.togglePermissions(adbPath, deviceSerial, packageName, permissions);
  }

  async togglePermissions(
    adbPath: string,
    deviceSerial: string,
    packageName: string,
    permissions: Record<string, string>,
  ): Promise<AndroidCommandResult> {
    const outcome = { errors: [] as string[], skippedUndeclaredRuntime: 0 };

    for (const [permissionName, action] of Object.entries(permissions)) {
      const translatedPermissions = this._translatePermissionName(permissionName);
      if (translatedPermissions.length === 0) {
        outcome.errors.push(`Unknown permission: ${permissionName}`);
        continue;
      }

      for (const androidPermission of translatedPermissions) {
        await this._applyAndroidPermission(
          { adbPath, deviceSerial, packageName },
          androidPermission,
          action,
          outcome,
        );
      }
    }

    if (outcome.skippedUndeclaredRuntime > 0) {
      Logger.i(
        `Skipped ${outcome.skippedUndeclaredRuntime} Android runtime permission(s) not declared by ${packageName} on ${deviceSerial}`,
      );
    }

    return {
      success: outcome.errors.length === 0,
      message:
        outcome.errors.length === 0
          ? 'Permissions updated successfully'
          : outcome.errors.join('\n'),
    };
  }

  /**
   * Apply one translated Android permission, recording failures and
   * undeclared-permission skips on the caller's per-call outcome context.
   */
  private async _applyAndroidPermission(
    target: { adbPath: string; deviceSerial: string; packageName: string },
    androidPermission: string,
    action: string,
    outcome: { errors: string[]; skippedUndeclaredRuntime: number },
  ): Promise<void> {
    if (androidPermission === 'SYSTEM_ALERT_WINDOW') {
      const result = await this._toggleSystemAlertWindowPermission(
        target.adbPath,
        target.deviceSerial,
        target.packageName,
        action,
      );
      if (!result.success) {
        outcome.errors.push(
          `Failed to update ${androidPermission}: ${result.message ?? 'unknown error'}`,
        );
      }
      return;
    }

    const adbAction = action === 'allow' ? 'grant' : 'revoke';
    const failurePrefix = `Failed to ${adbAction} ${androidPermission} on ${target.deviceSerial}`;
    const result = await this._runAdb(
      target.adbPath,
      [
        '-s',
        target.deviceSerial,
        'shell',
        'pm',
        adbAction,
        target.packageName,
        androidPermission,
      ],
      failurePrefix,
      { suppressErrorLog: true },
    );
    if (result.success) {
      return;
    }
    const textForMatch = `${result.stderr ?? ''}\n${result.message ?? ''}`;
    if (isUndeclaredPermissionGrantFailure(textForMatch)) {
      outcome.skippedUndeclaredRuntime += 1;
      return;
    }
    Logger.e(failurePrefix, new Error(result.message ?? 'unknown error'));
    outcome.errors.push(
      `Failed to update ${androidPermission}: ${result.message ?? 'unknown error'}`,
    );
  }

  async toggleDisableBatteryOptimization(
    adbPath: string,
    deviceSerial: string,
    packageName: string,
    disableOptimization: boolean,
  ): Promise<AndroidCommandResult> {
    return await this._runAdb(
      adbPath,
      [
        '-s',
        deviceSerial,
        'shell',
        'dumpsys',
        'deviceidle',
        'whitelist',
        `${disableOptimization ? '+' : '-'}${packageName}`,
      ],
      `Failed to update battery optimization whitelist for ${packageName} on ${deviceSerial}`,
    );
  }

  async performMockLocation(
    adbPath: string,
    deviceSerial: string,
    driverPackageName: string = ANDROID_DRIVER_APP_PACKAGE_NAME,
  ): Promise<AndroidCommandResult> {
    return await this._runAdb(
      adbPath,
      [
        '-s',
        deviceSerial,
        'shell',
        'appops',
        'set',
        driverPackageName,
        'android:mock_location',
        'allow',
      ],
      `Failed to enable mock location on ${deviceSerial}`,
    );
  }

  async performGeoFix(
    adbPath: string,
    deviceSerial: string,
    latitude: number,
    longitude: number,
  ): Promise<AndroidCommandResult> {
    return await this._runAdb(
      adbPath,
      [
        '-s',
        deviceSerial,
        'emu',
        'geo',
        'fix',
        String(longitude),
        String(latitude),
      ],
      `Failed to set emulator geo fix on ${deviceSerial}`,
    );
  }

  /**
   * Pick the lowest free port in [PORT_RANGE_START, PORT_RANGE_END) that is
   * BOTH not currently assigned to a known device AND actually bindable on
   * the host.
   *
   * Serialized via the allocation mutex so concurrent forwardPort() calls
   * can't both observe the same port as free between the bindability probe
   * and the reservation.
   */
  private async _allocatePort(deviceSerial: string): Promise<number> {
    return this._withAllocationLock(async () => {
      const existingPort = this._portMap.get(deviceSerial);
      if (existingPort !== undefined) {
        return existingPort;
      }

      for (let port = PORT_RANGE_START; port < PORT_RANGE_END; port++) {
        if (this._allocatedPorts.has(port)) continue;
        if (!(await this._isPortBindable(port))) continue;

        this._allocatedPorts.add(port);
        this._portMap.set(deviceSerial, port);
        Logger.d(`Allocated port ${port} for ${deviceSerial}`);
        return port;
      }

      throw new Error(
        `No ports available in range ${PORT_RANGE_START}-${PORT_RANGE_END}`,
      );
    });
  }

  /** Return a port to the pool. */
  private async _releasePort(deviceSerial: string): Promise<void> {
    await this._withAllocationLock(async () => {
      const port = this._portMap.get(deviceSerial);
      if (port === undefined) return;
      this._portMap.delete(deviceSerial);
      this._allocatedPorts.delete(port);
      Logger.d(`Released port ${port} for ${deviceSerial}`);
    });
  }

  /**
   * Probe whether the host kernel can actually bind this port right now.
   * If anything else on the host is squatting on it, skip and try the next.
   */
  private _isPortBindable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => {
        server.close(() => resolve(true));
      });
    });
  }

  private async _runAdb(
    adbPath: string,
    args: readonly string[],
    failurePrefix: string,
    options?: { suppressErrorLog?: boolean },
  ): Promise<AndroidCommandResult> {
    try {
      const { stdout, stderr } = await this._execFileFn(adbPath, args);
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

  private _normalizeKeyName(key: string): string {
    return key.trim().toLowerCase().replace(/[\s-]+/g, '_');
  }

  private _translatePermissionName(permissionName: string): string[] {
    if (permissionName.includes('.')) {
      return [permissionName];
    }

    return ANDROID_PERMISSION_TRANSLATIONS[permissionName] ?? [];
  }

  private async _toggleSystemAlertWindowPermission(
    adbPath: string,
    deviceSerial: string,
    packageName: string,
    action: string,
  ): Promise<AndroidCommandResult> {
    const mode = action === 'allow' ? 'allow' : action === 'unset' ? 'default' : 'deny';
    return await this._runAdb(
      adbPath,
      [
        '-s',
        deviceSerial,
        'shell',
        'appops',
        'set',
        packageName,
        'SYSTEM_ALERT_WINDOW',
        mode,
      ],
      `Failed to update overlay permission for ${packageName} on ${deviceSerial}`,
    );
  }
}
