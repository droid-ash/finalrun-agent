// Port of device_node/lib/driver/GrpcDriverClient.dart
// Uses @grpc/grpc-js with dynamic proto loading.
// MATCHES the Dart pattern: createChannel (lazy) → ping (getDeviceScale) → poll

// Patches protobufjs's `util.fs` / `util.Long` so the bundle survives Bun's
// standalone compile path. MUST be the first import — `@grpc/proto-loader`
// calls `Root.fromJSON(...)` at module-init time, so the patch has to land
// before that import is evaluated.
import './protobufBundlerShim.js';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as fs from 'node:fs';
import * as path from 'path';
import { Logger } from '@finalrun/common';

function resolveProtoPath(): string {
  const candidates = [
    process.env['FINALRUN_DRIVER_PROTO_PATH'],
    path.resolve(__dirname, '../../proto/finalrun/driver.proto'),
    path.resolve(__dirname, '../../../../proto/finalrun/driver.proto'),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`FinalRun driver.proto not found. Searched: ${candidates.join(', ')}`);
}

/**
 * gRPC client for communicating with the on-device driver app.
 *
 * Connection pattern (matches Dart):
 *   1. createChannel(host, port) — lazy, no network call
 *   2. ping() — verifies connectivity via getDeviceScale RPC (3s timeout)
 *   3. connect(host, port) — createChannel + single ping verification
 *
 * For startup polling, use createChannel() + loop { ping() } like Dart does.
 *
 * Dart equivalent: GrpcDriverClient in device_node/lib/driver/GrpcDriverClient.dart
 */
export class GrpcDriverClient {
  private _client: grpc.Client | null = null;
  private _connected: boolean = false;

  get isConnected(): boolean {
    return this._connected;
  }

  /**
   * Creates the gRPC channel WITHOUT verifying connectivity.
   * This is a lazy operation — no network call is made until the first RPC.
   * Use ping() to verify the server is reachable.
   *
   * Dart: void createChannel(String host, int port)
   */
  createChannel(host: string, port: number): void {
    Logger.d(`GrpcDriverClient: Creating channel to ${host}:${port}`);

    const packageDefinition = protoLoader.loadSync(resolveProtoPath(), {
      keepCase: false,  // CamelCase → camelCase
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });

    const protoDescriptor = grpc.loadPackageDefinition(packageDefinition);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const driverService = (protoDescriptor as any).finalrun.driver.DriverService;

    this._client = new driverService(
      `${host}:${port}`,
      grpc.credentials.createInsecure(),
      {
        'grpc.keepalive_time_ms': 10000,
        'grpc.keepalive_timeout_ms': 5000,
      },
    );

    Logger.d('GrpcDriverClient: Channel created');
  }

  /**
   * Pings the gRPC server to verify connectivity.
   * Calls getDeviceScale with a 3s timeout (matches Dart).
   * Returns true if the server responds, false otherwise.
   *
   * Dart: Future<bool> ping()
   */
  async ping(): Promise<boolean> {
    if (!this._client) {
      Logger.d('GrpcDriverClient: Cannot ping - no channel');
      return false;
    }

    try {
      const response = await this._unaryCall('getDeviceScale', {}, {
        timeoutMs: 3000,
        errorLogLevel: 'debug',
        maxRetries: 2,
      });
      this._connected = true;
      Logger.d(`GrpcDriverClient: Ping successful, scale=${response?.scale}`);
      return true;
    } catch {
      // Ping failed — expected during startup
      return false;
    }
  }

  /**
   * Connect to the gRPC server: createChannel + verify with ping.
   * For polling-style connection (during driver startup), use
   * createChannel() + loop { ping() } instead.
   *
   * Dart: Future<bool> connect(String host, int port)
   */
  async connect(host: string, port: number): Promise<boolean> {
    try {
      this.createChannel(host, port);

      Logger.d('GrpcDriverClient: Verifying connection with ping...');
      if (!await this.ping()) {
        Logger.e('GrpcDriverClient: Connection verification failed');
        this.close();
        return false;
      }

      Logger.i(`GrpcDriverClient: Successfully connected to ${host}:${port}`);
      return true;
    } catch (e) {
      Logger.e('GrpcDriverClient: Failed to connect:', e);
      this._connected = false;
      return false;
    }
  }

  /**
   * Close the gRPC connection.
   */
  close(): void {
    if (this._client) {
      this._client.close();
      this._client = null;
      this._connected = false;
    }
  }

  // ==========================================================================
  // RPC Methods — each wraps the generated client method with Promise
  // ==========================================================================

  /** Tap at absolute coordinates. */
  async tap(params: { x: number; y: number; repeat?: number; delay?: number }): Promise<GrpcResponse> {
    return this._unaryCall('tap', {
      point: { x: params.x, y: params.y },
      repeat: params.repeat ?? 1,
      delay: params.delay ?? 0,
    });
  }

  /** Tap at percentage coordinates. */
  async tapPercent(params: { xPercent: number; yPercent: number }): Promise<GrpcResponse> {
    return this._unaryCall('tapPercent', {
      point: { xPercent: params.xPercent, yPercent: params.yPercent },
    });
  }

