// artifacts.ts is a type-only barrel: its interfaces are consumed at compile
// time (and exercised structurally by the typed fixtures in
// ui/test/viewModel.test.ts), while at runtime the module must stay EMPTY —
// it ships to browsers via @finalrun/report-web/ui and a runtime export or a
// load-time Node dependency would break that contract. This test pins the
// module's only runtime-observable behaviour.

import assert from 'node:assert/strict';
import test from 'node:test';
import * as artifacts from '../artifacts';

test('artifacts.ts stays a type-only barrel with zero runtime exports', () => {
  const runtimeKeys = Object.keys(artifacts).filter(
    (key) => key !== 'default' && key !== '__esModule',
  );
  assert.deepEqual(runtimeKeys, []);
});
