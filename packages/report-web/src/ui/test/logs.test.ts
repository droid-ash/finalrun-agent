// Characterization tests for device-log parsing. Timestamps are constructed
// through the same local-time Date paths the implementation uses, so the
// expectations hold in any host timezone.

import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDeviceLogLines, parseLogLevel, parseLogTimestamp } from '../logs';

// --- parseLogTimestamp ---

test('parseLogTimestamp reads Android threadtime lines with the reference year', () => {
  const line = '07-27 10:00:00.123  1234  5678 I ActivityManager: started';
  const expected = new Date(2024, 6, 27, 10, 0, 0, 123).toISOString();
  assert.equal(parseLogTimestamp(line, '2024-01-15T00:00:00.000Z'), expected);
});

test('parseLogTimestamp falls back to the current year without a reference date', () => {
  const line = '07-27 10:00:00.123  1234  5678 I Tag: msg';
  const expected = new Date(new Date().getFullYear(), 6, 27, 10, 0, 0, 123).toISOString();
  assert.equal(parseLogTimestamp(line), expected);
});

test('parseLogTimestamp reads iOS compact log lines', () => {
  const line = '2026-07-27 10:00:00.123 Df SpringBoard: launched';
  const expected = new Date('2026-07-27T10:00:00.123').toISOString();
  assert.equal(parseLogTimestamp(line), expected);
});

test('parseLogTimestamp returns undefined for unrecognized lines', () => {
  assert.equal(parseLogTimestamp('plain stderr output'), undefined);
  assert.equal(parseLogTimestamp(''), undefined);
});

// --- parseLogLevel ---

test('parseLogLevel maps iOS E/Ef to error and W/Wf to warn', () => {
  assert.equal(parseLogLevel('2026-07-27 10:00:00.123 E process: boom'), 'error');
  assert.equal(parseLogLevel('2026-07-27 10:00:00.123 Ef process: boom'), 'error');
  assert.equal(parseLogLevel('2026-07-27 10:00:00.123 W process: hmm'), 'warn');
  assert.equal(parseLogLevel('2026-07-27 10:00:00.123 Wf process: hmm'), 'warn');
  assert.equal(parseLogLevel('2026-07-27 10:00:00.123 I process: fine'), 'info');
});

test('parseLogLevel maps Android F/E to error, W to warn, D/I/V to info', () => {
  const android = (level: string) => `07-27 10:00:00.123  1234  5678 ${level} Tag: msg`;
  assert.equal(parseLogLevel(android('F')), 'error');
  assert.equal(parseLogLevel(android('E')), 'error');
  assert.equal(parseLogLevel(android('W')), 'warn');
  assert.equal(parseLogLevel(android('D')), 'info');
  assert.equal(parseLogLevel(android('I')), 'info');
  assert.equal(parseLogLevel(android('V')), 'info');
});

test('parseLogLevel defaults unstructured lines to info', () => {
  assert.equal(parseLogLevel('some random line'), 'info');
});

// --- parseDeviceLogLines ---

test('parseDeviceLogLines returns [] for empty input', () => {
  assert.deepEqual(parseDeviceLogLines(''), []);
});

test('parseDeviceLogLines maps every non-empty line without a recording start', () => {
  const text = '2026-07-27 10:00:00.000 E proc: boom\n\nplain line';
  const lines = parseDeviceLogLines(text);
  assert.equal(lines.length, 2);
  assert.equal(lines[0]?.level, 'error');
  assert.equal(lines[0]?.timestamp, new Date('2026-07-27T10:00:00.000').toISOString());
  assert.equal(lines[1]?.text, 'plain line');
  assert.equal(lines[1]?.timestamp, undefined);
  assert.equal(lines[1]?.level, 'info');
});

test('parseDeviceLogLines drops timestamped lines before the recording start', () => {
  const recordingStartedAt = new Date(2026, 6, 27, 10, 0, 0, 0).toISOString();
  const text = [
    '2026-07-27 09:59:59.000 I proc: too early',
    '2026-07-27 10:00:01.000 I proc: in range',
    'untimestamped line survives',
  ].join('\n');
  const lines = parseDeviceLogLines(text, recordingStartedAt);
  assert.deepEqual(
    lines.map((line) => line.text),
    ['2026-07-27 10:00:01.000 I proc: in range', 'untimestamped line survives'],
  );
});
