// Characterization tests for duration/label formatting helpers.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatLongDuration,
  formatStepDuration,
  statusPillLabel,
  successRateTone,
  summaryIconStyle,
} from '../format';

test('formatLongDuration renders 0s for missing, zero, and negative durations', () => {
  assert.equal(formatLongDuration(undefined), '0s');
  assert.equal(formatLongDuration(0), '0s');
  assert.equal(formatLongDuration(-5000), '0s');
});

test('formatLongDuration rounds to whole seconds', () => {
  assert.equal(formatLongDuration(499), '0s');
  assert.equal(formatLongDuration(1400), '1s');
  // Round-up boundary: 1600ms must round UP to 2s. 499/1400 behave the same
  // under Math.round and Math.floor, so only this value pins the round-up.
  assert.equal(formatLongDuration(1600), '2s');
  assert.equal(formatLongDuration(59000), '59s');
});

test('formatLongDuration renders minutes with seconds', () => {
  assert.equal(formatLongDuration(60000), '1m 0s');
  assert.equal(formatLongDuration(65000), '1m 5s');
  assert.equal(formatLongDuration(3599000), '59m 59s');
});

test('formatLongDuration renders hours with minutes and drops seconds', () => {
  assert.equal(formatLongDuration(3600000), '1h 0m');
  assert.equal(formatLongDuration(3661000), '1h 1m');
  assert.equal(formatLongDuration(7325000), '2h 2m');
});

test('formatStepDuration uses one decimal below 10s and whole seconds from 10s', () => {
  assert.equal(formatStepDuration(undefined), '0.0s');
  assert.equal(formatStepDuration(1234), '1.2s');
  assert.equal(formatStepDuration(9940), '9.9s');
  assert.equal(formatStepDuration(10000), '10s');
  assert.equal(formatStepDuration(12300), '12s');
});

test('successRateTone thresholds at 80 and 50', () => {
  assert.equal(successRateTone(100), 'success');
  assert.equal(successRateTone(80), 'success');
  assert.equal(successRateTone(79.9), 'warning');
  assert.equal(successRateTone(50), 'warning');
  assert.equal(successRateTone(49.9), 'danger');
  assert.equal(successRateTone(0), 'danger');
});

test('summaryIconStyle returns the exact style string per tone', () => {
  assert.equal(
    summaryIconStyle('accent'),
    'color: var(--accent); background: rgba(67, 24, 255, 0.1);',
  );
  assert.equal(
    summaryIconStyle('success'),
    'color: var(--success); background: rgba(5, 205, 153, 0.12);',
  );
  assert.equal(
    summaryIconStyle('warning'),
    'color: var(--warning); background: rgba(255, 146, 12, 0.12);',
  );
  assert.equal(
    summaryIconStyle('danger'),
    'color: var(--failure); background: rgba(238, 93, 80, 0.12);',
  );
  assert.equal(summaryIconStyle('neutral'), 'color: var(--text); background: var(--panel-alt);');
});

test('statusPillLabel maps every status to its pill text', () => {
  assert.equal(statusPillLabel('success'), 'Passed');
  assert.equal(statusPillLabel('aborted'), 'Aborted');
  assert.equal(statusPillLabel('failure'), 'Failed');
  assert.equal(statusPillLabel('error'), 'Error');
  assert.equal(statusPillLabel('not_executed'), 'Not Executed');
});
