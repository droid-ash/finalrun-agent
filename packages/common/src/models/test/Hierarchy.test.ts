// Characterization tests for Hierarchy parsing.
//
// These pin the OBSERVED behaviour of Hierarchy.fromJson / fromJsonString /
// fromFlatJson as-is — including behaviour that only falls out of `??`
// semantics (null/undefined fall through; '' and false are KEPT) and the
// alias-precedence order of each fallback chain. They exist as an equivalence
// proof for refactors: they must pass before AND after any restructuring of
// Hierarchy.ts. If a refactor requires editing one of these tests, the
// refactor changed behaviour and is wrong.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Hierarchy, HierarchyNode } from '../Hierarchy.js';

/** Parse a single flat node through the public fromFlatJson entry point. */
const flatNode = (json: Record<string, unknown>): HierarchyNode =>
  Hierarchy.fromFlatJson([json]).flattenedHierarchy[0]!;

// ---------------------------------------------------------------------------
// Alias precedence (flat path): earlier alias wins; later alias is used only
// when every earlier one is absent.
// ---------------------------------------------------------------------------

test('flat text: text beats title beats value, in order', () => {
  assert.equal(flatNode({ text: 'a', title: 'b', value: 'c' }).text, 'a');
  assert.equal(flatNode({ title: 'b', value: 'c' }).text, 'b');
  assert.equal(flatNode({ value: 'c' }).text, 'c');
  assert.equal(flatNode({}).text, null);
});

test('flat accessibilityText: content_desc beats contentDesc beats accessibilityText beats label, in order', () => {
  assert.equal(
    flatNode({ content_desc: 'a', contentDesc: 'b', accessibilityText: 'c', label: 'd' })
      .accessibilityText,
    'a',
  );
  assert.equal(
    flatNode({ contentDesc: 'b', accessibilityText: 'c', label: 'd' }).accessibilityText,
    'b',
  );
  assert.equal(flatNode({ accessibilityText: 'c', label: 'd' }).accessibilityText, 'c');
  assert.equal(flatNode({ label: 'd' }).accessibilityText, 'd');
  assert.equal(flatNode({}).accessibilityText, null);
});

test('flat id: id beats identifier, null when both absent', () => {
  assert.equal(flatNode({ id: 'a', identifier: 'b' }).id, 'a');
  assert.equal(flatNode({ identifier: 'b' }).id, 'b');
  assert.equal(flatNode({}).id, null);
});

test('flat clazz: class beats clazz, null when both absent', () => {
  assert.equal(flatNode({ class: 'a', clazz: 'b' }).clazz, 'a');
  assert.equal(flatNode({ clazz: 'b' }).clazz, 'b');
  assert.equal(flatNode({}).clazz, null);
});

test('flat isScrollable: isScrollable beats is_scrollable, defaults false', () => {
  assert.equal(flatNode({ isScrollable: true, is_scrollable: false }).isScrollable, true);
  assert.equal(flatNode({ is_scrollable: true }).isScrollable, true);
  assert.equal(flatNode({}).isScrollable, false);
});

test('flat isFocused: isFocused beats is_focused, defaults false', () => {
  assert.equal(flatNode({ isFocused: true, is_focused: false }).isFocused, true);
  assert.equal(flatNode({ is_focused: true }).isFocused, true);
  assert.equal(flatNode({}).isFocused, false);
});

test('flat isEditable: isEditable beats is_editable, defaults false', () => {
  assert.equal(flatNode({ isEditable: true, is_editable: false }).isEditable, true);
  assert.equal(flatNode({ is_editable: true }).isEditable, true);
  assert.equal(flatNode({}).isEditable, false);
});

test('flat isSelected: isSelected beats is_selected beats is_checked, defaults false', () => {
  assert.equal(
    flatNode({ isSelected: true, is_selected: false, is_checked: false }).isSelected,
    true,
  );
  assert.equal(flatNode({ is_selected: true, is_checked: false }).isSelected, true);
  assert.equal(flatNode({ is_checked: true }).isSelected, true);
  assert.equal(flatNode({}).isSelected, false);
});

