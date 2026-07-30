import {
  DeviceNodeResponse,
  Logger,
  type BackAction,
  type CheckAppInForegroundAction,
  type DeeplinkAction,
  type DeviceAppInfo,
  type EraseTextAction,
  type EnterTextAction,
  type GetHierarchyAction,
  type GetScreenshotAction,
  type HideKeyboardAction,
  type HomeAction,
  type KillAppAction,
  type LaunchAppAction,
  type LongPressAction,
  type PressKeyAction,
  type RotateAction,
  type ScrollAbsAction,
  type SetLocationAction,
  type SwitchToPrimaryAppAction,
  type TapAction,
  type TapPercentAction,
} from '@finalrun/common';
import {
  IOS_DRIVER_RUNNER_BUNDLE_ID,
  type IOSDriverProcessHandle,
  type SimctlClient,
} from '../../infra/ios/SimctlClient.js';
import { CommonDriverActions } from '../shared/CommonDriverActions.js';
import type {
  DeviceRuntime,
  DeviceScreenshotAndHierarchy,
} from '../shared/DeviceRuntime.js';

/**
 * Operations `_withDriverRecovery` may re-execute after restarting a dead
 * driver, named by the `opName` every call site already passes.
 *
 * The list is deliberately short. A driver can die *after* the request reached
 * the device, so replaying anything that touches the device applies it twice —
 * a duplicated tap or a duplicated keystroke. `GrpcDriverClient._unaryCall`
 * defaults `maxRetries` to 0 for exactly this reason; a recovery path that
 * re-ran the call anyway reinstated the duplication one layer up.
 *
 * What is safe to replay is a read whose result is the whole point of the call,
 * plus `updateAppIds`: a restarted driver has lost its app-id list, so replaying
 * it is required for correctness, and it mutates driver state only, never the
 * device.
 *
 * An operation not listed here is NOT replayed — the default falls the safe way,
 * so a new device action added later needs a deliberate decision to opt in.
 */
const REPLAYABLE_AFTER_DRIVER_RESTART: ReadonlySet<string> = new Set([
  'captureState',
  'checkAppInForeground',
  'getHierarchy',
  'getScreenshot',
  'getScreenshotAndHierarchy',
  'updateAppIds',
]);

export class IOSSimulator implements DeviceRuntime {
  private _commonDriverActions: CommonDriverActions;
  private _simctlClient: SimctlClient;
  private _deviceId: string;
  private _driverProcess: IOSDriverProcessHandle;
  private _restartDriverFn: () => Promise<IOSDriverProcessHandle>;

  constructor(params: {
    commonDriverActions: CommonDriverActions;
    simctlClient: SimctlClient;
    deviceId: string;
    driverProcess: IOSDriverProcessHandle;
    restartDriver: () => Promise<IOSDriverProcessHandle>;
  }) {
    this._commonDriverActions = params.commonDriverActions;
    this._simctlClient = params.simctlClient;
    this._deviceId = params.deviceId;
    this._driverProcess = params.driverProcess;
    this._restartDriverFn = params.restartDriver;
  }

  setShouldEnsureStability(shouldEnsureStability: boolean | undefined): void {
    this._commonDriverActions.setShouldEnsureStability(shouldEnsureStability);
  }

  isConnected(): boolean {
    return this._commonDriverActions.isConnected();
  }

  async tap(action: TapAction): Promise<DeviceNodeResponse> {
    return this._withDriverRecovery('tap', () => this._commonDriverActions.tap(action));
  }

  async tapPercent(action: TapPercentAction): Promise<DeviceNodeResponse> {
    return this._withDriverRecovery('tapPercent', () => this._commonDriverActions.tapPercent(action));
  }

  async longPress(action: LongPressAction): Promise<DeviceNodeResponse> {
    return this._withDriverRecovery('longPress', () => this._commonDriverActions.longPress(action));
  }

  async enterText(action: EnterTextAction): Promise<DeviceNodeResponse> {
    return this._withDriverRecovery('enterText', () => this._commonDriverActions.enterText(action));
  }

  async eraseText(action: EraseTextAction): Promise<DeviceNodeResponse> {
    return this._withDriverRecovery('eraseText', () => this._commonDriverActions.eraseText(action));
  }

  async scrollAbs(action: ScrollAbsAction): Promise<DeviceNodeResponse> {
    return this._withDriverRecovery('scrollAbs', () => this._commonDriverActions.swipe(action));
  }

  async back(_action: BackAction): Promise<DeviceNodeResponse> {
    return await this._commonDriverActions.back();
  }

  async home(_action: HomeAction): Promise<DeviceNodeResponse> {
    return this._toResponse(
      await this._simctlClient.pressButton(this._deviceId, 'home'),
    );
  }

