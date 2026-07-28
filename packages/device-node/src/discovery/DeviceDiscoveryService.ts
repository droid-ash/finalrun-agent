import { execFile, spawn, type ChildProcess } from 'child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import {
  DeviceInfo,
  type CommandTranscript,
  type DeviceInventoryDiagnostic,
  type DeviceInventoryDiagnosticScope,
  type DeviceInventoryEntry,
  type DeviceInventoryReport,
  type DeviceInventoryState,
} from '@finalrun/common';
import { MAX_DIAGNOSTIC_OUTPUT_CHUNKS } from '../diagnosticBuffer.js';

const execFileAsync = promisify(execFile);

type ExecFileFn = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

type ReadFileFn = (
  filePath: string,
  encoding: BufferEncoding,
) => Promise<string>;

type DelayFn = (ms: number) => Promise<void>;

interface ProbeResult {
  entries: DeviceInventoryEntry[];
  diagnostics: DeviceInventoryDiagnostic[];
}

interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  transcript: CommandTranscript;
}

interface AndroidConnectedDetails {
  modelName: string | null;
  sdkVersion: number;
  releaseVersion: string | null;
  emulator: boolean;
  avdName: string | null;
  transcripts: CommandTranscript[];
}

interface AvdMetadata {
  name: string;
  configDir: string | null;
  modelName: string | null;
  osVersionLabel: string | null;
}

interface AvdManagerRecord {
  name: string;
  path: string | null;
}

/** Per-call spawn context for a detached emulator launch. */
interface EmulatorSpawnCapture {
  child: ChildProcess;
  stdoutChunks: string[];
  stderrChunks: string[];
  spawnError: Error | null;
}

export class DeviceDiscoveryService {
  static readonly STARTUP_TIMEOUT_MS = 120_000;
  static readonly POLL_INTERVAL_MS = 1_500;
  static readonly ANDROID_LAUNCH_SETTLE_MS = 1_000;

  private readonly _execFileFn: ExecFileFn;
  private readonly _spawnFn: typeof spawn;
  private readonly _delayFn: DelayFn;
  private readonly _readFileFn: ReadFileFn;
  private readonly _fileExistsFn: (filePath: string) => boolean;
  private readonly _env: NodeJS.ProcessEnv;
  private readonly _homeDir: string;

  constructor(params?: {
    execFileFn?: ExecFileFn;
    spawnFn?: typeof spawn;
    delayFn?: DelayFn;
    readFileFn?: ReadFileFn;
    fileExistsFn?: (filePath: string) => boolean;
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
  }) {
    const resolved = params ?? {};
    this._execFileFn = resolved.execFileFn ?? execFileAsync;
    this._spawnFn = resolved.spawnFn ?? spawn;
    this._delayFn =
      resolved.delayFn ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this._readFileFn = resolved.readFileFn ?? ((filePath, encoding) => fsp.readFile(filePath, encoding));
    this._fileExistsFn = resolved.fileExistsFn ?? fs.existsSync;
    this._env = resolved.env ?? process.env;
    this._homeDir = resolved.homeDir ?? homedir();
  }

  async getAndroidDevices(adbPath: string): Promise<DeviceInfo[]> {
    const result = await this._probeAndroidConnected(adbPath);
    return result.entries
      .filter((entry) => entry.runnable && entry.deviceInfo !== null)
      .map((entry) => entry.deviceInfo as DeviceInfo);
  }

  async getIOSDevices(): Promise<DeviceInfo[]> {
    const result = await this._probeIOSSimulators();
    return result.entries
      .filter((entry) => entry.runnable && entry.deviceInfo !== null)
      .map((entry) => entry.deviceInfo as DeviceInfo);
  }

  async detectInventory(adbPath: string | null): Promise<DeviceInventoryReport> {
    const [androidConnected, iosSimulators] = await Promise.all([
      this._probeAndroidConnected(adbPath),
      this._probeIOSSimulators(),
    ]);
    const runningEmulatorSelectionIds = new Set(
      androidConnected.entries
        .filter((entry) => entry.targetKind === 'android-emulator' && entry.runnable)
        .map((entry) => entry.selectionId),
    );
    const androidTargets = await this._probeAndroidTargets(adbPath, runningEmulatorSelectionIds);

    return {
      entries: [
        ...androidConnected.entries,
        ...androidTargets.entries,
        ...iosSimulators.entries,
      ],
      diagnostics: [
        ...androidConnected.diagnostics,
        ...androidTargets.diagnostics,
        ...iosSimulators.diagnostics,
      ],
    };
  }

