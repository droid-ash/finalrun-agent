// Characterization tests for the pure route helpers.

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildArtifactRoute, buildRunRoute } from '../routes';

test('buildRunRoute URI-encodes the run id', () => {
  assert.equal(buildRunRoute('run-42'), '/runs/run-42');
  assert.equal(buildRunRoute('run 42/x'), '/runs/run%2042%2Fx');
});

test('buildArtifactRoute normalizes backslashes and strips leading slashes', () => {
  assert.equal(buildArtifactRoute('a\\b\\c.png'), '/artifacts/a/b/c.png');
  assert.equal(buildArtifactRoute('///a/b'), '/artifacts/a/b');
});

test('buildArtifactRoute encodes each segment and drops empty ones', () => {
  assert.equal(buildArtifactRoute('run-1/step 1.png'), '/artifacts/run-1/step%201.png');
  assert.equal(buildArtifactRoute('a//b'), '/artifacts/a/b');
});

test('buildArtifactRoute rejects traversal segments', () => {
  assert.throws(() => buildArtifactRoute('a/../b'), /Invalid artifact path: a\/\.\.\/b/);
  assert.throws(() => buildArtifactRoute('./a'), /Invalid artifact path/);
});
