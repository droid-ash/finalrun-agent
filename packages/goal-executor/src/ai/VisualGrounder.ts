// VisualGrounder.ts — NEW file, not in Dart codebase.
// Fallback when grounder returns needsVisualGrounding: true.
// Re-calls the LLM with only the screenshot to get x,y coordinates.

import { Logger } from '@finalrun/common';
import type { AIAgent } from './AIAgent.js';
import { FEATURE_VISUAL_GROUNDER } from '@finalrun/common';
import type { LLMTrace, LLMCallTrace } from '../trace.js';
import { FatalProviderError } from './providerFailure.js';

export interface VisualGroundingResult {
  success: boolean;
  x?: number;
  y?: number;
  reason?: string;
  trace?: LLMTrace;
  /** LLM call trace from the visual grounding attempt. */
  llmCall?: LLMCallTrace;
}

/**
 * Fallback visual grounder — called when the text-based grounder
 * returns `needsVisualGrounding: true` (element visible in screenshot
 * but not in hierarchy).
 *
 * Makes one attempt to find coordinates by asking the LLM
 * to visually locate the element using only the screenshot (no hierarchy).
 */
export class VisualGrounder {
  private _aiAgent: AIAgent;

  constructor(aiAgent: AIAgent) {
    this._aiAgent = aiAgent;
  }

  /**
   * Attempt to visually ground an element from the screenshot alone.
   * One attempt only — if it fails, returns success: false.
   */
  async ground(params: {
    act: string;
    screenshot: string; // base64
    platform: string;
    traceStep?: number;
    logContext?: string;
  }): Promise<VisualGroundingResult> {
    try {
      Logger.i('Attempting visual grounding fallback (no hierarchy)...');

      const response = await this._aiAgent.ground({
        feature: FEATURE_VISUAL_GROUNDER,
        act: params.act,
        screenshot: params.screenshot,
        platform: params.platform,
        traceStep: params.traceStep,
        tracePhase: 'action.visual_fallback',
        logContext: params.logContext,
      });

      const output = response.output;

      if (typeof output['x'] === 'number' && typeof output['y'] === 'number') {
        Logger.i(
          `Visual grounding succeeded: (${output['x']}, ${output['y']}) — ${output['reason']}`,
        );
        return {
          success: true,
          x: output['x'] as number,
          y: output['y'] as number,
          reason: output['reason'] as string,
          trace: response.trace,
          ...(response.llmCall ? { llmCall: response.llmCall } : {}),
        };
      }

      if (output['isError']) {
        Logger.w(`Visual grounding failed: ${output['reason']}`);
        return {
          success: false,
          reason: output['reason'] as string,
          trace: response.trace,
          ...(response.llmCall ? { llmCall: response.llmCall } : {}),
        };
      }

      Logger.w('Visual grounding returned unexpected format');
      return {
        success: false,
        reason: 'Unexpected response format',
        trace: response.trace,
        ...(response.llmCall ? { llmCall: response.llmCall } : {}),
      };
    } catch (error) {
      if (FatalProviderError.isInstance(error)) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      Logger.e('Visual grounding error:', error);
      return { success: false, reason: message };
    }
  }
}
