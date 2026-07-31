// Port of device_node/lib/device/DevicePool.dart

import { Device } from './Device.js';

/**
 * Simple pool of available Device instances.
 * Dart equivalent: DevicePool in device_node/lib/device/DevicePool.dart
 */
export class DevicePool {
  private _devices: Map<string, Device> = new Map();

  add(device: Device): void {
    this._devices.set(device.getId(), device);
  }

  remove(deviceId: string): void {
    this._devices.delete(deviceId);
  }

  get(deviceId: string): Device | undefined {
    return this._devices.get(deviceId);
  }

  getFirst(): Device | undefined {
    const first = this._devices.values().next();
    return first.done ? undefined : first.value;
  }

  getAll(): Device[] {
    return Array.from(this._devices.values());
  }

  get size(): number {
    return this._devices.size;
  }

  get isEmpty(): boolean {
    return this._devices.size === 0;
  }
}
