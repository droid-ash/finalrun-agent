// Port of device_node/lib/device/Device.dart
// Implements the DeviceAgent interface with a stable wrapper over a platform runtime.

import {
  DeviceAgent,
  DeviceActionRequest,
  DeviceInfo,
  DeviceNodeResponse,
  DeviceAppInfo,
  Logger,
  type RecordingRequest,
  DeviceAction,
  TapAction,
  TapPercentAction,
  LongPressAction,
  EnterTextAction,
  EraseTextAction,
  ScrollAbsAction,
  BackAction,
  HomeAction,
  RotateAction,
  HideKeyboardAction,
  PressKeyAction,
  LaunchAppAction,
  GetHierarchyAction,
  GetScreenshotAction,
  SetLocationAction,
  KillAppAction,
  SwitchToPrimaryAppAction,
  CheckAppInForegroundAction,
  DeeplinkAction,
} from '@finalrun/common';
import {
  defaultRecordingManager,
  type DeviceRecordingController,
} from './RecordingManager.js';
import {
  defaultLogCaptureManager,
  type DeviceLogCaptureController,
} from './LogCaptureManager.js';
import type {
  DeviceRuntime,
  DeviceScreenshotAndHierarchy,
} from './shared/DeviceRuntime.js';

/**
 * Represents a single connected device and implements the DeviceAgent interface.
 * Bridges DeviceActionRequest -> runtime capability methods.
 *
 * Dart equivalent: Device in device_node/lib/device/Device.dart
 */
export class Device implements DeviceAgent {
  private _deviceInfo: DeviceInfo;
  private _runtime: DeviceRuntime;
  private _apiKey: string = '';
  private _disconnectionCallback: ((deviceUUID: string, reason: string) => void) | null = null;
  private _disconnectionNotified: boolean = false;
  private _recordingController: DeviceRecordingController;
  private _logCaptureController: DeviceLogCaptureController;

  constructor(params: {
    deviceInfo: DeviceInfo;
    runtime: DeviceRuntime;
    recordingController?: DeviceRecordingController;
    logCaptureController?: DeviceLogCaptureController;
  }) {
    this._deviceInfo = params.deviceInfo;
    this._runtime = params.runtime;
    this._recordingController = params.recordingController ?? defaultRecordingManager;
    this._logCaptureController = params.logCaptureController ?? defaultLogCaptureManager;
  }

  async setUp(_options?: { reuseAddress?: boolean }): Promise<DeviceNodeResponse> {
    if (!this._runtime.isConnected()) {
      return new DeviceNodeResponse({
        success: false,
        message: 'gRPC client not connected',
      });
    }
    return new DeviceNodeResponse({ success: true });
  }