test('flat hintText and error: value kept, null when absent', () => {
  assert.equal(flatNode({ hintText: 'hint', error: 'boom' }).hintText, 'hint');
  assert.equal(flatNode({ hintText: 'hint', error: 'boom' }).error, 'boom');
  assert.equal(flatNode({}).hintText, null);
  assert.equal(flatNode({}).error, null);
});

// ---------------------------------------------------------------------------
// `??` semantics, not truthiness: a falsy-but-PRESENT value is kept — the
// chain falls through on null/undefined ONLY. One explicit case per chain.
// ---------------------------------------------------------------------------

test('flat text: empty string is kept, not replaced by a later alias', () => {
  assert.equal(flatNode({ text: '', title: 'b', value: 'c' }).text, '');
  assert.equal(flatNode({ title: '', value: 'c' }).text, '');
});

test('flat accessibilityText: empty string is kept, not replaced by a later alias', () => {
  assert.equal(flatNode({ content_desc: '', label: 'd' }).accessibilityText, '');
});

test('flat clazz: empty string class is kept, not replaced by clazz', () => {
  assert.equal(flatNode({ class: '', clazz: 'b' }).clazz, '');
});

test('flat isScrollable: explicit false is kept, not replaced by is_scrollable true', () => {
  assert.equal(flatNode({ isScrollable: false, is_scrollable: true }).isScrollable, false);
});

test('flat isFocused: explicit false is kept, not replaced by is_focused true', () => {
  assert.equal(flatNode({ isFocused: false, is_focused: true }).isFocused, false);
});

test('flat isEditable: explicit false is kept, not replaced by is_editable true', () => {
  assert.equal(flatNode({ isEditable: false, is_editable: true }).isEditable, false);
});

test('flat isSelected: explicit false is kept, not replaced by is_selected/is_checked true', () => {
  assert.equal(flatNode({ isSelected: false, is_selected: true, is_checked: true }).isSelected, false);
  assert.equal(flatNode({ is_selected: false, is_checked: true }).isSelected, false);
});

test('flat hintText/error: empty strings are kept as empty strings', () => {
  assert.equal(flatNode({ hintText: '' }).hintText, '');
  assert.equal(flatNode({ error: '' }).error, '');
});

// ---------------------------------------------------------------------------
// id post-processing: an Android resource id containing ':id/' is reduced to
// its last segment; other ids pass through; the shortening also applies when
// the id came from the `identifier` alias.
// ---------------------------------------------------------------------------

test('flat id: ":id/" resource ids are shortened to the last segment', () => {
  assert.equal(flatNode({ id: 'com.example:id/submit' }).id, 'submit');
  assert.equal(flatNode({ identifier: 'com.example:id/ok' }).id, 'ok');
});

test('flat id: ids without ":id/" pass through unchanged', () => {
  assert.equal(flatNode({ id: 'plain-identifier' }).id, 'plain-identifier');
});

// ---------------------------------------------------------------------------
// isImage: NOT a pure alias chain — (isImage ?? false) OR the class contains
// ImageView / ImageButton / SvgView. Each path pinned individually.
// ---------------------------------------------------------------------------

test('flat isImage: explicit flag true wins with no class', () => {
  assert.equal(flatNode({ isImage: true }).isImage, true);
});

test('flat isImage: explicit false with a non-image class stays false', () => {
  assert.equal(flatNode({ isImage: false, class: 'android.widget.TextView' }).isImage, false);
  assert.equal(flatNode({ isImage: false }).isImage, false);
  assert.equal(flatNode({}).isImage, false);
});

test('flat isImage: ImageView class makes the node an image even when isImage is false', () => {
  assert.equal(flatNode({ isImage: false, class: 'android.widget.ImageView' }).isImage, true);
});

test('flat isImage: ImageButton class makes the node an image', () => {
  assert.equal(flatNode({ class: 'android.widget.ImageButton' }).isImage, true);
});

test('flat isImage: SvgView class makes the node an image', () => {
  assert.equal(flatNode({ class: 'com.horcrux.svg.SvgView' }).isImage, true);
});

test('flat isImage: the clazz alias (not just class) feeds the class-marker check', () => {
  assert.equal(flatNode({ clazz: 'android.widget.ImageView' }).isImage, true);
});

// ---------------------------------------------------------------------------
// _parseBounds: accepted forms and the null result for everything else.
// ---------------------------------------------------------------------------