  /** Enter text into the focused input field. */
  async enterText(params: { value: string; shouldEraseText?: boolean; eraseCount?: number }): Promise<GrpcResponse> {
    return this._unaryCall('enterText', {
      value: params.value,
      shouldEraseText: params.shouldEraseText ?? false,
      eraseCount: params.eraseCount,
    });
  }

  /** Erase text from the focused field. */
  async eraseText(): Promise<GrpcResponse> {
    return this._unaryCall('eraseText', {});
  }

  /** Copy text. */
  async copyText(): Promise<GrpcResponse> {
    return this._unaryCall('copyText', {});
  }

  /** Paste text. */
  async pasteText(): Promise<GrpcResponse> {
    return this._unaryCall('pasteText', {});
  }

  /** Press system Back button. */
  async back(): Promise<GrpcResponse> {
    return this._unaryCall('back', {});
  }

  /** Press system Home button. */
  async home(): Promise<GrpcResponse> {
    return this._unaryCall('home', {});
  }

  /** Rotate device. */
  async rotate(): Promise<GrpcRotateResponse> {
    return this._unaryCall('rotate', {}) as Promise<GrpcRotateResponse>;
  }

  /** Hide keyboard. */
  async hideKeyboard(): Promise<GrpcResponse> {
    return this._unaryCall('hideKeyboard', {});
  }

  /** Press a named key. */
  async pressKey(key: string): Promise<GrpcResponse> {
    return this._unaryCall('pressKey', { key });
  }

  /** Swipe from (startX, startY) to (endX, endY). */
  async swipe(params: {
    startX: number; startY: number;
    endX: number; endY: number;
    durationMs: number;
  }): Promise<GrpcResponse> {
    return this._unaryCall('swipe', params);
  }

  /** Launch an app. */
  async launchApp(params: {
    appUpload: { packageName: string };
    allowAllPermissions: boolean;
    arguments?: Record<string, { type: string; value: string }>;
    permissions?: Record<string, string>;
    shouldUninstallBeforeLaunch?: boolean;
  }): Promise<GrpcResponse> {
    return this._unaryCall('launchApp', params, { timeoutMs: 60000, maxRetries: 2 }); // 60s timeout like Dart; retries enable driver recovery on iOS
  }

  /** Kill a running app. */
  async killApp(packageName: string): Promise<GrpcResponse> {
    return this._unaryCall('killApp', { packageName });
  }

  /** Switch to primary app. */
  async switchToPrimaryApp(packageName: string): Promise<GrpcResponse> {
    return this._unaryCall('switchToPrimaryApp', { packageName });
  }

  /** Check if app is in foreground. */
  async checkAppInForeground(packageName: string, timeoutSeconds: number): Promise<GrpcResponse> {
    return this._unaryCall('checkAppInForeground', { packageName, timeoutSeconds }, {
      timeoutMs: (timeoutSeconds + 5) * 1000,
      maxRetries: 2,
    });
  }

  /** Get list of installed apps. */
  async getAppList(): Promise<GrpcAppListResponse> {
    return this._unaryCall('getAppList', {}, { maxRetries: 2 }) as Promise<GrpcAppListResponse>;
  }

  /** Update app IDs. */
  async updateAppIds(appIds: string[]): Promise<GrpcResponse> {
    return this._unaryCall('updateAppIds', { appIds }, { maxRetries: 2 });
  }

  /** Get device scale factor. */
  async getDeviceScale(): Promise<GrpcDeviceScaleResponse> {
    return this._unaryCall('getDeviceScale', {}, { maxRetries: 2 }) as Promise<GrpcDeviceScaleResponse>;
  }

  /** Get screen dimensions. */
  async getScreenDimension(): Promise<GrpcScreenDimensionResponse> {
    return this._unaryCall('getScreenDimension', {}, { maxRetries: 2 }) as Promise<GrpcScreenDimensionResponse>;
  }

  /** Set device GPS location. */
  async setLocation(latitude: number, longitude: number): Promise<GrpcResponse> {
    return this._unaryCall('setLocation', { latitude, longitude });
  }

  /** Get a screenshot (base64 encoded). */
  async getScreenshot(
    quality?: number,
    options?: UnaryCallOptions,
  ): Promise<GrpcScreenshotResponse> {
    return this._unaryCall('getScreenshot', { quality: quality ?? 5 }, {
      ...options,
      maxRetries: 0,  // ScreenshotCapture has its own retry
    }) as Promise<GrpcScreenshotResponse>;
  }

  /** Get the UI hierarchy. */
  async getHierarchy(options?: UnaryCallOptions): Promise<GrpcScreenshotResponse> {
    return this._unaryCall('getHierarchy', {}, {
      ...options,
      maxRetries: 0,  // ScreenshotCapture has its own retry
    }) as Promise<GrpcScreenshotResponse>;
  }