  async rotate(action: RotateAction): Promise<DeviceNodeResponse> {
    return this._withDriverRecovery('rotate', () => this._commonDriverActions.rotate(action));
  }

  async hideKeyboard(_action: HideKeyboardAction): Promise<DeviceNodeResponse> {
    return this._withDriverRecovery('hideKeyboard', () => this._commonDriverActions.hideKeyboard());
  }

  async pressKey(action: PressKeyAction): Promise<DeviceNodeResponse> {
    const physicalButton = this._getPhysicalButtonForKey(action.key);
    if (physicalButton) {
      return this._toResponse(
        await this._simctlClient.pressButton(this._deviceId, physicalButton),
      );
    }

    return this._withDriverRecovery('pressKey', () => this._commonDriverActions.pressKey(action));
  }

  async launchApp(action: LaunchAppAction): Promise<DeviceNodeResponse> {
    const presenceCheck = await this._simctlClient.isAppInstalled(
      this._deviceId,
      action.appUpload.packageName,
    );
    if (!presenceCheck.success) {
      return this._toResponse(presenceCheck);
    }

    try {
      await this.refreshInstalledAppIds({ throwOnFailure: false });
    } catch (error) {
      Logger.w('Failed to refresh iOS app IDs before launch:', error);
    }

    if (action.stopAppBeforeLaunch) {
      const terminateResult = await this._simctlClient.terminateAppResult(
        this._deviceId,
        action.appUpload.packageName,
      );
      if (!terminateResult.success) {
        return this._toResponse(terminateResult);
      }
    }

    if (action.clearState) {
      return new DeviceNodeResponse({
        success: false,
        message:
          'iOS clearState is not supported in finalrun-ts without an install artifact path for reinstall.',
      });
    }

    let permissionsResult:
      | {
          success: boolean;
          message?: string;
          data?: Record<string, unknown>;
        }
      | null = null;

    if (action.allowAllPermissions) {
      permissionsResult = await this._simctlClient.allowAllPermissions(
        this._deviceId,
        action.appUpload.packageName,
      );
    } else if (Object.keys(action.permissions).length > 0) {
      permissionsResult = await this._simctlClient.togglePermissions(
        this._deviceId,
        action.appUpload.packageName,
        action.permissions,
      );
    }

    if (permissionsResult && !permissionsResult.success) {
      return this._toResponse(permissionsResult);
    }

    const launchResponse = await this._withDriverRecovery('launchApp',
      () => this._commonDriverActions.launchApp(action),
    );
    return this._mergeLaunchResponse(launchResponse, permissionsResult);
  }

  async killApp(action: KillAppAction): Promise<DeviceNodeResponse> {
    return this._toResponse(
      await this._simctlClient.terminateAppResult(
        this._deviceId,
        action.packageName,
      ),
    );
  }

  async openDeepLink(action: DeeplinkAction): Promise<DeviceNodeResponse> {
    const opened = await this._simctlClient.openUrl(this._deviceId, action.deeplink);
    return new DeviceNodeResponse({
      success: opened,
      message: opened
        ? `Successfully opened deep link: ${action.deeplink}`
        : `Failed to open deep link: ${action.deeplink}`,
    });
  }

  async setLocation(action: SetLocationAction): Promise<DeviceNodeResponse> {
    return this._toResponse(
      await this._simctlClient.setLocation(
        this._deviceId,
        action.lat,
        action.long,
      ),
    );
  }

  async switchToPrimaryApp(
    action: SwitchToPrimaryAppAction,
  ): Promise<DeviceNodeResponse> {
    return this._toResponse(
      await this._simctlClient.bringAppToForeground(
        this._deviceId,
        action.packageName,
      ),
    );
  }

  async checkAppInForeground(
    action: CheckAppInForegroundAction,
  ): Promise<DeviceNodeResponse> {
    return this._withDriverRecovery('checkAppInForeground', () => this._commonDriverActions.checkAppInForeground(action));
  }

  async captureState(traceStep?: number | null): Promise<DeviceNodeResponse> {
    return this._withDriverRecovery('captureState', () => this._commonDriverActions.captureState(traceStep));
  }

  async getInstalledAppsResponse(): Promise<DeviceNodeResponse> {
    const apps = await this.getInstalledApps();
    return new DeviceNodeResponse({
      success: true,
      data: {
        apps: apps.map((app) => app.toJson()),
      },
    });
  }

  async getInstalledApps(): Promise<DeviceAppInfo[]> {
    return await this._simctlClient.listInstalledApps(this._deviceId);
  }

  async getScreenshot(action: GetScreenshotAction): Promise<DeviceNodeResponse> {
    return this._withDriverRecovery('getScreenshot', () => this._commonDriverActions.getScreenshot(action));
  }

