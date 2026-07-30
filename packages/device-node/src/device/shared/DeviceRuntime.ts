import type {
  BackAction,
  CheckAppInForegroundAction,
  DeeplinkAction,
  DeviceAppInfo,
  DeviceNodeResponse,
  EraseTextAction,
  EnterTextAction,
  GetHierarchyAction,
  GetScreenshotAction,
  HideKeyboardAction,
  HomeAction,
  KillAppAction,
  LaunchAppAction,
  LongPressAction,
  PressKeyAction,
  RotateAction,
  ScrollAbsAction,
  SetLocationAction,
  SwitchToPrimaryAppAction,
  TapAction,
  TapPercentAction,
} from '@finalrun/common';

export interface DeviceScreenshotAndHierarchy {
  screenshot: string | undefined;
  hierarchy: string | undefined;
  screenWidth: number;
  screenHeight: number;
  deviceTime?: string;
  timezone?: string;
}

export interface DeviceRuntime {
  setShouldEnsureStability(shouldEnsureStability: boolean | undefined): void;
  isConnected(): boolean;
  tap(action: TapAction): Promise<DeviceNodeResponse>;
  tapPercent(action: TapPercentAction): Promise<DeviceNodeResponse>;
  longPress(action: LongPressAction): Promise<DeviceNodeResponse>;
  enterText(action: EnterTextAction): Promise<DeviceNodeResponse>;
  eraseText(action: EraseTextAction): Promise<DeviceNodeResponse>;
  scrollAbs(action: ScrollAbsAction): Promise<DeviceNodeResponse>;
  back(action: BackAction): Promise<DeviceNodeResponse>;
  home(action: HomeAction): Promise<DeviceNodeResponse>;
  rotate(action: RotateAction): Promise<DeviceNodeResponse>;
  hideKeyboard(action: HideKeyboardAction): Promise<DeviceNodeResponse>;
  pressKey(action: PressKeyAction): Promise<DeviceNodeResponse>;
  launchApp(action: LaunchAppAction): Promise<DeviceNodeResponse>;
  killApp(action: KillAppAction): Promise<DeviceNodeResponse>;
  openDeepLink(action: DeeplinkAction): Promise<DeviceNodeResponse>;
  setLocation(action: SetLocationAction): Promise<DeviceNodeResponse>;
  switchToPrimaryApp(action: SwitchToPrimaryAppAction): Promise<DeviceNodeResponse>;
  checkAppInForeground(action: CheckAppInForegroundAction): Promise<DeviceNodeResponse>;
  captureState(traceStep?: number | null): Promise<DeviceNodeResponse>;
  getInstalledAppsResponse(): Promise<DeviceNodeResponse>;
  getInstalledApps(): Promise<DeviceAppInfo[]>;
  getScreenshot(action: GetScreenshotAction): Promise<DeviceNodeResponse>;
  getHierarchy(action: GetHierarchyAction): Promise<DeviceNodeResponse>;
  getScreenshotAndHierarchy(): Promise<DeviceScreenshotAndHierarchy>;
  resolveLogFilterIdentifier?(appIdentifier: string): Promise<string | null>;
  close(): Promise<void>;
  /**
   * Closes the gRPC channel to the on-device driver. It does **not** kill the
   * driver process — the instrumentation host / XCUITest runner keeps running —
   * so both platform implementations delegate to
   * `CommonDriverActions.closeDriverChannel()`. The name predates this port and
   * is retained for its callers; read it as "close the driver channel".
   */
  killDriver(): void;
}
