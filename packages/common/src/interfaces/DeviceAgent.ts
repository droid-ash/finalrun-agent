// Port of common/interface/Agent.dart
// Dart: abstract class Agent -> TypeScript: interface DeviceAgent
// Full device interface including action execution, recording, and lifecycle methods

import { DeviceActionRequest } from '../models/DeviceActionRequest.js';
import { DeviceInfo } from '../models/DeviceInfo.js';
import { DeviceNodeResponse } from '../models/DeviceNodeResponse.js';
import type { RecordingRequest } from '../models/RecordingRequest.js';

/**
 * Abstract interface for anything that represents a connected device.
 * Implemented by Device in @finalrun/device-node.
 *
 * Dart equivalent: common/interface/Agent.dart
 */
export interface DeviceAgent {
  // Dart: Future<DeviceNodeResponse> setUp({bool reuseAddress = false})
  setUp(options?: { reuseAddress?: boolean }): Promise<DeviceNodeResponse>;

  // Dart: Future<DeviceNodeResponse> executeAction(DeviceActionRequest request)
  executeAction(request: DeviceActionRequest): Promise<DeviceNodeResponse>;

  // Dart: bool isConnected()
  isConnected(): boolean;

  // Dart: DeviceInfo getDeviceInfo()
  getDeviceInfo(): DeviceInfo;

  // Dart: Future<void> closeConnection()
  closeConnection(): Promise<void>;

  // Dart: void killDriver()
  /**
   * Closes the gRPC channel to the on-device driver. It does **not** kill the
   * driver process — the instrumentation host / XCUITest runner keeps running.
   * The name predates this port and is retained for its callers; read it as
   * "close the driver channel".
   */
  killDriver(): void;

  // Dart: void setApiKey(String apiKey)
  setApiKey(apiKey: string): void;

  // Dart: String getId()
  getId(): string;

  // Dart: void listenForDeviceDisconnection(...)
  listenForDeviceDisconnection(callbacks: {
    onDeviceDisconnected: (deviceUUID: string, reason: string) => void;
  }): void;

  // Dart: void clearListener()
  clearListener(): void;

  // Screen recording methods
  startRecording(recordingRequest: RecordingRequest): Promise<DeviceNodeResponse>;
  stopRecording(runId: string, testId: string): Promise<DeviceNodeResponse>;
  recordingCleanUp(): Promise<void>;
  abortRecording(runId: string, keepOutput?: boolean): Promise<void>;

  // Device log capture methods
  startLogCapture(request: { runId: string; testId: string; appIdentifier?: string }): Promise<DeviceNodeResponse>;
  stopLogCapture(runId: string, testId: string): Promise<DeviceNodeResponse>;
  logCaptureCleanUp(): Promise<void>;
  abortLogCapture(runId: string, keepOutput?: boolean): Promise<void>;

  // Dart: void uninstallDriver()
  uninstallDriver(): void;
}
