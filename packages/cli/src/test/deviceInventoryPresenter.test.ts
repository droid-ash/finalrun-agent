import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import type { DeviceInventoryEntry } from '@finalrun/common';
import {
  formatDiagnosticsForOutput,
  formatDeviceSelectionList,
  promptForDeviceSelection,
} from '../deviceInventoryPresenter.js';

function createEntry(params: {
  selectionId: string;
  platform: 'android' | 'ios';
  displayName: string;
  state?: DeviceInventoryEntry['state'];
  stateDetail?: string | null;
  runnable?: boolean;
  startable?: boolean;
}): DeviceInventoryEntry {
  const defaultState = params.platform === 'android' ? 'connected' : 'booted';
  return {
    selectionId: params.selectionId,
    platform: params.platform,
    targetKind: params.platform === 'android' ? 'android-emulator' : 'ios-simulator',
    state: params.state ?? defaultState,
    stateDetail: params.stateDetail ?? null,
    runnable: params.runnable ?? true,
    startable: params.startable ?? false,
    displayName: params.displayName,
    rawId: params.selectionId,
    modelName: params.displayName,
    osVersionLabel: params.platform === 'android' ? 'Android 14' : 'iOS 17.5',
    deviceInfo: null,
    transcripts: [],
  };
}

const TWO_ENTRIES = [
  createEntry({
    selectionId: 'android:1',
    platform: 'android',
    displayName: 'Pixel 8 - Android 14 - emulator-5554',
  }),
  createEntry({
    selectionId: 'ios:1',
    platform: 'ios',
    displayName: 'iPhone 15 Pro - iOS 17.5 - BOOTED-DEVICE-1',
  }),
];

test('promptForDeviceSelection reprompts until a valid device number is entered (TTY)', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let outputText = '';
  output.on('data', (chunk: Buffer | string) => {
    outputText += String(chunk);
  });
  input.write('9\n');
  setImmediate(() => {
    input.end('2\n');
  });

  const selected = await promptForDeviceSelection({
    heading: 'Select a device',
    entries: TWO_ENTRIES,
    io: {
      input,
      output,
      isTTY: true,
    },
  });

  assert.equal(selected.selectionId, 'ios:1');
  assert.match(outputText, /Invalid selection/);
  assert.match(outputText, /Enter a device number/);
});

test('promptForDeviceSelection selects from piped stdin without prompting (non-TTY)', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let outputText = '';
  output.on('data', (chunk: Buffer | string) => {
    outputText += String(chunk);
  });
  input.end('1\n');

  const selected = await promptForDeviceSelection({
    heading: 'Select a device',
    entries: TWO_ENTRIES,
    io: {
      input,
      output,
      isTTY: false,
    },
  });

  assert.equal(selected.selectionId, 'android:1');
  assert.match(outputText, /Select a device/);
  assert.match(outputText, /1\. Pixel 8/);
  assert.doesNotMatch(outputText, /Enter a device number/);
});

test('promptForDeviceSelection throws a clean error when stdin is closed without input (non-TTY)', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let outputText = '';
  output.on('data', (chunk: Buffer | string) => {
    outputText += String(chunk);
  });
  input.end();

  await assert.rejects(
    () =>
      promptForDeviceSelection({
        heading: 'Select a device',
        entries: TWO_ENTRIES,
        io: {
          input,
          output,
          isTTY: false,
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Multiple devices available/);
      assert.match(error.message, /echo "1"/);
      assert.doesNotMatch(error.message, /Enter a device number/);
      return true;
    },
  );

  assert.match(outputText, /Select a device/);
  assert.match(outputText, /Pixel 8/);
});

test('promptForDeviceSelection rejects invalid piped input (non-TTY)', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.end('99\n');

  await assert.rejects(
    () =>
      promptForDeviceSelection({
        heading: 'Select a device',
        entries: TWO_ENTRIES,
        io: {
          input,
          output,
          isTTY: false,
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Invalid device number "99"/);
      assert.match(error.message, /1, 2/);
      return true;
    },
  );
});

test('formatDeviceSelectionList shows non-selectable targets with explicit states', () => {
  const rendered = formatDeviceSelectionList(
    [
      createEntry({
        selectionId: 'android:1',
        platform: 'android',
        displayName: 'Pixel 8 - Android 14 - emulator-5554',
      }),
      createEntry({
        selectionId: 'android:2',
        platform: 'android',
        displayName: 'Pixel 7 - R52N30',
        state: 'unauthorized',
        runnable: false,
        startable: false,
      }),
      createEntry({
        selectionId: 'ios:1',
        platform: 'ios',
        displayName: 'iPhone 15 - iOS 17.5 - SHUTDOWN-DEVICE-1',
        state: 'shutdown',
        runnable: false,
        startable: true,
      }),
      createEntry({
        selectionId: 'ios:2',
        platform: 'ios',
        displayName: 'Unavailable Simulator - iOS 18 - UNAVAILABLE-DEVICE',
        state: 'unavailable',
        stateDetail: 'runtime profile missing',
        runnable: false,
        startable: false,
      }),
    ],
    [
      createEntry({
        selectionId: 'android:1',
        platform: 'android',
        displayName: 'Pixel 8 - Android 14 - emulator-5554',
      }),
    ],
  );

  assert.match(rendered.text, /Ready Targets/);
  assert.match(rendered.text, /1\. Pixel 8 - Android 14 - emulator-5554 \(connected\)/);
  assert.match(rendered.text, /Available to Start/);
  assert.match(rendered.text, /- iPhone 15 - iOS 17\.5 - SHUTDOWN-DEVICE-1 \(shutdown\)/);
  assert.match(rendered.text, /Unavailable Targets/);
  assert.match(rendered.text, /- Pixel 7 - R52N30 \(unauthorized\)/);
  assert.match(
    rendered.text,
    /- Unavailable Simulator - iOS 18 - UNAVAILABLE-DEVICE \(unavailable: runtime profile missing\)/,
  );
  assert.deepEqual(
    rendered.numberedEntries.map(({ entry }) => entry.selectionId),
    ['android:1'],
  );
});

test('formatDiagnosticsForOutput includes raw stdout and stderr blocks', () => {
  const rendered = formatDiagnosticsForOutput([
    {
      scope: 'android-connected',
      summary: 'Android device discovery failed.',
      blocking: true,
      transcripts: [
        {
          command: 'adb devices -l',
          stdout: 'List of devices attached\n',
          stderr: 'adb server is out of date\n',
          exitCode: 1,
        },
      ],
    },
  ]);

  assert.match(rendered, /Command: adb devices -l/);
  assert.match(rendered, /stdout:\nList of devices attached/);
  assert.match(rendered, /stderr:\nadb server is out of date/);
  assert.match(rendered, /exitCode: 1/);
});
