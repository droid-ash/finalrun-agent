// Barrel export for @finalrun/common

// Interfaces
export type { DeviceAgent } from './interfaces/DeviceAgent.js';
export type { FilePathUtil } from './interfaces/FilePathUtil.js';

// Models
export { DeviceInfo } from './models/DeviceInfo.js';
export type {
  CommandTranscript,
  DeviceInventoryDiagnostic,
  DeviceInventoryDiagnosticScope,
  DeviceInventoryEntry,
  DeviceInventoryPlatform,
  DeviceInventoryReport,
  DeviceInventoryState,
  DeviceInventoryTargetKind,
} from './models/DeviceInventory.js';
export { DeviceActionRequest } from './models/DeviceActionRequest.js';
export { DeviceNodeResponse } from './models/DeviceNodeResponse.js';
export { DeviceAppInfo } from './models/DeviceAppInfo.js';
export { RecordingRequest } from './models/RecordingRequest.js';
export type {
  AppConfig,
  EnvironmentConfig,
  VariableValue,
  RuntimeBindings,
  SecretReference,
} from './models/Environment.js';
export type { TestDefinition, BindingReference } from './models/TestDefinition.js';
export type { SuiteDefinition } from './models/SuiteDefinition.js';
export type {
  AgentActionTrace,
  TraceSpan,
  TimingInfo,
  SpanTiming,
} from './models/Trace.js';
export type { DeviceLogCaptureResult } from './models/DeviceLog.js';
export type {
  PlannerThought,
  ActionPayload,
  AgentActionStatus,
  TestStatus,
  AgentAction,
  TestResult,
  FirstFailure,
} from './models/TestResult.js';
export type {
  RunStatus,
  RunTarget,
  FailurePhase,
  RunSummary,
  EnvironmentRecord,
  RunManifestAppRecord,
  RunManifest,
} from './models/RunManifest.js';
export type {
  ReportServerState,
  RunIndexEntry,
  RunIndex,
} from './models/RunIndex.js';
export { Hierarchy, HierarchyNode } from './models/Hierarchy.js';
export {
  Point,
  PointPercent,
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
  DeeplinkAction,
  SetLocationAction,
  WaitAction,
  GetScreenshotAction,
  GetHierarchyAction,
  GetScreenshotAndHierarchyAction,
  GetAppListAction,
  KillAppAction,
  SwitchToPrimaryAppAction,
  CheckAppInForegroundAction,
} from './models/DeviceAction.js';
export { AppUpload } from './models/AppUpload.js';
export { SingleArgument } from './models/SingleArgument.js';

// Constants
export * from './constants.js';

// Logger
export type { LogEntry, LoggerSink } from './logger.js';
export { Logger, LogLevel } from './logger.js';

// Repo runner helpers
export {
  resolveRuntimePlaceholders,
  containsSecretPlaceholder,
  redactResolvedValue,
} from './repoPlaceholders.js';

// Test runner pipeline (relocated from @finalrun/finalrun-agent)
export {
  runCheck,
  SUITE_SELECTOR_CONFLICT_ERROR,
  type CheckRunnerOptions,
  type CheckRunnerResult,
} from './checkRunner.js';
export { CliEnv } from './env.js';
export {
  resolveAppConfig,
  resolveAppOverrideIdentifier,
  readAppConfig,
  formatResolvedAppSummary,
  type ResolvedAppConfig,
  type ValidatedAppOverrideLike,
} from './appConfig.js';
export {
  loadEnvironmentConfig,
  loadTest,
  loadTestSuite,
  validateTestBindings,
  type LoadedEnvironmentConfig,
} from './testLoader.js';
export {
  TEST_SELECTION_REQUIRED_ERROR,
  normalizeTestSelectors,
  selectTestFiles,
} from './testSelection.js';
export {
  resolveWorkspace,
  resolveWorkspaceForCommand,
  loadWorkspaceConfig,
  resolveConfiguredEnvironmentFile,
  resolveSuiteManifestPath,
  validateAppOverride,
  sanitizeId,
  assertPathWithinRoot,
  isYamlFile,
  createRunId,
  type AppOverrideValidationResult,
  type FinalRunWorkspace,
} from './workspace.js';
export {
  promptForWorkspaceSelection,
  WorkspaceSelectionCancelledError,
  type WorkspaceSelectionIO,
} from './workspacePicker.js';
