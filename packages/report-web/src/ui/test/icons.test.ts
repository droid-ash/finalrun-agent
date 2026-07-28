// Characterization tests for the icon constants. The data-URI icons must be
// exactly `data:image/svg+xml,` + encodeURIComponent(<svg …>) — the encoding
// round-trip pins svgDataUri's behaviour; the inline SVGs pin the attributes
// the UI depends on (viewBox sizing, aria-hidden).

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BACK_ARROW_ICON_SVG,
  CHECK_CIRCLE_ICON_SVG,
  FULLSCREEN_ICON_SVG,
  LOCAL_ICON_SRC,
  PAUSE_ICON_SVG,
  PLAY_CIRCLE_ICON_SVG,
  PLAY_ICON_SVG,
  TEST_ICON_SRC,
  TEST_SUITE_ICON_SRC,
  TIMER_ICON_SVG,
} from '../icons';

const DATA_URI_PREFIX = 'data:image/svg+xml,';

function decodeDataUri(src: string): string {
  assert.ok(src.startsWith(DATA_URI_PREFIX), `expected a data URI, got: ${src.slice(0, 30)}`);
  return decodeURIComponent(src.slice(DATA_URI_PREFIX.length));
}

test('data-URI icons decode to complete SVG documents in the muted palette', () => {
  for (const src of [TEST_ICON_SRC, TEST_SUITE_ICON_SRC, LOCAL_ICON_SRC]) {
    const svg = decodeDataUri(src);
    assert.ok(svg.startsWith('<svg '), 'decoded payload starts with an <svg> tag');
    assert.ok(svg.endsWith('</svg>'), 'decoded payload is a closed document');
    assert.ok(svg.includes('#707EAE'), 'icon uses the muted #707EAE palette');
    assert.ok(svg.includes('xmlns="http://www.w3.org/2000/svg"'), 'icon carries the SVG xmlns');
  }
});

test('data-URI payloads are exactly the encodeURIComponent of their SVG', () => {
  for (const src of [TEST_ICON_SRC, TEST_SUITE_ICON_SRC, LOCAL_ICON_SRC]) {
    const payload = src.slice(DATA_URI_PREFIX.length);
    assert.equal(encodeURIComponent(decodeURIComponent(payload)), payload);
  }
});

test('inline control icons share the 24px viewBox and stay aria-hidden', () => {
  const inline = [
    PLAY_CIRCLE_ICON_SVG,
    CHECK_CIRCLE_ICON_SVG,
    TIMER_ICON_SVG,
    BACK_ARROW_ICON_SVG,
    PLAY_ICON_SVG,
    PAUSE_ICON_SVG,
    FULLSCREEN_ICON_SVG,
  ];
  for (const svg of inline) {
    assert.ok(svg.includes('viewBox="0 0 24 24"'), 'inline icon uses the 24px viewBox');
    assert.ok(svg.includes('aria-hidden="true"'), 'inline icon is aria-hidden');
  }
  assert.equal(new Set(inline).size, inline.length, 'inline icons are all distinct');
});
