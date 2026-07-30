import {
  DeviceAppInfo,
  DeviceNodeResponse,
  EraseTextAction,
  EnterTextAction,
  GetHierarchyAction,
  GetScreenshotAction,
  LaunchAppAction,
  LongPressAction,
  PressKeyAction,
  RotateAction,
  ScrollAbsAction,
  SetLocationAction,
  SingleArgument,
  SwitchToPrimaryAppAction,
  TapAction,
  TapPercentAction,
  CheckAppInForegroundAction,
} from '@finalrun/common';
import { ScreenshotCaptureCoordinator } from '../../capture/ScreenshotCaptureCoordinator.js';
import type { GrpcResponse, GrpcDriverClient } from '../../grpc/GrpcDriverClient.js';
import { DeviceSession } from '../DeviceSession.js';
import type { DeviceScreenshotAndHierarchy } from './DeviceRuntime.js';

export class CommonDriverActions {
  private _grpcClient: GrpcDriverClient;
  private _session: DeviceSession;
  private _captureCoordinator: ScreenshotCaptureCoordinator;

  constructor(params: {
    grpcClient: GrpcDriverClient;
    session?: DeviceSession;
    captureCoordinator?: ScreenshotCaptureCoordinator;
  }) {
    this._grpcClient = params.grpcClient;
    this._session = params.session ?? new DeviceSession();
    this._captureCoordinator =
      params.captureCoordinator ??
      new ScreenshotCaptureCoordinator({
        grpcClient: this._grpcClient,
        session: this._session,
      });
  }

  setShouldEnsureStability(shouldEnsureStability: boolean | undefined): void {
    this._session.setShouldEnsureStability(shouldEnsureStability);
  }

  isConnected(): boolean {
    return this._grpcClient.isConnected;
  }

  async tap(action: TapAction): Promise<DeviceNodeResponse> {
    const response = await this._grpcClient.tap({
      x: action.point.x,
      y: action.point.y,
      repeat: action.repeat,
      delay: action.delay,
    });
    return new DeviceNodeResponse({
      success: response.success,
      message: response.message,
      data: {
        x: (response as { x?: number }).x,
        y: (response as { y?: number }).y,
      },
    });
  }

  async tapPercent(action: TapPercentAction): Promise<DeviceNodeResponse> {
    const response = await this._grpcClient.tapPercent({
      xPercent: action.point.xPercent,
      yPercent: action.point.yPercent,
    });
    return this._toResponse(response);
  }

  async longPress(action: LongPressAction): Promise<DeviceNodeResponse> {
    const response = await this._grpcClient.tap({
      x: action.point.x,
      y: action.point.y,
      delay: 1500,
    });
    return this._toResponse(response);
  }

  async enterText(action: EnterTextAction): Promise<DeviceNodeResponse> {
    const response = await this._grpcClient.enterText({
      value: action.value,
      shouldEraseText: action.shouldEraseText,
      eraseCount: action.eraseCount ?? undefined,
    });
    return this._toResponse(response);
  }

  async eraseText(_action: EraseTextAction): Promise<DeviceNodeResponse> {
    return this._toResponse(await this._grpcClient.eraseText());
  }

  async swipe(action: ScrollAbsAction): Promise<DeviceNodeResponse> {
    const response = await this._grpcClient.swipe({
      startX: action.startX,
      startY: action.startY,
      endX: action.endX,
      endY: action.endY,
      durationMs: action.durationMs,
    });
    return this._toResponse(response);
  }

  async back(): Promise<DeviceNodeResponse> {
    return this._toResponse(await this._grpcClient.back());
  }

  async home(): Promise<DeviceNodeResponse> {
    return this._toResponse(await this._grpcClient.home());
  }

  async rotate(_action: RotateAction): Promise<DeviceNodeResponse> {
    const response = await this._grpcClient.rotate();
    return this._toResponse(response, {
      orientation: response.orientation,
    });
  }

  async hideKeyboard(): Promise<DeviceNodeResponse> {
    return this._toResponse(await this._grpcClient.hideKeyboard());
  }

  async pressKey(action: PressKeyAction): Promise<DeviceNodeResponse> {
    return this._toResponse(await this._grpcClient.pressKey(action.key));
  }

  async launchApp(action: LaunchAppAction): Promise<DeviceNodeResponse> {
    const response = await this._grpcClient.launchApp({
      appUpload: { packageName: action.appUpload.packageName },
      allowAllPermissions: action.allowAllPermissions,
      shouldUninstallBeforeLaunch: action.shouldUninstallBeforeLaunch,
      arguments: Object.fromEntries(
        Object.entries(action.arguments ?? {}).map(([key, value]) => [
          key,
          {
            type: (value as SingleArgument).type,
            value: (value as SingleArgument).value,
          },
        ]),
      ),
      permissions: action.permissions,
    });
    return this._toResponse(response, {
      packageName: action.appUpload.packageName,
    });
  }

