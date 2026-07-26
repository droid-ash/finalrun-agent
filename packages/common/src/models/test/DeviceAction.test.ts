import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EraseTextAction,
  GetHierarchyAction,
  GetScreenshotAction,
  PointPercent,
  RotateAction,
  DeviceAction,
  TapPercentAction,
} from '../DeviceAction.js';
import {
  PointPercent as BarrelPointPercent,
  RotateAction as BarrelRotateAction,
  TapPercentAction as BarrelTapPercentAction,
} from '../../index.js';

test('PointPercent serializes and deserializes percent coordinates', () => {
  const point = PointPercent.fromJson({ xPercent: 0.25, yPercent: 0.75 });

  assert.deepEqual(point.toJson(), {
    xPercent: 0.25,
    yPercent: 0.75,
  });
});

test('parity action models expose the expected DeviceAction types', () => {
  const tap = new TapPercentAction({
    point: new PointPercent({ xPercent: 0.1, yPercent: 0.2 }),
  });

  assert.equal(tap.type, DeviceAction.TAP_PERCENT);
  assert.deepEqual(tap.toJson(), {
    type: DeviceAction.TAP_PERCENT,
    point: { xPercent: 0.1, yPercent: 0.2 },
  });
  assert.equal(new EraseTextAction().type, DeviceAction.ERASE_TEXT);
  assert.equal(new RotateAction().type, DeviceAction.ROTATE);
  assert.equal(new GetScreenshotAction().type, DeviceAction.GET_SCREENSHOT);
  assert.equal(new GetHierarchyAction().type, DeviceAction.GET_HIERARCHY);
});

test('common barrel exports the new parity models', () => {
  const tap = new BarrelTapPercentAction({
    point: new BarrelPointPercent({ xPercent: 0.4, yPercent: 0.6 }),
  });
  const rotate = new BarrelRotateAction();

  assert.equal(tap.type, DeviceAction.TAP_PERCENT);
  assert.equal(rotate.type, DeviceAction.ROTATE);
});