test('bounds: 4-element array is taken as [left, top, right, bottom]', () => {
  assert.deepEqual(flatNode({ bounds: [1, 2, 3, 4] }).bounds, [1, 2, 3, 4]);
});

test('bounds: array elements are coerced with Number (string digits become numbers)', () => {
  assert.deepEqual(flatNode({ bounds: ['1', '2', '3', '4'] }).bounds, [1, 2, 3, 4]);
});

test('bounds: {left, top, right, bottom} object form is accepted', () => {
  assert.deepEqual(
    flatNode({ bounds: { left: 5, top: 6, right: 7, bottom: 8 } }).bounds,
    [5, 6, 7, 8],
  );
});

test('bounds: wrong-length arrays, garbage, and absence all yield null', () => {
  assert.equal(flatNode({ bounds: [1, 2, 3] }).bounds, null);
  assert.equal(flatNode({ bounds: [1, 2, 3, 4, 5] }).bounds, null);
  assert.equal(flatNode({ bounds: 'garbage' }).bounds, null);
  assert.equal(flatNode({ bounds: { left: 1, top: 2, right: 3 } }).bounds, null);
  assert.equal(flatNode({}).bounds, null);
});

// ---------------------------------------------------------------------------
// fromFlatJson: array order and index assignment; no tree.
// ---------------------------------------------------------------------------

test('fromFlatJson: nodes keep array order, index equals array position, root is null', () => {
  const hierarchy = Hierarchy.fromFlatJson([
    { text: 'first' },
    { text: 'second' },
    { text: 'third' },
  ]);
  assert.equal(hierarchy.root, null);
  const nodes = hierarchy.flattenedHierarchy;
  assert.deepEqual(nodes.map((node) => node.text), ['first', 'second', 'third']);
  assert.deepEqual(nodes.map((node) => node.index), [0, 1, 2]);
  assert.deepEqual(nodes.map((node) => node.children), [[], [], []]);
});

// ---------------------------------------------------------------------------
// fromJson (tree path): _parseNode's own chains and DFS pre-order indexing.
// ---------------------------------------------------------------------------

test('fromJson: DFS pre-order index assignment across nested children', () => {
  const hierarchy = Hierarchy.fromJson({
    text: 'root',
    children: [
      { text: 'child1', children: [{ text: 'grandchild' }] },
      { text: 'child2' },
    ],
  });
  const nodes = hierarchy.flattenedHierarchy;
  assert.deepEqual(
    nodes.map((node) => [node.index, node.text]),
    [
      [0, 'root'],
      [1, 'child1'],
      [2, 'grandchild'],
      [3, 'child2'],
    ],
  );
  assert.equal(hierarchy.root?.text, 'root');
  assert.equal(hierarchy.root?.children.length, 2);
});

test('fromJson: accessibilityText prefers contentDesc over accessibilityText', () => {
  const both = Hierarchy.fromJson({ contentDesc: 'a', accessibilityText: 'b' });
  assert.equal(both.root?.accessibilityText, 'a');
  const fallback = Hierarchy.fromJson({ accessibilityText: 'b' });
  assert.equal(fallback.root?.accessibilityText, 'b');
});

test('fromJson: clazz prefers class over clazz', () => {
  const both = Hierarchy.fromJson({ class: 'a', clazz: 'b' });
  assert.equal(both.root?.clazz, 'a');
  const fallback = Hierarchy.fromJson({ clazz: 'b' });
  assert.equal(fallback.root?.clazz, 'b');
});

test('fromJson: empty-string text and contentDesc are kept, explicit false booleans are kept', () => {
  const node = Hierarchy.fromJson({
    text: '',
    contentDesc: '',
    accessibilityText: 'later',
    isScrollable: false,
    isImage: false,
  }).root;
  assert.equal(node?.text, '');
  assert.equal(node?.accessibilityText, '');
  assert.equal(node?.isScrollable, false);
  assert.equal(node?.isImage, false);
});

