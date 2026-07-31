// Port of goal_executor/lib/src/GrounderResponseConverter.dart
// Converts grounder AI response into coordinates or scroll actions.

import { Point, ScrollAbsAction, Logger } from '@finalrun/common';
import type { HierarchyNode } from '@finalrun/common';

/**
 * Result wrapper for conversion operations.
 */
export class ConversionResult<T> {
  readonly success: boolean;
  readonly data: T | null;
  readonly error: string | null;

  private constructor(success: boolean, data: T | null, error: string | null) {
    this.success = success;
    this.data = data;
    this.error = error;
  }

  static ok<T>(data: T): ConversionResult<T> {
    return new ConversionResult(true, data, null);
  }

  static fail<T>(error: string): ConversionResult<T> {
    return new ConversionResult<T>(false, null, error);
  }
}

/**
 * Converts AI grounder responses into actionable coordinates or scroll actions.
 *
 * Dart equivalent: GrounderResponseConverter in goal_executor/lib/src/GrounderResponseConverter.dart
 */
export class GrounderResponseConverter {
  /**
   * Extract a Point from the grounder response.
   * Handles:
   *   - {index: N} → look up center of Nth element
   *   - {x: N, y: N} → direct coordinates
   *   - {index: null} → already focused (for input-focus grounder)
   *
   * Dart: static ConversionResult<Point> extractPoint(...)
   */
  static extractPoint(params: {
    output: Record<string, unknown>;
    flattenedHierarchy: HierarchyNode[];
    screenWidth: number;
    screenHeight: number;
  }): ConversionResult<Point | null> {
    const { output, flattenedHierarchy, screenWidth, screenHeight } = params;

    if (output['isError'] === true) {
      return ConversionResult.fail(
        (output['reason'] as string) ?? 'Grounder returned error',
      );
    }

    if (output['needsVisualGrounding'] === true) {
      return ConversionResult.fail('needsVisualGrounding');
    }

    // Case: index is explicitly null/undefined → already focused (no tap needed)
    if (
      Object.prototype.hasOwnProperty.call(output, 'index') &&
      (output['index'] === null || output['index'] === undefined)
    ) {
      if (output['reason']) {
        Logger.d(`Element already focused: ${output['reason']}`);
      }
      return ConversionResult.ok(null); // null means "no action needed"
    }

    if (typeof output['x'] === 'number' && typeof output['y'] === 'number') {
      const x = Math.round(output['x'] as number);
      const y = Math.round(output['y'] as number);

      if (x < 0 || x >= screenWidth || y < 0 || y >= screenHeight) {
        return ConversionResult.fail(
          `Coordinates (${x}, ${y}) out of screen bounds (${screenWidth}x${screenHeight})`,
        );
      }

      return ConversionResult.ok(new Point({ x, y }));
    }

    if (typeof output['index'] === 'number') {
      const index = output['index'] as number;

      if (index < 0 || index >= flattenedHierarchy.length) {
        return ConversionResult.fail(
          `Element index ${index} out of range (0-${flattenedHierarchy.length - 1})`,
        );
      }

      const node = flattenedHierarchy[index];
      const center = node.getCenterPoint();

      if (!center) {
        return ConversionResult.fail(
          `Element at index ${index} has no bounds`,
        );
      }

      return ConversionResult.ok(new Point({ x: center.x, y: center.y }));
    }

    return ConversionResult.fail(
      `Unexpected grounder response format: ${JSON.stringify(output)}`,
    );
  }

  /**
   * Extract a ScrollAbsAction from the scroll-index grounder response.
   * Response format: {startX, startY, endX, endY, duration}
   *
   * Dart: static ConversionResult<ScrollAbsAction> extractScrollAction(...)
   */
  static extractScrollAction(params: {
    output: Record<string, unknown>;
    screenWidth: number;
    screenHeight: number;
  }): ConversionResult<ScrollAbsAction> {
    const { output, screenWidth, screenHeight } = params;

    if (output['isError'] === true) {
      return ConversionResult.fail(
        (output['reason'] as string) ?? 'Scroll grounder returned error',
      );
    }

    const startX = output['startX'] ?? output['start_x'];
    const startY = output['startY'] ?? output['start_y'];
    const endX = output['endX'] ?? output['end_x'];
    const endY = output['endY'] ?? output['end_y'];
    const durationMs = (output['duration'] as number) ?? (output['durationMs'] as number) ?? 500;

    if (
      typeof startX !== 'number' ||
      typeof startY !== 'number' ||
      typeof endX !== 'number' ||
      typeof endY !== 'number'
    ) {
      return ConversionResult.fail(
        `Invalid scroll coordinates: ${JSON.stringify(output)}`,
      );
    }

    const coords = [
      { name: 'startX', val: startX },
      { name: 'startY', val: startY },
      { name: 'endX', val: endX },
      { name: 'endY', val: endY },
    ];
    for (const { name, val } of coords) {
      const maxVal = name.includes('X') ? screenWidth : screenHeight;
      if (val < 0 || val >= maxVal) {
        return ConversionResult.fail(
          `${name}=${val} out of screen bounds (max ${maxVal})`,
        );
      }
    }

    return ConversionResult.ok(
      new ScrollAbsAction({
        startX: Math.round(startX as number),
        startY: Math.round(startY as number),
        endX: Math.round(endX as number),
        endY: Math.round(endY as number),
        durationMs: Math.round(durationMs),
      }),
    );
  }
}