  /** Get screenshot AND hierarchy in one call (most commonly used). */
  async getScreenshotAndHierarchy(
    quality?: number,
    options?: UnaryCallOptions,
  ): Promise<GrpcScreenshotResponse> {
    return this._unaryCall('getScreenshotAndHierarchy', {
      quality: quality ?? 5,
    }, {
      timeoutMs: options?.timeoutMs ?? 60000,
      errorLogLevel: options?.errorLogLevel,
      maxRetries: 0,  // ScreenshotCapture has its own retry
    }) as Promise<GrpcScreenshotResponse>; // 60s timeout like Dart
  }

  /** Get raw screenshot bytes (for stability comparison). */
  async getRawScreenshot(
    quality?: number,
    options?: UnaryCallOptions,
  ): Promise<GrpcRawScreenshotResponse> {
    return this._unaryCall('getRawScreenshot', {
      quality: quality ?? 5,
    }, {
      ...options,
      maxRetries: 0,  // ScreenshotCapture has its own retry
    }) as Promise<GrpcRawScreenshotResponse>;
  }

  /** Stop execution on device. */
  async stopExecution(): Promise<GrpcResponse> {
    return this._unaryCall('stopExecution', {});
  }

  // ==========================================================================
  // Private helper
  // ==========================================================================

  /**
   * Make a unary gRPC call with optional retry.
   * Retries up to `maxRetries` times on any error, with linear backoff.
   * Default is 0 (no retry) to prevent duplicating mutating actions.
   * Read-only RPCs opt in with `maxRetries: 2`.
   *
   * The same rule holds one layer up: `IOSSimulator._withDriverRecovery`
   * re-executes an operation after restarting a dead driver only for the
   * entries of `REPLAYABLE_AFTER_DRIVER_RESTART` — the read-only captures plus
   * the idempotent `updateAppIds`, which touches driver state only and never
   * the device — so neither layer can turn one requested mutation into two.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async _unaryCall(
    method: string,
    request: Record<string, any>,
    options?: UnaryCallOptions,
  ): Promise<any> {
    const maxRetries = options?.maxRetries ?? 0;
    const retryDelayMs = options?.retryDelayMs ?? 500;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this._singleCall(method, request, options);
      } catch (error) {
        lastError = error as Error;
        if (attempt === maxRetries) throw error;
        Logger.d(
          `gRPC ${method}: error on attempt ${attempt + 1}/${maxRetries + 1}, retrying in ${retryDelayMs * (attempt + 1)}ms...`,
        );
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt + 1)));
      }
    }
    throw lastError!;
  }

  /**
   * Single unary gRPC call converting callback style → Promise.
   * @param timeoutMs — RPC timeout in milliseconds (default 30s, matches Dart _callOptions)
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _singleCall(
    method: string,
    request: Record<string, any>,
    options?: UnaryCallOptions,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this._client) {
        reject(new Error('gRPC client not connected'));
        return;
      }

      const timeoutMs = options?.timeoutMs ?? 30000;
      const deadline = new Date(Date.now() + timeoutMs);
      const metadata = new grpc.Metadata();

      // Dynamic method call on the gRPC client
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this._client as any)[method](request, metadata, { deadline }, (err: grpc.ServiceError | null, response: unknown) => {
        if (err) {
          switch (options?.errorLogLevel ?? 'error') {
            case 'silent':
              break;
            case 'debug':
              Logger.d(`gRPC ${method} failed: ${err.message}`);
              break;
            default:
              Logger.e(`gRPC ${method} failed:`, err);
              break;
          }
          reject(err);
        } else {
          resolve(response);
        }
      });
    });
  }
}

// ==========================================================================
// Response types — matching the protobuf response messages
// ==========================================================================

export interface GrpcResponse {
  success: boolean;
  message?: string;
}

export interface GrpcScreenshotResponse extends GrpcResponse {
  screenshot?: string;   // Base64 encoded
  screenWidth: number;
  screenHeight: number;
  hierarchy?: string;    // JSON string
  deviceTime?: string;
  timezone?: string;
}

export interface GrpcRawScreenshotResponse extends GrpcResponse {
  screenshot?: Buffer;   // Raw JPEG bytes
  screenWidth: number;
  screenHeight: number;
}

export interface GrpcRotateResponse extends GrpcResponse {
  orientation: string;
}

export interface GrpcAppListResponse extends GrpcResponse {
  apps: Array<{ packageName: string; name: string; version?: string }>;
}

export interface GrpcDeviceScaleResponse extends GrpcResponse {
  scale: number;
}

export interface GrpcScreenDimensionResponse extends GrpcResponse {
  screenWidth: number;
  screenHeight: number;
}

export interface UnaryCallOptions {
  timeoutMs?: number;
  errorLogLevel?: 'error' | 'debug' | 'silent';
  /** Max retries on error (default 0 — no retry for mutating RPCs). Read-only RPCs opt in explicitly. */
  maxRetries?: number;
  /** Base delay between retries in ms (default 500). Scales linearly: delay * (attempt + 1). */
  retryDelayMs?: number;
}