  async getHierarchy(action: GetHierarchyAction): Promise<DeviceNodeResponse> {
    return this._withDriverRecovery('getHierarchy', () => this._commonDriverActions.getHierarchy(action));
  }

  async getScreenshotAndHierarchy(): Promise<DeviceScreenshotAndHierarchy> {
    return this._withDriverRecovery('getScreenshotAndHierarchy', () => this._commonDriverActions.getScreenshotAndHierarchy());
  }

  async refreshInstalledAppIds(
    options: { throwOnFailure: boolean },
  ): Promise<void> {
    const appIds = await this._simctlClient.listInstalledAppIds(this._deviceId);
    Logger.i(`Sending ${appIds.length} iOS app IDs to driver...`);
    const updateResponse = await this._withDriverRecovery('updateAppIds', () => this._commonDriverActions.updateAppIds(appIds));
    if (updateResponse.success) {
      return;
    }

    const message =
      `Failed to update iOS app IDs: ${updateResponse.message ?? 'unknown error'}`;
    if (options.throwOnFailure) {
      throw new Error(message);
    }
    Logger.w(message);
  }

  async close(): Promise<void> {
    try {
      await this._simctlClient.terminateApp(this._deviceId, IOS_DRIVER_RUNNER_BUNDLE_ID);
    } finally {
      this._commonDriverActions.close();
    }
  }

  async resolveLogFilterIdentifier(appIdentifier: string): Promise<string | null> {
    return await this._simctlClient.getAppExecutableName(this._deviceId, appIdentifier);
  }

  /**
   * `DeviceAgent.killDriver()`'s implementation for this platform: it closes the
   * gRPC channel and nothing else. The on-device driver process stays alive — the
   * interface name predates this port and is not renamed here.
   */
  killDriver(): void {
    this._commonDriverActions.closeDriverChannel();
  }

  private _getPhysicalButtonForKey(key: string): string | null {
    const normalizedKey = key.trim().toLowerCase().replace(/[\s-]+/g, '_');
    switch (normalizedKey) {
      case 'home':
      case 'menu':
        return 'home';
      case 'lock':
      case 'power':
        return 'lock';
      case 'volume_up':
      case 'volumeup':
        return 'volumeup';
      case 'volume_down':
      case 'volumedown':
        return 'volumedown';
      default:
        return null;
    }
  }

  private _toResponse(result: {
    success: boolean;
    message?: string;
    data?: Record<string, unknown>;
  }): DeviceNodeResponse {
    return new DeviceNodeResponse({
      success: result.success,
      message: result.message,
      data: result.data,
    });
  }

  // ---------------------------------------------------------------------------
  // Driver recovery — detects driver death via process state, restarts if needed
  // ---------------------------------------------------------------------------

  private _isDriverAlive(): boolean {
    return this._driverProcess.exitCode === null && !this._driverProcess.killed;
  }

  /**
   * Runs `fn`, and if it fails because the driver process has died, restarts the
   * driver so the *next* operation can succeed.
   *
   * Whether this operation itself is retried depends on `opName`: only the
   * members of {@link REPLAYABLE_AFTER_DRIVER_RESTART} are re-executed.
   * Everything else surfaces the original error after the restart, because the
   * driver may have died after the action already reached the device and a
   * second attempt would apply it twice.
   */
  private async _withDriverRecovery<T>(
    opName: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      // Check process state — the source of truth, no error parsing
      if (this._isDriverAlive()) throw error;

      Logger.w(
        `IOSSimulator.${opName}: driver process exited, attempting restart...`,
      );
      try {
        this._driverProcess = await this._restartDriverFn();
      } catch (restartError) {
        Logger.e(`IOSSimulator.${opName}: driver restart failed`, restartError);
        throw error;
      }

      if (!REPLAYABLE_AFTER_DRIVER_RESTART.has(opName)) {
        Logger.w(
          `IOSSimulator.${opName}: driver restarted, but this operation is not replayed (it may already have reached the device) — reporting the original failure`,
        );
        throw error;
      }

      return await fn();
    }
  }

  private _mergeLaunchResponse(
    launchResponse: DeviceNodeResponse,
    permissionsResult:
      | {
          success: boolean;
          message?: string;
          data?: Record<string, unknown>;
        }
      | null,
  ): DeviceNodeResponse {
    if (!permissionsResult?.message && !permissionsResult?.data) {
      return launchResponse;
    }

    return new DeviceNodeResponse({
      success: launchResponse.success,
      message: [launchResponse.message, permissionsResult.message]
        .filter((message): message is string => Boolean(message))
        .join(' '),
      data: {
        ...(launchResponse.data ?? {}),
        ...(permissionsResult.data ?? {}),
      },
    });
  }
}