test('fromJson: node defaults — absent fields become null/false, no children means leaf', () => {
  const node = Hierarchy.fromJson({}).root;
  assert.ok(node);
  assert.equal(node.text, null);
  assert.equal(node.accessibilityText, null);
  assert.equal(node.id, null);
  assert.equal(node.clazz, null);
  assert.equal(node.bounds, null);
  assert.equal(node.isScrollable, false);
  assert.equal(node.isFocused, false);
  assert.equal(node.isEditable, false);
  assert.equal(node.isImage, false);
  assert.equal(node.hintText, null);
  assert.equal(node.error, null);
  assert.equal(node.isSelected, false);
  assert.deepEqual(node.children, []);
});

test('fromJson: the tree path does NOT shorten ":id/" resource ids (flat-path-only behaviour)', () => {
  assert.equal(Hierarchy.fromJson({ id: 'com.example:id/submit' }).root?.id, 'com.example:id/submit');
});

test('fromJson: the tree path does NOT infer isImage from the class (flat-path-only behaviour)', () => {
  assert.equal(Hierarchy.fromJson({ class: 'android.widget.ImageView' }).root?.isImage, false);
});

test('fromJson: bounds object form works on the tree path too', () => {
  assert.deepEqual(
    Hierarchy.fromJson({ bounds: { left: 1, top: 2, right: 3, bottom: 4 } }).root?.bounds,
    [1, 2, 3, 4],
  );
});

// ---------------------------------------------------------------------------
// fromJsonString: dispatch between tree and flat forms; malformed input.
// ---------------------------------------------------------------------------

test('fromJsonString: an object payload takes the tree path', () => {
  const hierarchy = Hierarchy.fromJsonString('{"text":"root","children":[{"text":"kid"}]}');
  assert.equal(hierarchy.root?.text, 'root');
  assert.deepEqual(hierarchy.flattenedHierarchy.map((node) => node.text), ['root', 'kid']);
});

test('fromJsonString: an array payload takes the flat path', () => {
  const hierarchy = Hierarchy.fromJsonString('[{"text":"a"},{"text":"b"}]');
  assert.equal(hierarchy.root, null);
  assert.deepEqual(hierarchy.flattenedHierarchy.map((node) => node.text), ['a', 'b']);
});

test('fromJsonString: malformed JSON yields an empty hierarchy, not a throw', () => {
  const hierarchy = Hierarchy.fromJsonString('not json at all {');
  assert.equal(hierarchy.root, null);
  assert.deepEqual(hierarchy.flattenedHierarchy, []);
});

// ---------------------------------------------------------------------------
// HierarchyNode constructor: defaulting contract for direct construction.
// ---------------------------------------------------------------------------

test('HierarchyNode constructor: omitted params default to null/false/[]', () => {
  const node = new HierarchyNode({ index: 5 });
  assert.equal(node.index, 5);
  assert.equal(node.text, null);
  assert.equal(node.accessibilityText, null);
  assert.equal(node.id, null);
  assert.equal(node.clazz, null);
  assert.equal(node.bounds, null);
  assert.equal(node.isScrollable, false);
  assert.equal(node.isFocused, false);
  assert.equal(node.isEditable, false);
  assert.equal(node.isImage, false);
  assert.equal(node.hintText, null);
  assert.equal(node.error, null);
  assert.equal(node.isSelected, false);
  assert.deepEqual(node.children, []);
});

test('HierarchyNode constructor: explicitly passed falsy values are kept', () => {
  const node = new HierarchyNode({ index: 0, text: '', isScrollable: false, isImage: true });
  assert.equal(node.text, '');
  assert.equal(node.isScrollable, false);
  assert.equal(node.isImage, true);
});

test('fromJson: the tree path reads id from "id" ONLY — "identifier" is a flat-path alias', () => {
  // The two parse paths deliberately carry DIFFERENT id chains: _parseFlatNode
  // accepts ['id', 'identifier'], _parseNode accepts ['id'] alone. Nothing else
  // in the suite pins that asymmetry, so widening the tree chain to match the
  // flat one — a plausible "make them consistent" edit — would go uncaught.
  assert.equal(Hierarchy.fromJson({ identifier: 'submit' }).root?.id, null);
  // The flat path, for contrast, does honour it.
  assert.equal(Hierarchy.fromFlatJson([{ identifier: 'submit' }]).flattenedHierarchy[0]?.id, 'submit');
});
