import {
  DeviceNodeResponse,
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
import type {
  AdbClient,
  AndroidCommandResult,
} from '../../infra/android/AdbClient.js';
import { CommonDriverActions } from '../shared/CommonDriverActions.js';
import type {
  DeviceRuntime,
  DeviceScreenshotAndHierarchy,
} from '../shared/DeviceRuntime.js';

export class AndroidDevice implements DeviceRuntime {
  private _commonDriverActions: CommonDriverActions;
  private _adbClient: AdbClient;
  private _adbPath: string;
  private _deviceSerial: string;

  constructor(params: {
    commonDriverActions: CommonDriverActions;
    adbClient: AdbClient;
    adbPath: string;
    deviceSerial: string;
  }) {
    this._commonDriverActions = params.commonDriverActions;
    this._adbClient = params.adbClient;
    this._adbPath = params.adbPath;
    this._deviceSerial = params.deviceSerial;
  }

  setShouldEnsureStability(shouldEnsureStability: boolean | undefined): void {
    this._commonDriverActions.setShouldEnsureStability(shouldEnsureStability);
  }

  isConnected(): boolean {
    return this._commonDriverActions.isConnected();
  }

  async tap(action: TapAction): Promise<DeviceNodeResponse> {
    return await this._commonDriverActions.tap(action);
  }

  async tapPercent(action: TapPercentAction): Promise<DeviceNodeResponse> {
    return await this._commonDriverActions.tapPercent(action);
  }

  async longPress(action: LongPressAction): Promise<DeviceNodeResponse> {
    return await this._commonDriverActions.longPress(action);
  }

  async enterText(action: EnterTextAction): Promise<DeviceNodeResponse> {
    return await this._commonDriverActions.enterText(action);
  }

  async eraseText(action: EraseTextAction): Promise<DeviceNodeResponse> {
    return await this._commonDriverActions.eraseText(action);
  }

  async scrollAbs(action: ScrollAbsAction): Promise<DeviceNodeResponse> {
    const response = await this._adbClient.swipe(this._adbPath, this._deviceSerial, {
      startX: action.startX,
      startY: action.startY,
      endX: action.endX,
      endY: action.endY,
      durationMs: action.durationMs,
    });
    return new DeviceNodeResponse({
      success: response.success,
      message: response.message,
    });
  }

  async back(_action: BackAction): Promise<DeviceNodeResponse> {
    return this._toResponse(await this._adbClient.back(this._adbPath, this._deviceSerial));
  }

  async home(_action: HomeAction): Promise<DeviceNodeResponse> {
    return this._toResponse(await this._adbClient.home(this._adbPath, this._deviceSerial));
  }

  async rotate(_action: RotateAction): Promise<DeviceNodeResponse> {
    return this._toResponse(
      await this._adbClient.rotate(this._adbPath, this._deviceSerial),
    );
  }

  async hideKeyboard(_action: HideKeyboardAction): Promise<DeviceNodeResponse> {
    return this._toResponse(
      await this._adbClient.hideKeyboard(this._adbPath, this._deviceSerial),
    );
  }

  async pressKey(action: PressKeyAction): Promise<DeviceNodeResponse> {
    const adbResult = await this._adbClient.performKeyPress(
      this._adbPath,
      this._deviceSerial,
      action.key,
    );
    if (adbResult.success || adbResult.data?.['handled'] !== false) {
      return this._toResponse(adbResult);
    }

    return await this._commonDriverActions.pressKey(action);
  }

  async launchApp(action: LaunchAppAction): Promise<DeviceNodeResponse> {
    const packageCheck = await this._adbClient.isPackageInstalled(
      this._adbPath,
      this._deviceSerial,
      action.appUpload.packageName,
    );
    if (!packageCheck.success) {
      return this._toResponse(packageCheck);
    }

    if (action.stopAppBeforeLaunch) {
      const stopResult = await this._adbClient.forceStop(
        this._adbPath,
        this._deviceSerial,
        action.appUpload.packageName,
      );
      if (!stopResult.success) {
        return this._toResponse(stopResult);
      }
    }

    if (action.clearState) {
      const clearResult = await this._adbClient.clearAppData(
        this._adbPath,
        this._deviceSerial,
        action.appUpload.packageName,
      );
      if (!clearResult.success) {
        return this._toResponse(clearResult);
      }
    }

    if (action.allowAllPermissions) {
      const permissionsResult = await this._adbClient.allowAllPermissions(
        this._adbPath,
        this._deviceSerial,
        action.appUpload.packageName,
      );
      if (!permissionsResult.success) {
        return this._toResponse(permissionsResult);
      }
    } else if (Object.keys(action.permissions).length > 0) {
      const permissionsResult = await this._adbClient.togglePermissions(
        this._adbPath,
        this._deviceSerial,
        action.appUpload.packageName,
        action.permissions,
      );
      if (!permissionsResult.success) {
        return this._toResponse(permissionsResult);
      }
    }

    return await this._commonDriverActions.launchApp(action);
  }

  async killApp(action: KillAppAction): Promise<DeviceNodeResponse> {
    return this._toResponse(
      await this._adbClient.forceStop(
        this._adbPath,
        this._deviceSerial,
        action.packageName,
      ),
    );
  }

  async openDeepLink(action: DeeplinkAction): Promise<DeviceNodeResponse> {
    const opened = await this._adbClient.openDeepLink(
      this._adbPath,
      this._deviceSerial,
      action.deeplink,
    );
    return new DeviceNodeResponse({
      success: opened,
      message: opened
        ? `Successfully opened deep link: ${action.deeplink}`
        : `Failed to open deep link: ${action.deeplink}`,
    });
  }

  async setLocation(action: SetLocationAction): Promise<DeviceNodeResponse> {
    const mockLocationResult = await this._adbClient.performMockLocation(
      this._adbPath,
      this._deviceSerial,
    );
    if (!mockLocationResult.success) {
      return this._toResponse(mockLocationResult);
    }

    return await this._commonDriverActions.setLocation(action);
  }

  async switchToPrimaryApp(
    action: SwitchToPrimaryAppAction,
  ): Promise<DeviceNodeResponse> {
    return this._toResponse(
      await this._adbClient.bringAppToForeground(
        this._adbPath,
        this._deviceSerial,
        action.packageName,
      ),
    );
  }

  async checkAppInForeground(
    action: CheckAppInForegroundAction,
  ): Promise<DeviceNodeResponse> {
    return await this._commonDriverActions.checkAppInForeground(action);
  }

  async captureState(traceStep?: number | null): Promise<DeviceNodeResponse> {
    return await this._commonDriverActions.captureState(traceStep);
  }

  async getInstalledAppsResponse(): Promise<DeviceNodeResponse> {
    return await this._commonDriverActions.getInstalledAppsResponseFromDriver();
  }

  async getInstalledApps(): Promise<DeviceAppInfo[]> {
    return await this._commonDriverActions.getInstalledAppsFromDriver();
  }

  async getScreenshot(action: GetScreenshotAction): Promise<DeviceNodeResponse> {
    return await this._commonDriverActions.getScreenshot(action);
  }

  async getHierarchy(action: GetHierarchyAction): Promise<DeviceNodeResponse> {
    return await this._commonDriverActions.getHierarchy(action);
  }

  async getScreenshotAndHierarchy(): Promise<DeviceScreenshotAndHierarchy> {
    return await this._commonDriverActions.getScreenshotAndHierarchy();
  }

  async close(): Promise<void> {
    try {
      await this._adbClient.removePortForward(this._adbPath, this._deviceSerial);
    } finally {
      this._commonDriverActions.close();
    }
  }

  killDriver(): void {
    this._commonDriverActions.killDriver();
  }

  private _toResponse(result: AndroidCommandResult): DeviceNodeResponse {
    return new DeviceNodeResponse({
      success: result.success,
      message: result.message,
      data: result.data,
    });
  }
}
