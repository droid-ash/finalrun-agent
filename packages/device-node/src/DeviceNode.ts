// Singleton entry point for device management.

import type {
  FilePathUtil,
  DeviceInfo,
  DeviceInventoryDiagnostic,
  DeviceInventoryEntry,
  DeviceInventoryReport,
} from '@finalrun/common';
import { Logger } from '@finalrun/common';
import { DeviceDiscoveryService } from './discovery/DeviceDiscoveryService.js';
import { DevicePool } from './device/DevicePool.js';
import { Device } from './device/Device.js';
import { GrpcDriverSetup } from './grpc/GrpcDriverSetup.js';
import { AdbClient } from './infra/android/AdbClient.js';
import { SimctlClient } from './infra/ios/SimctlClient.js';

/**
 * Singleton manager for detecting, tracking, and providing access to connected devices.
 */
export class DeviceNode {
  private static _instance: DeviceNode | null = null;

  private _deviceDiscoveryService: DeviceDiscoveryService;
  private _devicePool: DevicePool;
  private _grpcDriverSetup: GrpcDriverSetup | null = null;
  private _initialized: boolean = false;
  private _adbClient: AdbClient;
  private _simctlClient: SimctlClient;
  /**
   * Promise tracking the in-flight startup adb-forward cleanup. setUpDevice()
   * awaits this so removeAllPortForwards() can never wipe a freshly allocated
   * forward. Defaults to a resolved promise so callers that never run init()
   * (e.g., direct AdbClient tests) aren't blocked.
   */
  private _initCleanupPromise: Promise<void> = Promise.resolve();

  private constructor() {
    this._deviceDiscoveryService = new DeviceDiscoveryService();
    this._devicePool = new DevicePool();
    this._adbClient = new AdbClient();
    this._simctlClient = new SimctlClient();
  }

  static getInstance(): DeviceNode {
    if (!DeviceNode._instance) {
      DeviceNode._instance = new DeviceNode();
    }
    return DeviceNode._instance;
  }

  /** Reset the singleton (for testing). */
  static resetInstance(): void {
    DeviceNode._instance = null;
  }

  /**
   * Initialize the device node with a file path utility.
   * Must be called before any other method.
   *
   * Also fires off a best-effort cleanup of any stale adb forwards left
   * behind by a previous device-node process. Without this, after a crash
   * or hard restart the in-memory port pool can drift away from the OS
   * state and cause "port already in use" errors.
   */
  init(filePathUtil: FilePathUtil): void {
    this._grpcDriverSetup = new GrpcDriverSetup({
      adbClient: this._adbClient,
      simctlClient: this._simctlClient,
      filePathUtil,
    });
    this._initialized = true;

    // Capture the cleanup as a promise. setUpDevice() awaits it before
    // running so removeAllPortForwards() (which clears the in-memory pool)
    // can never race with a freshly allocated forward.
    this._initCleanupPromise = this._cleanupStaleAdbForwards(filePathUtil);
  }

  private async _cleanupStaleAdbForwards(filePathUtil: FilePathUtil): Promise<void> {
    try {
      const adbPath = await filePathUtil.getADBPath();
      if (!adbPath) return;
      await this._adbClient.removeAllPortForwards(adbPath);
    } catch {
      // best-effort
    }
  }

  /**
   * Detect all connected devices (Android + iOS).
   */
  async detectInventory(adbPath: string | null): Promise<DeviceInventoryReport> {
    const inventory = await this._deviceDiscoveryService.detectInventory(adbPath);
    Logger.d(`Detected ${inventory.entries.length} target(s)`);
    return inventory;
  }

  async detectDevices(adbPath: string | null): Promise<DeviceInfo[]> {
    const inventory = await this.detectInventory(adbPath);
    return inventory.entries
      .filter((entry) => entry.runnable && entry.deviceInfo !== null)
      .map((entry) => entry.deviceInfo as DeviceInfo);
  }

  async startTarget(
    entry: DeviceInventoryEntry,
    adbPath: string | null,
  ): Promise<DeviceInventoryDiagnostic | null> {
    return await this._deviceDiscoveryService.startTarget(entry, adbPath);
  }

  /**
   * Set up a device for execution: install driver, connect gRPC, add to pool.
   * Returns the fully set up Device instance.
   */
  async setUpDevice(deviceInfo: DeviceInfo): Promise<Device> {
    if (!this._initialized || !this._grpcDriverSetup) {
      throw new Error('DeviceNode not initialized. Call init() first.');
    }

    // Wait for any in-flight startup cleanup before allocating a new
    // forward. removeAllPortForwards() clears the in-memory port pool,
    // which would otherwise wipe a freshly-created entry.
    await this._initCleanupPromise;

    const device = await this._grpcDriverSetup.setUp(deviceInfo);
    this._devicePool.add(device);
    return device;
  }

  /**
   * Get the first available device from the pool.
   */
  getFirstDevice(): Device | undefined {
    return this._devicePool.getFirst();
  }

  /**
   * Get a specific device by ID.
   */
  getDevice(deviceId: string): Device | undefined {
    return this._devicePool.get(deviceId);
  }

  /**
   * Clean up — close all device connections.
   */
  async cleanup(): Promise<void> {
    for (const device of this._devicePool.getAll()) {
      try {
        await device.closeConnection();
      } catch {
        // ignore cleanup errors
      }
    }
  }

  async installAndroidApp(
    adbPath: string,
    deviceId: string,
    appPath: string,
  ): Promise<boolean> {
    return await this._adbClient.installApp(adbPath, deviceId, appPath);
  }

  async installIOSApp(deviceId: string, appPath: string): Promise<boolean> {
    return await this._simctlClient.installApp(deviceId, appPath);
  }
}
