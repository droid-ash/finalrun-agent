// Port of common/model/Hierarchy.dart — MINIMAL: parse + flatten + node properties
// The Dart file is ~108KB. We port only the subset used by FinalRunAgent and
// HeadlessActionExecutor for AI prompt building and grounding.

import { PLATFORM_ANDROID, PLATFORM_IOS } from '../constants.js';

/**
 * `??` as a function: `value` unless it is null/undefined, else `fallback`.
 * Falsy-but-present values (`''`, `false`, `0`) are KEPT — this must never
 * become a truthiness check. Typed-params counterpart of `Hierarchy._pick`'s
 * fallback rule.
 */
function orDefault<T>(value: T | null | undefined, fallback: T): T {
  return value ?? fallback;
}

/**
 * Represents a single node in the UI hierarchy tree.
 *
 * Dart equivalent: HierarchyNode in Hierarchy.dart
 */
export class HierarchyNode {
  readonly index: number;
  readonly text: string | null;
  readonly accessibilityText: string | null;
  readonly id: string | null;
  readonly clazz: string | null;
  readonly bounds: [number, number, number, number] | null; // [left, top, right, bottom]
  readonly isScrollable: boolean;
  readonly isFocused: boolean;
  readonly isEditable: boolean;
  readonly isImage: boolean;
  readonly hintText: string | null;
  readonly error: string | null;
  readonly isSelected: boolean;
  readonly children: HierarchyNode[];

  constructor(params: {
    index: number;
    text?: string | null;
    accessibilityText?: string | null;
    id?: string | null;
    clazz?: string | null;
    bounds?: [number, number, number, number] | null;
    isScrollable?: boolean;
    isFocused?: boolean;
    isEditable?: boolean;
    isImage?: boolean;
    hintText?: string | null;
    error?: string | null;
    isSelected?: boolean;
    children?: HierarchyNode[];
  }) {
    this.index = params.index;
    this.text = orDefault<string | null>(params.text, null);
    this.accessibilityText = orDefault<string | null>(params.accessibilityText, null);
    this.id = orDefault<string | null>(params.id, null);
    this.clazz = orDefault<string | null>(params.clazz, null);
    this.bounds = orDefault<[number, number, number, number] | null>(params.bounds, null);
    this.isScrollable = orDefault(params.isScrollable, false);
    this.isFocused = orDefault(params.isFocused, false);
    this.isEditable = orDefault(params.isEditable, false);
    this.isImage = orDefault(params.isImage, false);
    this.hintText = orDefault<string | null>(params.hintText, null);
    this.error = orDefault<string | null>(params.error, null);
    this.isSelected = orDefault(params.isSelected, false);
    this.children = orDefault(params.children, []);
  }

  /**
   * Dart: bool isElementTypeButton()
   * Returns true if the element's class suggests it's a button-like widget.
   */
  isElementTypeButton(): boolean {
    if (!this.clazz) return false;
    return this.classContainsButton();
  }

  /**
   * Dart: bool classContainsButton()
   */
  classContainsButton(): boolean {
    if (!this.clazz) return false;
    const lower = this.clazz.toLowerCase();
    return lower.includes('button') || lower.includes('clickable');
  }

  /**
   * Get the center point of this node's bounds.
   */
  getCenterPoint(): { x: number; y: number } | null {
    if (!this.bounds) return null;
    const [left, top, right, bottom] = this.bounds;
    return {
      x: Math.round((left + right) / 2),
      y: Math.round((top + bottom) / 2),
    };
  }

}

// ============================================================================
// Hierarchy — the full tree with parsing and flattening
// ============================================================================

/**
 * Represents the full UI hierarchy of a screen.
 * Parsed from JSON sent by the on-device driver app via gRPC.
 *
 * Dart equivalent: Hierarchy class in Hierarchy.dart
 */
export class Hierarchy {
  readonly root: HierarchyNode | null;
  private _flattenedCache: HierarchyNode[] | null = null;

  constructor(root: HierarchyNode | null, flattenedNodes?: HierarchyNode[] | null) {
    this.root = root;
    if (flattenedNodes) {
      this._flattenedCache = flattenedNodes;
    }
  }

  /**
   * Parse a hierarchy from the JSON string returned by the driver.
   * Dart: factory Hierarchy.fromJson(Map<String, dynamic> json)
   */
  static fromJson(json: Record<string, unknown>): Hierarchy {
    const root = Hierarchy._parseNode(json, 0);
    return new Hierarchy(root.node);
  }

  /**
   * Parse hierarchy from the raw JSON string.
   */
  static fromJsonString(jsonString: string): Hierarchy {
    try {
      const parsed = JSON.parse(jsonString) as unknown;
      if (Array.isArray(parsed)) {
        return Hierarchy.fromFlatJson(parsed);
      }
      return Hierarchy.fromJson(parsed as Record<string, unknown>);
    } catch {
      return new Hierarchy(null);
    }
  }