  async killApp(packageName: string): Promise<DeviceNodeResponse> {
    return this._toResponse(await this._grpcClient.killApp(packageName));
  }

  async setLocation(action: SetLocationAction): Promise<DeviceNodeResponse> {
    return this._toResponse(
      await this._grpcClient.setLocation(
        parseFloat(action.lat),
        parseFloat(action.long),
      ),
    );
  }

  async switchToPrimaryApp(
    action: SwitchToPrimaryAppAction,
  ): Promise<DeviceNodeResponse> {
    return this._toResponse(
      await this._grpcClient.switchToPrimaryApp(action.packageName),
    );
  }

  async checkAppInForeground(
    action: CheckAppInForegroundAction,
  ): Promise<DeviceNodeResponse> {
    return this._toResponse(
      await this._grpcClient.checkAppInForeground(
        action.packageName,
        action.timeoutSeconds,
      ),
    );
  }

  async captureState(traceStep?: number | null): Promise<DeviceNodeResponse> {
    return await this._captureCoordinator.capture(traceStep);
  }

  async getInstalledAppsFromDriver(): Promise<DeviceAppInfo[]> {
    const response = await this._grpcClient.getAppList();
    return (response.apps ?? []).map(
      (app) =>
        new DeviceAppInfo({
          packageName: app.packageName,
          name: app.name,
          version: app.version ?? null,
        }),
    );
  }

  async getInstalledAppsResponseFromDriver(): Promise<DeviceNodeResponse> {
    const apps = await this.getInstalledAppsFromDriver();
    return new DeviceNodeResponse({
      success: true,
      data: {
        apps: apps.map((app) => app.toJson()),
      },
    });
  }

  async getScreenshotAndHierarchy(): Promise<DeviceScreenshotAndHierarchy> {
    const response = await this._grpcClient.getScreenshotAndHierarchy();
    return {
      screenshot: response.screenshot,
      hierarchy: response.hierarchy,
      screenWidth: response.screenWidth,
      screenHeight: response.screenHeight,
      deviceTime: response.deviceTime,
      timezone: response.timezone,
    };
  }

  async getScreenshot(_action: GetScreenshotAction): Promise<DeviceNodeResponse> {
    const response = await this._grpcClient.getScreenshot();
    return this._toResponse(response, this._toCaptureData(response));
  }

  async getHierarchy(_action: GetHierarchyAction): Promise<DeviceNodeResponse> {
    const response = await this._grpcClient.getHierarchy();
    return this._toResponse(response, this._toCaptureData(response));
  }

  async updateAppIds(appIds: string[]): Promise<GrpcResponse> {
    return await this._grpcClient.updateAppIds(appIds);
  }

  /**
   * Closes this client's gRPC channel. The on-device driver — the Android
   * instrumentation host or the XCUITest runner — keeps running; ending its
   * process is the platform runtime's job (`IOSSimulator.close` terminates the
   * runner bundle via simctl), not this class's.
   */
  close(): void {
    this._grpcClient.close();
  }

  /**
   * Also closes the gRPC channel — identical to {@link close}, and named for
   * what it does rather than what its caller is called.
   *
   * It was `killDriver`, which claimed to terminate the driver process and did
   * not: two identical bodies under two different names invite the next reader
   * either to collapse them or to trust the name. Both readings are wrong. The
   * public `killDriver()` on `DeviceAgent` / `DeviceRuntime` still delegates
   * here, so calling it does not kill a driver either.
   */
  closeDriverChannel(): void {
    this._grpcClient.close();
  }

  private _toResponse(
    response: GrpcResponse,
    data?: Record<string, unknown>,
  ): DeviceNodeResponse {
    return new DeviceNodeResponse({
      success: response.success,
      message: response.message,
      data,
    });
  }

  private _toCaptureData(response: {
    screenshot?: string;
    hierarchy?: string;
    screenWidth: number;
    screenHeight: number;
    deviceTime?: string;
    timezone?: string;
  }): Record<string, unknown> {
    return {
      screenshot: response.screenshot,
      hierarchy: response.hierarchy,
      screenWidth: response.screenWidth,
      screenHeight: response.screenHeight,
      deviceTime: response.deviceTime,
      timezone: response.timezone,
    };
  }
}