  async startTarget(
    entry: DeviceInventoryEntry,
    adbPath: string | null,
  ): Promise<DeviceInventoryDiagnostic | null> {
    if (!entry.startable) {
      return null;
    }

    if (entry.targetKind === 'ios-simulator') {
      return await this._startIOSSimulator(entry, adbPath);
    }

    if (entry.targetKind === 'android-emulator') {
      return await this._startAndroidEmulator(entry, adbPath);
    }

    return this._startupFailure(
      `Automatic startup is not supported for ${entry.displayName}.`,
      [],
    );
  }

  /** A blocking startup diagnostic — the shared failure shape for startTarget paths. */
  private _startupFailure(
    summary: string,
    transcripts: CommandTranscript[],
  ): DeviceInventoryDiagnostic {
    return { scope: 'startup', summary, blocking: true, transcripts };
  }

  private async _probeAndroidConnected(adbPath: string | null): Promise<ProbeResult> {
    if (!adbPath) {
      return this._probeFailure(
        'android-connected',
        'Android discovery is unavailable because adb was not found.',
        true,
        [],
      );
    }

    const listResult = await this._runCommand(adbPath, ['devices', '-l']);
    if (!listResult.ok) {
      return this._probeFailure(
        'android-connected',
        'Android device discovery failed.',
        true,
        [listResult.transcript],
      );
    }

    const entries: DeviceInventoryEntry[] = [];
    const lines = listResult.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('List of devices attached'));

    for (const line of lines) {
      const parsedLine = this._parseAdbDeviceLine(line);
      if (!parsedLine) {
        continue;
      }
      const { serial, state } = parsedLine;

      const inlineModel = this._parseInlineAdbField(line, 'model');
      if (state === 'offline' || state === 'unauthorized') {
        entries.push(
          this._deadAndroidEntry({
            serial,
            state,
            stateDetail: null,
            modelName: inlineModel,
          }),
        );
        continue;
      }

      if (state !== 'device') {
        entries.push(
          this._deadAndroidEntry({
            serial,
            state: 'unavailable',
            stateDetail: state,
            modelName: inlineModel,
          }),
        );
        continue;
      }

      entries.push(await this._connectedAndroidEntry(adbPath, serial, inlineModel));
    }