  /**
   * Parse the flat array payload returned by the native driver.
   * Dart: Hierarchy.fromJSON(List<dynamic> jsonArray, ...)
   */
  static fromFlatJson(jsonArray: unknown[]): Hierarchy {
    const flattenedNodes = jsonArray.map((item, index) =>
      Hierarchy._parseFlatNode(item as Record<string, unknown>, index),
    );
    return new Hierarchy(null, flattenedNodes);
  }

  /**
   * Flatten the hierarchy tree into a linear list of nodes.
   * Each node gets a sequential 0-based index.
   * Dart: List<HierarchyNode> get flattenedHierarchy
   */
  get flattenedHierarchy(): HierarchyNode[] {
    if (this._flattenedCache !== null) return this._flattenedCache;

    const result: HierarchyNode[] = [];
    if (this.root) {
      Hierarchy._flattenNode(this.root, result);
    }
    this._flattenedCache = result;
    return result;
  }

  /**
   * Hierarchy subset for the PLANNER — minimal, tappable/image elements only.
   *
   * Filter: a node is kept only if it has accessibility text AND is either an
   * image, an iOS button, or an Android button-class node.
   * Fields: index, contentDesc, class (Android class name shortened), bounds.
   *
   * The planner treats the screenshot as the source of truth and uses the
   * hierarchy only to disambiguate interactive targets, so the slim payload
   * is sufficient and keeps token cost low.
   */
  toPromptElementsForPlanner(platform?: string): Record<string, unknown>[] {
    const isAndroid = platform === PLATFORM_ANDROID;
    const isIOS = platform === PLATFORM_IOS;
    return this.flattenedHierarchy
      .filter((node) => {
        const hasAccText = !!node.accessibilityText;
        if (!hasAccText) return false;
        if (node.isImage) return true;
        if (isIOS && node.isElementTypeButton()) return true;
        if (isAndroid && node.classContainsButton()) return true;
        return false;
      })
      .map((node) => {
        const out: Record<string, unknown> = { index: node.index };
        if (node.accessibilityText) out['contentDesc'] = node.accessibilityText;
        const simpleClass = Hierarchy._shortenAndroidClass(node.clazz, platform);
        if (simpleClass) out['class'] = simpleClass;
        if (node.bounds) out['bounds'] = node.bounds;
        return out;
      });
  }

  /**
   * Hierarchy subset for the GROUNDER — every flattened node with a rich
   * field set.
   *
   * Filter: none (all flattened nodes are included).
   * Fields: index, text, contentDesc, id, class (Android class name shortened),
   * bounds, isScrollable, isFocused, isEditable, hintText, error, isSelected.
   *
   * The grounder needs maximum context to map a natural-language target
   * description to an element index reliably.
   */
  toPromptElementsForGrounder(platform?: string): Record<string, unknown>[] {
    return this.flattenedHierarchy.map((node) => {
      const out: Record<string, unknown> = { index: node.index };
      if (node.text) out['text'] = node.text;
      if (node.accessibilityText) out['contentDesc'] = node.accessibilityText;
      if (node.id) out['id'] = node.id;
      const simpleClass = Hierarchy._shortenAndroidClass(node.clazz, platform);
      if (simpleClass) out['class'] = simpleClass;
      if (node.bounds) out['bounds'] = node.bounds;
      if (node.isScrollable) out['isScrollable'] = true;
      if (node.isFocused) out['isFocused'] = true;
      if (node.isEditable) out['isEditable'] = true;
      if (node.hintText) out['hintText'] = node.hintText;
      if (node.error) out['error'] = node.error;
      if (node.isSelected) out['isSelected'] = true;
      return out;
    });
  }

  // ---------- private helpers ----------

  /**
   * Android classes come through fully qualified (e.g. `android.widget.Button`).
   * Shorten to the last `.`-separated segment so prompts stay terse.
   * iOS classes are left alone.
   */
  private static _shortenAndroidClass(
    clazz: string | null,
    platform: string | undefined,
  ): string | null {
    if (!clazz) return null;
    if (platform !== PLATFORM_ANDROID) return clazz;
    const parts = clazz.split('.');
    return parts[parts.length - 1] ?? clazz;
  }

  /**
   * Recursively parse a JSON node into a HierarchyNode.
   * Returns the node and a counter tracking the next available index.
   */
  private static _parseNode(
    json: Record<string, unknown>,
    startIndex: number,
  ): { node: HierarchyNode; nextIndex: number } {
    let currentIndex = startIndex;

    const childrenJson = (json['children'] as unknown[]) ?? [];
    const parsedChildren: HierarchyNode[] = [];

    for (const childJson of childrenJson) {
      const result = Hierarchy._parseNode(
        childJson as Record<string, unknown>,
        currentIndex + 1,
      );
      parsedChildren.push(result.node);
      currentIndex = result.nextIndex;
    }

    // Parse bounds: either array [l,t,r,b] or object {left,top,right,bottom}
    const bounds = Hierarchy._parseBounds(json['bounds']);

    const node = new HierarchyNode({
      index: startIndex,
      text: Hierarchy._pick<string | null>(json, ['text'], null),
      accessibilityText: Hierarchy._pick<string | null>(
        json,
        ['contentDesc', 'accessibilityText'],
        null,
      ),
      id: Hierarchy._pick<string | null>(json, ['id'], null),
      clazz: Hierarchy._pick<string | null>(json, ['class', 'clazz'], null),
      bounds,
      isScrollable: Hierarchy._pick(json, ['isScrollable'], false),
      isFocused: Hierarchy._pick(json, ['isFocused'], false),
      isEditable: Hierarchy._pick(json, ['isEditable'], false),
      isImage: Hierarchy._pick(json, ['isImage'], false),
      hintText: Hierarchy._pick<string | null>(json, ['hintText'], null),
      error: Hierarchy._pick<string | null>(json, ['error'], null),
      isSelected: Hierarchy._pick(json, ['isSelected'], false),
      children: parsedChildren,
    });

    return { node, nextIndex: currentIndex };
  }