  async executeAction(request: DeviceActionRequest): Promise<DeviceNodeResponse> {
    try {
      this._runtime.setShouldEnsureStability(request.shouldEnsureStability);
      const action = request.action;

      return (
        (await this._executeGestureAction(action)) ??
        (await this._executeNavigationAction(action)) ??
        (await this._executeAppAction(action)) ??
        (await this._executeCaptureAction(request, action)) ??
        new DeviceNodeResponse({
          success: false,
          message: `Unsupported action type: ${action.type}`,
        })
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      Logger.e(`Action execution failed: ${message}`);
      this._notifyIfDisconnected(message);
      return new DeviceNodeResponse({
        success: false,
        message: `Action failed: ${message}`,
      });
    }
  }

  /**
   * Fires the handler registered by {@link listenForDeviceDisconnection}, if the
   * runtime has stopped reporting a connection.
   *
   * An action that threw while `runtime.isConnected()` is false is the only
   * disconnection signal `Device` receives: nothing in the stack emits a
   * disconnection event to subscribe to, so this is where a lost connection
   * becomes observable. Notifies at most once per registration — a single dead
   * connection otherwise produces one callback per subsequent failing action —
   * and re-arms when a handler is registered again.
   *
   * Never throws. It is called from `executeAction`'s `catch`, so an exception
   * escaping it would make `executeAction` **reject** instead of returning the
   * `Action failed: …` response its contract promises, and would replace the
   * original action error with an unrelated one. Both remaining steps run
   * foreign code — the runtime's `isConnected()` and the caller-supplied
   * handler — so both are guarded: the notification is best-effort, the action's
   * own reported outcome is not.
   */
  private _notifyIfDisconnected(reason: string): void {
    const notifyDisconnected = this._disconnectionCallback;
    if (!notifyDisconnected || this._disconnectionNotified) {
      return;
    }

    try {
      if (this._runtime.isConnected()) {
        return;
      }

      // Armed before the call, so a handler that throws is still not called a
      // second time by the next failing action.
      this._disconnectionNotified = true;
      Logger.w(
        `Device ${this._deviceInfo.deviceUUID} appears disconnected; notifying listener: ${reason}`,
      );
      notifyDisconnected(this._deviceInfo.deviceUUID, reason);
    } catch (error) {
      Logger.w(
        `Device ${this._deviceInfo.deviceUUID}: disconnection listener notification failed:`,
        error,
      );
    }
  }

  /** Gesture and text-input actions; null when the action is not in this category. */
  private async _executeGestureAction(
    action: DeviceActionRequest['action'],
  ): Promise<DeviceNodeResponse | null> {
    switch (action.type) {
      case DeviceAction.TAP:
        return await this._runtime.tap(action as TapAction);

      case DeviceAction.TAP_PERCENT:
        return await this._runtime.tapPercent(action as TapPercentAction);

      case DeviceAction.LONG_PRESS:
        return await this._runtime.longPress(action as LongPressAction);

      case DeviceAction.ENTER_TEXT:
        return await this._runtime.enterText(action as EnterTextAction);

      case DeviceAction.ERASE_TEXT:
        return await this._runtime.eraseText(action as EraseTextAction);

      case DeviceAction.SCROLL_ABS:
        return await this._runtime.scrollAbs(action as ScrollAbsAction);

      default:
        return null;
    }
  }

  /** Navigation and key actions; null when the action is not in this category. */
  private async _executeNavigationAction(
    action: DeviceActionRequest['action'],
  ): Promise<DeviceNodeResponse | null> {
    switch (action.type) {
      case DeviceAction.BACK:
        return await this._runtime.back(action as BackAction);

      case DeviceAction.HOME:
        return await this._runtime.home(action as HomeAction);

      case DeviceAction.ROTATE:
        return await this._runtime.rotate(action as RotateAction);

      case DeviceAction.HIDE_KEYBOARD:
        return await this._runtime.hideKeyboard(action as HideKeyboardAction);

      case DeviceAction.PRESS_KEY:
        return await this._runtime.pressKey(action as PressKeyAction);

      default:
        return null;
    }
  }

  /** App lifecycle and device-state actions; null when the action is not in this category. */
  private async _executeAppAction(
    action: DeviceActionRequest['action'],
  ): Promise<DeviceNodeResponse | null> {
    switch (action.type) {
      case DeviceAction.LAUNCH_APP:
        return await this._runtime.launchApp(action as LaunchAppAction);

      case DeviceAction.KILL_APP:
        return await this._runtime.killApp(action as KillAppAction);

      case DeviceAction.DEEPLINK: {
        const deeplinkAction = action as DeeplinkAction;
        Logger.d(`Executing deeplink action: ${deeplinkAction.deeplink}`);
        return await this._runtime.openDeepLink(deeplinkAction);
      }

      case DeviceAction.SET_LOCATION:
        return await this._runtime.setLocation(action as SetLocationAction);

      case DeviceAction.SWITCH_TO_PRIMARY_APP:
        return await this._runtime.switchToPrimaryApp(
          action as SwitchToPrimaryAppAction,
        );

      case DeviceAction.CHECK_APP_IN_FOREGROUND:
        return await this._runtime.checkAppInForeground(
          action as CheckAppInForegroundAction,
        );

      default:
        return null;
    }
  }

  /** Capture and query actions; null when the action is not in this category. */
  private async _executeCaptureAction(
    request: DeviceActionRequest,
    action: DeviceActionRequest['action'],
  ): Promise<DeviceNodeResponse | null> {
    switch (action.type) {
      case DeviceAction.GET_SCREENSHOT_AND_HIERARCHY:
        return await this._runtime.captureState(request.traceStep);

      case DeviceAction.GET_SCREENSHOT:
        return await this._runtime.getScreenshot(action as GetScreenshotAction);

      case DeviceAction.GET_HIERARCHY:
        return await this._runtime.getHierarchy(action as GetHierarchyAction);

      case DeviceAction.GET_APP_LIST:
        return await this._runtime.getInstalledAppsResponse();

      case DeviceAction.WAIT:
        return new DeviceNodeResponse({ success: true });

      default:
        return null;
    }
  }

  isConnected(): boolean {
    return this._runtime.isConnected();
  }

  getDeviceInfo(): DeviceInfo {
    return this._deviceInfo;
  }

  async closeConnection(): Promise<void> {
    try {
      await this.recordingCleanUp();
    } catch (error) {
      Logger.w('Failed to clean up recording resources:', error);
    }
    try {
      await this.logCaptureCleanUp();
    } catch (error) {
      Logger.w('Failed to clean up log capture resources:', error);
    }
    await this._runtime.close();
  }

  /**
   * `DeviceAgent.killDriver()`'s facade: forwards to the runtime, which closes
   * the gRPC channel to the on-device driver and nothing else. The driver
   * process stays alive — the name predates this port and is not renamed here.
   */
  killDriver(): void {
    this._runtime.killDriver();
  }

  setApiKey(apiKey: string): void {
    this._apiKey = apiKey;
  }

  getId(): string {
    return this._deviceInfo.deviceUUID;
  }

  /**
   * Registers a handler invoked when this device is observed to have
   * disconnected — see `_notifyIfDisconnected` for what counts as observing it.
   * Registering re-arms the one-shot, so a caller that re-registers after a
   * reconnect is notified again.
   */
  listenForDeviceDisconnection(callbacks: {
    onDeviceDisconnected: (deviceUUID: string, reason: string) => void;
  }): void {
    this._disconnectionCallback = callbacks.onDeviceDisconnected;
    this._disconnectionNotified = false;
  }

  clearListener(): void {
    this._disconnectionCallback = null;
    this._disconnectionNotified = false;
  }

  async startRecording(recordingRequest: RecordingRequest): Promise<DeviceNodeResponse> {
    if (!this._deviceInfo.id) {
      return new DeviceNodeResponse({
        success: false,
        message: 'Device ID is required to start recording.',
      });
    }

    return await this._recordingController.startRecording({
      deviceId: this._deviceInfo.id,
      recordingRequest,
      platform: this._deviceInfo.getPlatform(),
      sdkVersion:
        this._deviceInfo.sdkVersion > 0 ? String(this._deviceInfo.sdkVersion) : undefined,
    });
  }

  async stopRecording(runId: string, testId: string): Promise<DeviceNodeResponse> {
    return await this._recordingController.stopRecording(runId, testId, {
      platform: this._deviceInfo.getPlatform(),
      keepOutput: true,
    });
  }

  async recordingCleanUp(): Promise<void> {
    if (!this._deviceInfo.id) {
      return;
    }

    await this._recordingController.cleanupDevice(this._deviceInfo.id, {
      platform: this._deviceInfo.getPlatform(),
      keepOutput: false,
    });
  }

  async abortRecording(runId: string, keepOutput: boolean = false): Promise<void> {
    if (!this._deviceInfo.id) {
      return;
    }

    await this._recordingController.abortRecording(runId, {
      deviceId: this._deviceInfo.id,
      platform: this._deviceInfo.getPlatform(),
      keepOutput,
    });
  }

  async startLogCapture(request: {
    runId: string;
    testId: string;
    appIdentifier?: string;
  }): Promise<DeviceNodeResponse> {
    if (!this._deviceInfo.id) {
      return new DeviceNodeResponse({
        success: false,
        message: 'Device ID is required to start log capture.',
      });
    }

    let logIdentifier = request.appIdentifier;
    if (logIdentifier && this._runtime.resolveLogFilterIdentifier) {
      const resolved = await this._runtime.resolveLogFilterIdentifier(logIdentifier);
      if (resolved) {
        logIdentifier = resolved;
      } else {
        Logger.w(`Could not resolve log filter identifier for "${logIdentifier}"; capturing unfiltered log`);
        logIdentifier = undefined;
      }
    }

    return await this._logCaptureController.startLogCapture({
      deviceId: this._deviceInfo.id,
      runId: request.runId,
      testId: request.testId,
      platform: this._deviceInfo.getPlatform(),
      appIdentifier: logIdentifier,
    });
  }

  async stopLogCapture(runId: string, testId: string): Promise<DeviceNodeResponse> {
    return await this._logCaptureController.stopLogCapture(runId, testId, {
      platform: this._deviceInfo.getPlatform(),
      keepOutput: true,
    });
  }

  async abortLogCapture(runId: string, keepOutput: boolean = false): Promise<void> {
    if (!this._deviceInfo.id) {
      return;
    }

    await this._logCaptureController.abortLogCapture(runId, {
      deviceId: this._deviceInfo.id,
      platform: this._deviceInfo.getPlatform(),
      keepOutput,
    });
  }

  async logCaptureCleanUp(): Promise<void> {
    if (!this._deviceInfo.id) {
      return;
    }

    await this._logCaptureController.cleanupDevice(this._deviceInfo.id, {
      platform: this._deviceInfo.getPlatform(),
      keepOutput: false,
    });
  }

  uninstallDriver(): void {
    Logger.d(`Uninstall driver for device: ${this._deviceInfo.deviceUUID}`);
  }

  async getScreenshotAndHierarchy(): Promise<{
    screenshot: string | undefined;
    hierarchy: string | undefined;
    screenWidth: number;
    screenHeight: number;
  }> {
    const response: DeviceScreenshotAndHierarchy =
      await this._runtime.getScreenshotAndHierarchy();
    return response;
  }

  async getInstalledApps(): Promise<DeviceAppInfo[]> {
    return await this._runtime.getInstalledApps();
  }
}