    return { entries, diagnostics: [] };
  }

  /** A `ProbeResult` carrying no entries and a single diagnostic — the shared probe-failure shape. */
  private _probeFailure(
    scope: DeviceInventoryDiagnosticScope,
    summary: string,
    blocking: boolean,
    transcripts: CommandTranscript[],
  ): ProbeResult {
    return {
      entries: [],
      diagnostics: [{ scope, summary, blocking, transcripts }],
    };
  }

  /** A non-runnable, non-startable Android entry (offline / unauthorized / unknown adb state). */
  private _deadAndroidEntry(params: {
    serial: string;
    state: DeviceInventoryState;
    stateDetail: string | null;
    modelName: string | null;
  }): DeviceInventoryEntry {
    const emulator = params.serial.startsWith('emulator-');
    return {
      selectionId: emulator
        ? `android-emulator:${params.serial}`
        : `android-device:${params.serial}`,
      platform: 'android',
      targetKind: emulator ? 'android-emulator' : 'android-device',
      state: params.state,
      stateDetail: params.stateDetail,
      runnable: false,
      startable: false,
      displayName: this._formatAndroidDisplayName({
        modelName: params.modelName,
        osVersionLabel: null,
        id: params.serial,
      }),
      rawId: params.serial,
      modelName: params.modelName,
      osVersionLabel: null,
      deviceInfo: null,
      transcripts: [],
    };
  }

  /** A runnable Android entry for a `device`-state serial, loading its details over adb. */
  private async _connectedAndroidEntry(
    adbPath: string,
    serial: string,
    inlineModel: string | null,
  ): Promise<DeviceInventoryEntry> {
    const details = await this._loadAndroidConnectedDetails(adbPath, serial, inlineModel);
    const primaryName = details.avdName ?? details.modelName ?? inlineModel;
    const osVersionLabel = this._formatAndroidOsLabel({
      releaseVersion: details.releaseVersion,
      sdkVersion: details.sdkVersion,
    });
    const selectionId = details.avdName
      ? `android-avd:${details.avdName}`
      : details.emulator
        ? `android-emulator:${serial}`
        : `android-device:${serial}`;

    return {
      selectionId,
      platform: 'android',
      targetKind: details.emulator ? 'android-emulator' : 'android-device',
      state: 'connected',
      stateDetail: null,
      runnable: true,
      startable: false,
      displayName: this._formatAndroidDisplayName({
        modelName: primaryName,
        osVersionLabel,
        id: serial,
      }),
      rawId: serial,
      modelName: primaryName ?? null,
      osVersionLabel,
      deviceInfo: new DeviceInfo({
        id: serial,
        deviceUUID: serial,
        isAndroid: true,
        sdkVersion: details.sdkVersion,
        name: primaryName ?? inlineModel,
      }),
      transcripts: details.transcripts,
    };
  }

  private async _probeAndroidTargets(
    adbPath: string | null,
    runningEmulatorSelectionIds: Set<string>,
  ): Promise<ProbeResult> {
    if (!adbPath) {
      return { entries: [], diagnostics: [] };
    }

    const emulatorPath = await this._resolveAndroidToolPath('emulator', [
      ['emulator', 'emulator'],
    ]);
    if (!emulatorPath) {
      return this._probeFailure(
        'android-targets',
        'Android emulator inventory is unavailable because the emulator binary was not found.',
        false,
        [],
      );
    }

    const listResult = await this._runCommand(emulatorPath, ['-list-avds']);
    if (!listResult.ok) {
      return this._probeFailure(
        'android-targets',
        'Android emulator inventory failed.',
        false,
        [listResult.transcript],
      );
    }

    const avdNames = listResult.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (avdNames.length === 0) {
      return { entries: [], diagnostics: [] };
    }

    const diagnostics: DeviceInventoryDiagnostic[] = [];
    const avdRecords = await this._loadAvdManagerRecords(diagnostics);
    const avdMetadata = await Promise.all(
      avdNames.map((name) => this._loadAvdMetadata(name, avdRecords)),
    );

    const entries: DeviceInventoryEntry[] = avdMetadata
      .filter((metadata) => !runningEmulatorSelectionIds.has(`android-avd:${metadata.name}`))
      .map((metadata) => this._avdEntry(metadata));

    return { entries, diagnostics };
  }

  /** A startable (shutdown) Android emulator entry for a non-running AVD. */
  private _avdEntry(metadata: AvdMetadata): DeviceInventoryEntry {
    const displayName = this._formatAndroidDisplayName({
      modelName: metadata.modelName ?? metadata.name,
      osVersionLabel: metadata.osVersionLabel,
      id: metadata.name,
    });

    return {
      selectionId: `android-avd:${metadata.name}`,
      platform: 'android',
      targetKind: 'android-emulator',
      state: 'shutdown' as const,
      stateDetail: null,
      runnable: false,
      startable: true,
      displayName,
      rawId: metadata.name,
      modelName: metadata.modelName,
      osVersionLabel: metadata.osVersionLabel,
      deviceInfo: null,
      transcripts: [],
    };
  }

  private async _probeIOSSimulators(): Promise<ProbeResult> {
    const listResult = await this._runCommand('xcrun', ['simctl', 'list', '-j']);
    if (!listResult.ok) {
      return this._probeFailure(
        'ios-simulators',
        'iOS simulator discovery failed.',
        true,
        [listResult.transcript],
      );
    }

    let parsed: { devices?: Record<string, Array<Record<string, unknown>>> };
    try {
      parsed = JSON.parse(listResult.stdout) as {
        devices?: Record<string, Array<Record<string, unknown>>>;
      };
    } catch {
      return this._probeFailure(
        'ios-simulators',
        'iOS simulator discovery returned invalid JSON.',
        true,
        [listResult.transcript],
      );
    }

    const entries: DeviceInventoryEntry[] = [];
    for (const [runtime, runtimeDevices] of Object.entries(parsed.devices ?? {})) {
      const runtimeLabel = this._parseIOSRuntimeLabel(runtime);
      if (!runtimeLabel || !runtime.includes('SimRuntime.iOS-')) {
        continue;
      }

      for (const device of runtimeDevices) {
        const entry = this._iosEntryFromDevice(device, runtimeLabel);
        if (entry) {
          entries.push(entry);
        }
      }
    }

    return { entries, diagnostics: [] };
  }

  /** Classify one simctl device record into an inventory entry; null when udid/name are missing. */
  private _iosEntryFromDevice(
    device: Record<string, unknown>,
    runtimeLabel: { label: string; sdkVersion: number },
  ): DeviceInventoryEntry | null {
    const udid = this._trimmedField(device, 'udid');
    const name = this._trimmedField(device, 'name');
    const state = this._trimmedField(device, 'state');
    if (!udid || !name) {
      return null;
    }

    const base = { udid, name, runtimeLabel: runtimeLabel.label };
    const availabilityError = this._trimmedField(device, 'availabilityError');
    if (device['isAvailable'] === false) {
      return this._makeIOSEntry(base, {
        state: 'unavailable',
        stateDetail: availabilityError ?? 'simulator unavailable',
      });
    }

    if (state === 'Booted') {
      return this._makeIOSEntry(base, {
        state: 'booted',
        runnable: true,
        deviceInfo: new DeviceInfo({
          id: udid,
          deviceUUID: udid,
          isAndroid: false,
          sdkVersion: runtimeLabel.sdkVersion,
          name,
        }),
      });
    }

    if (state === 'Shutdown') {
      return this._makeIOSEntry(base, { state: 'shutdown', startable: true });
    }

    return this._makeIOSEntry(base, {
      state: 'unavailable',
      stateDetail: state ?? 'unknown state',
    });
  }

  /** Build an iOS simulator entry from the shared base plus per-state overrides. */
  private _makeIOSEntry(
    base: { udid: string; name: string; runtimeLabel: string },
    overrides: {
      state: DeviceInventoryState;
      stateDetail?: string | null;
      runnable?: boolean;
      startable?: boolean;
      deviceInfo?: DeviceInfo | null;
    },
  ): DeviceInventoryEntry {
    return {
      selectionId: `ios-simulator:${base.udid}`,
      platform: 'ios',
      targetKind: 'ios-simulator',
      state: overrides.state,
      stateDetail: overrides.stateDetail ?? null,
      runnable: overrides.runnable ?? false,
      startable: overrides.startable ?? false,
      displayName: this._formatIOSDisplayName(base.name, base.runtimeLabel, base.udid),
      rawId: base.udid,
      modelName: base.name,
      osVersionLabel: base.runtimeLabel,
      deviceInfo: overrides.deviceInfo ?? null,
      transcripts: [],
    };
  }

  /** A non-empty trimmed string field from a simctl device record, else null. */
  private _trimmedField(
    device: Record<string, unknown>,
    field: string,
  ): string | null {
    const value = device[field];
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  }

  private async _startIOSSimulator(
    entry: DeviceInventoryEntry,
    adbPath: string | null,
  ): Promise<DeviceInventoryDiagnostic | null> {
    const bootResult = await this._runCommand('xcrun', ['simctl', 'boot', entry.rawId]);
    if (!bootResult.ok) {
      return this._startupFailure(`Device startup failed for ${entry.displayName}.`, [
        bootResult.transcript,
      ]);
    }

    const started = await this._waitForStartableEntry(entry.selectionId, adbPath, 'ios');
    if (!started.ok) {
      return this._startupFailure(`Device startup timed out for ${entry.displayName}.`, [
        bootResult.transcript,
        ...started.transcripts,
      ]);
    }

    return null;
  }

  private async _startAndroidEmulator(
    entry: DeviceInventoryEntry,
    adbPath: string | null,
  ): Promise<DeviceInventoryDiagnostic | null> {
    if (!adbPath) {
      return this._startupFailure(`Device startup failed for ${entry.displayName}.`, []);
    }

    const emulatorPath = await this._resolveAndroidToolPath('emulator', [
      ['emulator', 'emulator'],
    ]);
    if (!emulatorPath) {
      return this._startupFailure(
        'Device startup failed because the Android emulator binary was not found.',
        [],
      );
    }

    const args = ['-avd', entry.rawId, '-netdelay', 'none', '-netspeed', 'full'];
    const command = this._formatCommand(emulatorPath, args);
    const capture = this._spawnEmulatorWithCapture(emulatorPath, args);

    await this._delayFn(DeviceDiscoveryService.ANDROID_LAUNCH_SETTLE_MS);

    if (capture.spawnError || capture.child.exitCode !== null) {
      return this._startupFailure(`Device startup failed for ${entry.displayName}.`, [
        this._emulatorTranscript(command, capture),
      ]);
    }

    const started = await this._waitForStartableEntry(entry.selectionId, adbPath, 'android');
    if (started.ok) {
      capture.child.stdout?.destroy();
      capture.child.stderr?.destroy();
      capture.child.unref();
      return null;
    }

    return this._startupFailure(`Device startup timed out for ${entry.displayName}.`, [
      this._emulatorTranscript(command, capture),
      ...started.transcripts,
    ]);
  }

  /**
   * Spawn the emulator detached, accumulating output and any spawn error on a
   * per-call capture context. The chunk buffers are a bounded ring (most
   * recent chunks kept, oldest dropped): the child is long-lived, and the
   * chunks are consumed only by `_emulatorTranscript` for a startup
   * diagnostic, so unbounded pushes would grow for the emulator's lifetime.
   */
  private _spawnEmulatorWithCapture(
    emulatorPath: string,
    args: string[],
  ): EmulatorSpawnCapture {
    const capture: EmulatorSpawnCapture = {
      child: this._spawnFn(emulatorPath, args, {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }) as ChildProcess,
      stdoutChunks: [],
      stderrChunks: [],
      spawnError: null,
    };

    capture.child.stdout?.on('data', (chunk: Buffer | string) => {
      capture.stdoutChunks.push(String(chunk));
      if (capture.stdoutChunks.length > MAX_DIAGNOSTIC_OUTPUT_CHUNKS) {
        capture.stdoutChunks.shift();
      }
    });
    capture.child.stderr?.on('data', (chunk: Buffer | string) => {
      capture.stderrChunks.push(String(chunk));
      if (capture.stderrChunks.length > MAX_DIAGNOSTIC_OUTPUT_CHUNKS) {
        capture.stderrChunks.shift();
      }
    });
    capture.child.once('error', (error) => {
      capture.spawnError = error;
      // Capped like the two stream handlers above: this is the buffer's third
      // push site, and a ring that one writer ignores is not a ring. The
      // listener is `once`, so the overflow was bounded at a single entry
      // rather than unbounded — a consistency fix, not a leak fix.
      capture.stderrChunks.push(error.message);
      if (capture.stderrChunks.length > MAX_DIAGNOSTIC_OUTPUT_CHUNKS) {
        capture.stderrChunks.shift();
      }
    });

    return capture;
  }

  private _emulatorTranscript(
    command: string,
    capture: EmulatorSpawnCapture,
  ): CommandTranscript {
    return {
      command,
      stdout: capture.stdoutChunks.join(''),
      stderr: capture.stderrChunks.join(''),
      exitCode: capture.child.exitCode ?? null,
    };
  }

  private async _waitForStartableEntry(
    selectionId: string,
    adbPath: string | null,
    platform: 'android' | 'ios',
  ): Promise<{ ok: boolean; transcripts: CommandTranscript[] }> {
    const deadline = Date.now() + DeviceDiscoveryService.STARTUP_TIMEOUT_MS;
    let lastTranscript: CommandTranscript | null = null;

    while (Date.now() < deadline) {
      const poll =
        platform === 'android'
          ? await this._pollAndroidStarted(selectionId, adbPath)
          : await this._pollIOSStarted(selectionId);
      if (poll.ok) {
        return { ok: true, transcripts: [] };
      }
      lastTranscript = poll.transcript ?? lastTranscript;

      await this._delayFn(DeviceDiscoveryService.POLL_INTERVAL_MS);
    }

    return {
      ok: false,
      transcripts: lastTranscript ? [lastTranscript] : [],
    };
  }

  /** One Android readiness poll: probe connected devices and check sys.boot_completed. */
  private async _pollAndroidStarted(
    selectionId: string,
    adbPath: string | null,
  ): Promise<{ ok: boolean; transcript: CommandTranscript | null }> {
    const probe = await this._probeAndroidConnected(adbPath);
    const match = probe.entries.find(
      (entry) => entry.selectionId === selectionId && entry.runnable,
    );
    if (match?.deviceInfo?.id && adbPath) {
      const bootResult = await this._runCommand(adbPath, [
        '-s',
        match.deviceInfo.id,
        'shell',
        'getprop',
        'sys.boot_completed',
      ]);
      return {
        ok: bootResult.ok && bootResult.stdout.trim() === '1',
        transcript: bootResult.transcript,
      };
    }
    if (probe.diagnostics.length > 0) {
      return { ok: false, transcript: probe.diagnostics[0]?.transcripts[0] ?? null };
    }
    return { ok: false, transcript: null };
  }

  /** One iOS readiness poll: the simulator entry reports runnable. */
  private async _pollIOSStarted(
    selectionId: string,
  ): Promise<{ ok: boolean; transcript: CommandTranscript | null }> {
    const probe = await this._probeIOSSimulators();
    const match = probe.entries.find(
      (entry) => entry.selectionId === selectionId && entry.runnable,
    );
    if (match) {
      return { ok: true, transcript: null };
    }
    if (probe.diagnostics.length > 0) {
      return { ok: false, transcript: probe.diagnostics[0]?.transcripts[0] ?? null };
    }
    return { ok: false, transcript: null };
  }

  private async _loadAndroidConnectedDetails(
    adbPath: string,
    serial: string,
    fallbackModelName: string | null,
  ): Promise<AndroidConnectedDetails> {
    const transcripts: CommandTranscript[] = [];
    const sdkResult = await this._runAndroidProperty(adbPath, serial, 'ro.build.version.sdk');
    if (sdkResult.transcript) {
      transcripts.push(sdkResult.transcript);
    }
    const releaseResult = await this._runAndroidProperty(adbPath, serial, 'ro.build.version.release');
    if (releaseResult.transcript) {
      transcripts.push(releaseResult.transcript);
    }
    const modelResult = await this._runAndroidProperty(adbPath, serial, 'ro.product.model');
    if (modelResult.transcript) {
      transcripts.push(modelResult.transcript);
    }
    const qemuResult = await this._runAndroidProperty(adbPath, serial, 'ro.kernel.qemu');
    if (qemuResult.transcript) {
      transcripts.push(qemuResult.transcript);
    }

    const emulator =
      qemuResult.value === '1' ||
      serial.startsWith('emulator-');
    let avdName: string | null = null;
    if (emulator) {
      const avdNameResult = await this._runCommand(adbPath, ['-s', serial, 'emu', 'avd', 'name']);
      transcripts.push(avdNameResult.transcript);
      if (avdNameResult.ok) {
        avdName = this._parseAvdNameOutput(avdNameResult.stdout);
      }
    }

    return {
      modelName: modelResult.value ?? fallbackModelName,
      sdkVersion: parseInt(sdkResult.value ?? '', 10) || 0,
      releaseVersion: releaseResult.value,
      emulator,
      avdName,
      transcripts,
    };
  }

  private async _loadAvdManagerRecords(
    diagnostics: DeviceInventoryDiagnostic[],
  ): Promise<Map<string, AvdManagerRecord>> {
    const avdManagerPath = await this._resolveAndroidToolPath('avdmanager', [
      ['cmdline-tools', 'latest', 'bin', 'avdmanager'],
      ['cmdline-tools', 'bin', 'avdmanager'],
      ['tools', 'bin', 'avdmanager'],
    ]);
    if (!avdManagerPath) {
      return new Map();
    }

    const result = await this._runCommand(avdManagerPath, ['list', 'avd']);
    if (!result.ok) {
      diagnostics.push({
        scope: 'android-targets',
        summary: 'Android AVD metadata lookup failed.',
        blocking: false,
        transcripts: [result.transcript],
      });
      return new Map();
    }

    return this._parseAvdManagerList(result.stdout);
  }

  private async _loadAvdMetadata(
    name: string,
    avdRecords: Map<string, AvdManagerRecord>,
  ): Promise<AvdMetadata> {
    const configuredPath = avdRecords.get(name)?.path;
    const configDir = configuredPath ?? path.join(this._getAvdHome(), `${name}.avd`);
    const configPath = path.join(configDir, 'config.ini');
    if (!this._fileExistsFn(configPath)) {
      return {
        name,
        configDir: this._fileExistsFn(configDir) ? configDir : null,
        modelName: null,
        osVersionLabel: null,
      };
    }

    let rawConfig = '';
    try {
      rawConfig = await this._readFileFn(configPath, 'utf-8');
    } catch {
      return {
        name,
        configDir,
        modelName: null,
        osVersionLabel: null,
      };
    }

    const values = this._parseIni(rawConfig);
    const modelName =
      this._normalizeLabel(values['avd.ini.displayname']) ??
      this._normalizeLabel(values['hw.device.name']);
    const imageSysDir =
      values['image.sysdir.1'] ??
      values['image.sysdir.2'] ??
      values['target'];
    const apiMatch = imageSysDir?.match(/android-(\d+)/i);
    const osVersionLabel = apiMatch ? `Android API ${apiMatch[1]}` : null;

    return {
      name,
      configDir,
      modelName,
      osVersionLabel,
    };
  }

  private async _runAndroidProperty(
    adbPath: string,
    serial: string,
    property: string,
  ): Promise<{ value: string | null; transcript: CommandTranscript | null }> {
    const result = await this._runCommand(adbPath, ['-s', serial, 'shell', 'getprop', property]);
    return {
      value: result.ok ? result.stdout.trim() || null : null,
      transcript: result.transcript,
    };
  }

  private async _runCommand(
    file: string,
    args: readonly string[],
  ): Promise<CommandResult> {
    try {
      const { stdout, stderr } = await this._execFileFn(file, args);
      return {
        ok: true,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        transcript: {
          command: this._formatCommand(file, args),
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          exitCode: 0,
        },
      };
    } catch (error) {
      const stdout =
        typeof (error as { stdout?: string | Buffer }).stdout === 'string' ||
        Buffer.isBuffer((error as { stdout?: string | Buffer }).stdout)
          ? (error as { stdout?: string | Buffer }).stdout!.toString()
          : '';
      const stderr =
        typeof (error as { stderr?: string | Buffer }).stderr === 'string' ||
        Buffer.isBuffer((error as { stderr?: string | Buffer }).stderr)
          ? (error as { stderr?: string | Buffer }).stderr!.toString()
          : '';
      const exitCode = typeof (error as { code?: number }).code === 'number'
        ? (error as { code?: number }).code ?? null
        : null;

      return {
        ok: false,
        stdout,
        stderr,
        transcript: {
          command: this._formatCommand(file, args),
          stdout,
          stderr,
          exitCode,
        },
      };
    }
  }

  private async _resolveAndroidToolPath(
    commandName: string,
    sdkRelativePaths: string[][],
  ): Promise<string | null> {
    const sdkRoot = this._env['ANDROID_HOME'] ?? this._env['ANDROID_SDK_ROOT'];
    if (sdkRoot) {
      for (const parts of sdkRelativePaths) {
        const candidate = path.join(sdkRoot, ...parts);
        if (this._fileExistsFn(candidate)) {
          return candidate;
        }
      }
    }

    const result = await this._runCommand('which', [commandName]);
    if (!result.ok) {
      return null;
    }

    const resolved = result.stdout.trim();
    return resolved.length > 0 && this._fileExistsFn(resolved) ? resolved : null;
  }

  private _parseAvdManagerList(output: string): Map<string, AvdManagerRecord> {
    const result = new Map<string, AvdManagerRecord>();
    const sections = output.split(/(?:\r?\n){2,}/);
    for (const section of sections) {
      const lines = section.split(/\r?\n/);
      let name: string | null = null;
      let recordPath: string | null = null;
      for (const rawLine of lines) {
        const line = rawLine.trim();
        const nameMatch = line.match(/^Name:\s*(.+)$/i);
        if (nameMatch) {
          name = nameMatch[1]?.trim() ?? null;
          continue;
        }
        const pathMatch = line.match(/^Path:\s*(.+)$/i);
        if (pathMatch) {
          recordPath = pathMatch[1]?.trim() ?? null;
        }
      }

      if (name) {
        result.set(name, { name, path: recordPath });
      }
    }

    return result;
  }

  private _parseIni(rawConfig: string): Record<string, string> {
    const values: Record<string, string> = {};
    for (const rawLine of rawConfig.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) {
        continue;
      }

      const separatorIndex = line.indexOf('=');
      if (separatorIndex === -1) {
        continue;
      }

      const key = line.slice(0, separatorIndex).trim();
      const value = line.slice(separatorIndex + 1).trim();
      if (key) {
        values[key] = value;
      }
    }
    return values;
  }

  private _parseIOSRuntimeLabel(runtime: string): {
    label: string;
    sdkVersion: number;
  } | null {
    const match = runtime.match(/iOS-(\d+)(?:-(\d+))?/i);
    if (!match) {
      return null;
    }

    const major = parseInt(match[1] ?? '', 10) || 0;
    const minor = match[2] ? parseInt(match[2], 10) : null;
    return {
      label: minor !== null ? `iOS ${major}.${minor}` : `iOS ${major}`,
      sdkVersion: major,
    };
  }

  private _parseInlineAdbField(line: string, fieldName: string): string | null {
    const match = line.match(new RegExp(`${fieldName}:([^\\s]+)`));
    return this._normalizeLabel(match?.[1] ?? null);
  }

  private _parseAdbDeviceLine(line: string): {
    serial: string;
    state: string;
  } | null {
    const match = line.match(/^(\S+)\s+(.+)$/);
    if (!match) {
      return null;
    }

    const serial = match[1]?.trim();
    const remainder = match[2]?.trim();
    if (!serial || !remainder) {
      return null;
    }

    for (const knownState of ['device', 'offline', 'unauthorized']) {
      if (remainder === knownState || remainder.startsWith(`${knownState} `)) {
        return { serial, state: knownState };
      }
    }

    const markers = [
      ' product:',
      ' model:',
      ' device:',
      ' transport_id:',
      ' usb:',
      ' features:',
    ];
    const markerIndex = markers
      .map((marker) => remainder.indexOf(marker))
      .filter((index) => index >= 0)
      .reduce((smallest, index) => Math.min(smallest, index), Number.POSITIVE_INFINITY);
    const state = (markerIndex === Number.POSITIVE_INFINITY
      ? remainder
      : remainder.slice(0, markerIndex)).trim();

    return state.length > 0 ? { serial, state } : null;
  }

  private _parseAvdNameOutput(output: string): string | null {
    const line = output
      .split(/\r?\n/)
      .map((part) => part.trim())
      .find((part) => part.length > 0 && part.toUpperCase() !== 'OK');
    return line && line.length > 0 ? line : null;
  }

  private _normalizeLabel(value: string | null | undefined): string | null {
    if (!value) {
      return null;
    }
    const normalized = value.replace(/_/g, ' ').trim();
    return normalized.length > 0 ? normalized : null;
  }

  private _formatAndroidOsLabel(params: {
    releaseVersion: string | null;
    sdkVersion: number;
  }): string | null {
    if (params.releaseVersion) {
      return `Android ${params.releaseVersion}`;
    }
    if (params.sdkVersion > 0) {
      return `Android API ${params.sdkVersion}`;
    }
    return null;
  }

  private _formatAndroidDisplayName(params: {
    modelName: string | null;
    osVersionLabel: string | null;
    id: string;
  }): string {
    const parts = [params.modelName ?? 'Android target'];
    if (params.osVersionLabel) {
      parts.push(params.osVersionLabel);
    }
    parts.push(params.id);
    return parts.join(' - ');
  }

  private _formatIOSDisplayName(
    name: string,
    runtimeLabel: string | null,
    udid: string,
  ): string {
    const parts = [name];
    if (runtimeLabel) {
      parts.push(runtimeLabel);
    }
    parts.push(udid);
    return parts.join(' - ');
  }

  private _formatCommand(file: string, args: readonly string[]): string {
    return [file, ...args].join(' ');
  }

  private _getAvdHome(): string {
    return this._env['ANDROID_AVD_HOME'] ?? path.join(this._homeDir, '.android', 'avd');
  }
}