  /**
   * Flatten a node and all its descendants into a list.
   */
  private static _flattenNode(
    node: HierarchyNode,
    result: HierarchyNode[],
  ): void {
    result.push(node);
    for (const child of node.children) {
      Hierarchy._flattenNode(child, result);
    }
  }

  private static _parseFlatNode(
    json: Record<string, unknown>,
    index: number,
  ): HierarchyNode {
    // id is not a pure alias chain: an Android resource id containing ':id/'
    // is reduced to its last segment after the alias lookup.
    let id = Hierarchy._pick<string | null>(json, ['id', 'identifier'], null);
    if (id && id.includes(':id/')) {
      id = id.split(':id/').at(-1) ?? id;
    }

    const clazz = Hierarchy._pick<string | null>(json, ['class', 'clazz'], null);

    return new HierarchyNode({
      index,
      text: Hierarchy._pick<string | null>(json, ['text', 'title', 'value'], null),
      accessibilityText: Hierarchy._pick<string | null>(
        json,
        ['content_desc', 'contentDesc', 'accessibilityText', 'label'],
        null,
      ),
      id,
      clazz,
      bounds: Hierarchy._parseBounds(json['bounds']),
      isScrollable: Hierarchy._pick(json, ['isScrollable', 'is_scrollable'], false),
      isFocused: Hierarchy._pick(json, ['isFocused', 'is_focused'], false),
      isEditable: Hierarchy._pick(json, ['isEditable', 'is_editable'], false),
      isImage: Hierarchy._isImageNode(json, clazz),
      hintText: Hierarchy._pick<string | null>(json, ['hintText'], null),
      error: Hierarchy._pick<string | null>(json, ['error'], null),
      isSelected: Hierarchy._pick(json, ['isSelected', 'is_selected', 'is_checked'], false),
      children: [],
    });
  }

  /**
   * isImage is NOT a pure alias chain: the explicit isImage flag is combined
   * (with truthiness `||`, matching the original expression) with a check for
   * image-like widget class names.
   */
  private static _isImageNode(
    json: Record<string, unknown>,
    clazz: string | null,
  ): boolean {
    return (
      Hierarchy._pick(json, ['isImage'], false) ||
      (clazz?.includes('ImageView') ?? false) ||
      (clazz?.includes('ImageButton') ?? false) ||
      (clazz?.includes('SvgView') ?? false)
    );
  }

  /**
   * First-present-key-wins lookup over a JSON record — the function form of
   * the `??` alias chains this file used to repeat per field.
   *
   * Preserves `??` semantics EXACTLY: a key is "present" when its value is not
   * null/undefined, so falsy-but-present values (`''`, `false`, `0`) win their
   * spot in the chain. This must never become a truthiness check —
   * `isScrollable: false` and `text: ''` in the payload are kept, not replaced
   * by a later alias or the fallback.
   *
   * NOTE (deliberate, matches the original chains byte-for-byte in behaviour):
   * the value is returned through a lying `as T` cast with no runtime type
   * validation — e.g. a number-valued `text` comes back typed as string. Same
   * defect class as SimctlClient._trimmed (fixed in #164); fixing it here
   * would change behaviour on malformed payloads and is deferred as follow-up.
   */
  private static _pick<T>(
    json: Record<string, unknown>,
    keys: readonly string[],
    fallback: T,
  ): T {
    for (const key of keys) {
      const value = json[key];
      if (value !== null && value !== undefined) {
        return value as T;
      }
    }
    return fallback;
  }

  private static _parseBounds(
    rawBounds: unknown,
  ): [number, number, number, number] | null {
    if (Array.isArray(rawBounds) && rawBounds.length === 4) {
      return [
        Number(rawBounds[0]),
        Number(rawBounds[1]),
        Number(rawBounds[2]),
        Number(rawBounds[3]),
      ];
    }

    if (
      rawBounds &&
      typeof rawBounds === 'object' &&
      'left' in rawBounds &&
      'top' in rawBounds &&
      'right' in rawBounds &&
      'bottom' in rawBounds
    ) {
      const bounds = rawBounds as Record<string, unknown>;
      return [
        Number(bounds['left']),
        Number(bounds['top']),
        Number(bounds['right']),
        Number(bounds['bottom']),
      ];
    }

    return null;
  }
}
