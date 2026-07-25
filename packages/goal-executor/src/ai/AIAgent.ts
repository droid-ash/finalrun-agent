// AIAgent.ts — Replaces FinalRunAgent.dart
// Uses Vercel AI SDK for direct LLM calls instead of backend API.
// Dart: FinalRunAgent → TypeScript: AIAgent

import { generateText, Output } from 'ai';
import {
  createOpenAI,
  type OpenAILanguageModelResponsesOptions,
} from '@ai-sdk/openai';
import {
  createGoogleGenerativeAI,
  type GoogleLanguageModelOptions,
} from '@ai-sdk/google';
import {
  createAnthropic,
  type AnthropicLanguageModelOptions,
} from '@ai-sdk/anthropic';
import * as fs from 'fs';
import * as path from 'path';
import { performance } from 'node:perf_hooks';
import {
  Logger,
  Hierarchy,
  FEATURE_PLANNER,
  FEATURE_GROUNDER,
  FEATURE_VISUAL_GROUNDER,
  FEATURE_SCROLL_INDEX_GROUNDER,
  FEATURE_INPUT_FOCUS_GROUNDER,
  FEATURE_LAUNCH_APP_GROUNDER,
  FEATURE_SET_LOCATION_GROUNDER,
  PLANNER_ACTION_TAP,
  PLANNER_ACTION_LONG_PRESS,
  PLANNER_ACTION_TYPE,
  PLANNER_ACTION_SCROLL,
  PLANNER_ACTION_BACK,
  PLANNER_ACTION_HOME,
  PLANNER_ACTION_ROTATE,
  PLANNER_ACTION_HIDE_KEYBOARD,
  PLANNER_ACTION_PRESS_ENTER,
  PLANNER_ACTION_LAUNCH_APP,
  PLANNER_ACTION_SET_LOCATION,
  PLANNER_ACTION_WAIT,
  PLANNER_ACTION_COMPLETED,
  PLANNER_ACTION_FAILED,
  PLANNER_ACTION_DEEPLINK,
  parseModel,
  type FeatureName,
  type FeatureOverrides,
  type ModelDefaults,
  type ReasoningLevel,
} from '@finalrun/common';
import {
  describeLLMTrace,
  finishTracePhase,
  formatPlannerReasoning,
  formatGrounderRequest,
  formatGrounderResult,
  roundDuration,
  startTracePhase,
  type LLMTrace,
  type LLMCallTrace,
} from '../trace.js';
import { classifyFatalProviderError, FatalProviderError } from './providerFailure.js';
import { schemaForFeature } from './schemas.js';

// ============================================================================
// Types
// ============================================================================

export interface PlannerRequest {
  testObjective: string;
  platform: string;
  preActionScreenshot?: string; // base64
  postActionScreenshot?: string; // base64
  hierarchy?: Hierarchy;
  history?: string;
  remember?: string[];
  preContext?: string;
  appKnowledge?: string;
  postActionHierarchy?: Hierarchy;
  traceStep?: number;
  /**
   * Free-form label used only for logging (e.g. "primary(Pixel_10) step=3").
   * Helps distinguish which device/step a plan call belongs to in multi-device runs.
   */
  logContext?: string;
}

export interface PlannerResponse {
  act: string;
  reason: string;
  remember: string[];
  text?: string;
  clearText?: boolean;
  direction?: string;
  durationSeconds?: number;
  url?: string;
  result?: string;
  analysis?: string;
  severity?: string;
  repeat?: number;
  delayBetweenTapMs?: number;
  thought?: {
    plan?: string;
    think?: string;
    act?: string;
  };
  trace?: LLMTrace;
  /** Raw LLM call trace captured during planning — forwarded to observability. */
  llmCall?: LLMCallTrace;
}

export interface GrounderRequest {
  feature: FeatureName;
  act: string;
  hierarchy?: Hierarchy;
  screenshot?: string; // base64
  platform?: string;
  availableApps?: Array<{ packageName: string; name: string }>;
  traceStep?: number;
  tracePhase?: string;
  /**
   * Free-form label used only for logging (e.g. "primary(Pixel_10) step=3").
   */
  logContext?: string;
}

export interface GrounderResponse {
  output: Record<string, unknown>;
  raw: string; // Raw LLM response for debugging
  trace?: LLMTrace;
  /** Raw LLM call trace captured during grounding — forwarded to observability. */
  llmCall?: LLMCallTrace;
}

type JsonRecord = Record<string, unknown>;
type LLMPhase = 'planner' | 'grounder';
/**
 * Provider-specific options, keyed by provider id.
 *
 * Each value is validated against its real SDK option type via `satisfies` in
 * `_getProviderOptions`, so option names and value types stay checked. The
 * container is deliberately NOT typed as the SDK's `SharedV3ProviderOptions`
 * (`Record<string, JSONObject>`): the provider option types are not themselves
 * assignable to `JSONObject`, because some of their fields are declared with
 * `unknown` — e.g. `@ai-sdk/anthropic`'s `fallbacks[].thinking` is
 * `Record<string, unknown>`, and `unknown` is not a `JSONValue`. See the cast
 * at the `generateText` call site.
 */
type AIAgentProviderOptions = {
  google?: GoogleLanguageModelOptions;
  openai?: OpenAILanguageModelResponsesOptions;
  anthropic?: AnthropicLanguageModelOptions;
};

/**
 * The `providerOptions` parameter type accepted by `generateText`, derived from
 * the function itself so we don't import from the transitive `@ai-sdk/provider`.
 */
type SdkProviderOptions = NonNullable<Parameters<typeof generateText>[0]>['providerOptions'];

interface ResolvedFeatureConfig {
  provider: string;
  modelName: string;
  reasoning: ReasoningLevel;
}

/** Fallback reasoning levels used when neither feature override nor workspace default is set. */
const DEFAULT_REASONING_BY_PHASE: Record<LLMPhase, ReasoningLevel> = {
  planner: 'medium',
  grounder: 'low',
};

/** Map a feature to its phase (controls token budget + default reasoning). */
function phaseForFeature(feature: FeatureName): LLMPhase {
  return feature === FEATURE_PLANNER ? 'planner' : 'grounder';
}

const MAX_LLM_ATTEMPTS = 2;

// ============================================================================
// AIAgent
// ============================================================================

/**
 * Handles all AI interactions — planning and grounding.
 * Replaces FinalRunAgent.dart, calling LLMs directly via Vercel AI SDK.
 *
 * Dart equivalent: FinalRunAgent in goal_executor/lib/src/FinalRunAgent.dart
 */
export class AIAgent {
  private _apiKeys: Record<string, string>;
  private _defaults: ModelDefaults;
  private _features: FeatureOverrides;

  // Cached prompt contents
  private _promptCache: Map<string, string> = new Map();
  // Cached Vercel AI SDK clients, keyed by provider
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _clientCache: Map<string, any> = new Map();

  constructor(params: {
    apiKeys: Record<string, string>;
    defaults: ModelDefaults;
    features?: FeatureOverrides;
  }) {
    this._apiKeys = params.apiKeys;
    this._defaults = params.defaults;
    this._features = params.features ?? {};
  }

  /**
   * Call the AI planner to decide the next action.
   *
   * Dart: Future<Map<String, dynamic>> plan(...)
   */
  async plan(request: PlannerRequest): Promise<PlannerResponse> {
    const promptBuildStartedAt = performance.now();
    const systemPrompt = this._loadPrompt('planner');

    const userParts: Array<{ type: 'text'; text: string } | { type: 'image'; image: string }> = [];

    if (request.preActionScreenshot) {
      userParts.push({ type: 'image', image: request.preActionScreenshot });
    }

    let textPrompt = `Test objective: ${request.testObjective}\n`;
    textPrompt += `Platform: ${request.platform}\n`;

    if (request.history) {
      textPrompt += `\nHistory of actions taken so far:\n${request.history}\n`;
    }

    if (request.remember && request.remember.length > 0) {
      textPrompt += `\nImportant context to remember:\n${JSON.stringify(request.remember)}\n`;
    }

    if (request.preContext) {
      textPrompt += `\nPre-context:\n${request.preContext}\n`;
    }

    if (request.appKnowledge) {
      textPrompt += `\nApp knowledge:\n${request.appKnowledge}\n`;
    }

    if (request.hierarchy) {
      const elements = request.hierarchy.toPromptElementsForPlanner(request.platform);
      textPrompt += `\nui_elements:\n${JSON.stringify(elements)}\n`;
    }

    if (request.postActionScreenshot) {
      userParts.push({ type: 'image', image: request.postActionScreenshot });
    }

    if (request.postActionHierarchy) {
      const postElements = request.postActionHierarchy.toPromptElementsForPlanner(request.platform);
      textPrompt += `\nPost-action ui_elements:\n${JSON.stringify(postElements)}\n`;
    }

    userParts.push({ type: 'text', text: textPrompt });

    const promptBuildMs = roundDuration(performance.now() - promptBuildStartedAt);

    // Input visibility: one INFO summary line + one DEBUG detail blob per plan call.
    Logger.i(this._summarizePlannerRequest(request));
    Logger.d(this._detailPlannerRequest(request, textPrompt));

    const maxAttempts = MAX_LLM_ATTEMPTS;
    let lastError: unknown;
    let parsedResponse: PlannerResponse | undefined;
    let llmMs = 0;
    let parseMs = 0;
    let lastLLMCall: LLMCallTrace | undefined;

    const plannerResolved = this._resolveFeatureConfig(FEATURE_PLANNER);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const llmPhase = startTracePhase(
        request.traceStep,
        'planning.llm',
        `provider=${plannerResolved.provider} model=${plannerResolved.modelName} attempt=${attempt}/${maxAttempts}`,
      );
      const llmStartedAt = performance.now();

      let rawOutput: unknown;
      let rawText: string;
      try {
        const llmResult = await this._callLLM(systemPrompt, userParts, FEATURE_PLANNER);
        rawOutput = llmResult.output;
        rawText = llmResult.text;
        lastLLMCall = llmResult.llmCall;
      } catch (error) {
        finishTracePhase(
          llmPhase,
          'failure',
          error instanceof Error ? error.message : String(error),
        );
        if (FatalProviderError.isInstance(error)) {
          throw error;
        }
        lastError = error;
        if (attempt < maxAttempts) {
          Logger.w(
            `Planner attempt ${attempt}/${maxAttempts} failed (llm), retrying: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          continue;
        }
        throw error;
      }

      llmMs = roundDuration(performance.now() - llmStartedAt);
      finishTracePhase(
        llmPhase,
        'success',
        describeLLMTrace({ promptBuildMs, llmMs }),
      );

      const parsePhase = startTracePhase(
        request.traceStep,
        'planning.parse',
        `attempt=${attempt}/${maxAttempts}`,
      );
      const parseStartedAt = performance.now();
      try {
        parsedResponse = this._parsePlannerResponse(rawOutput, rawText);
        parseMs = roundDuration(performance.now() - parseStartedAt);
        finishTracePhase(parsePhase, 'success');
        break;
      } catch (error) {
        finishTracePhase(
          parsePhase,
          'failure',
          error instanceof Error ? error.message : String(error),
        );
        lastError = error;
        if (attempt < maxAttempts) {
          Logger.w(
            `Planner attempt ${attempt}/${maxAttempts} failed (parse), retrying: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          continue;
        }
        throw error;
      }
    }

    if (!parsedResponse) {
      throw lastError ?? new Error('Planner failed after all retry attempts');
    }

    if (request.traceStep !== undefined) {
      Logger.i(formatPlannerReasoning({
        step: request.traceStep,
        thought: parsedResponse.thought,
        action: parsedResponse.act,
        reason: parsedResponse.reason,
      }));
    }

    return {
      ...parsedResponse,
      trace: {
        totalMs: promptBuildMs + llmMs + parseMs,
        promptBuildMs,
        llmMs,
        parseMs,
      },
      ...(lastLLMCall ? { llmCall: lastLLMCall } : {}),
    };
  }

  /**
   * Call the AI grounder to find an element on screen.
   *
   * Dart: Future<Map<String, dynamic>> ground(...)
   */
  async ground(request: GrounderRequest): Promise<GrounderResponse> {
    if (request.traceStep !== undefined) {
      Logger.i(formatGrounderRequest({
        step: request.traceStep,
        feature: request.feature,
        act: request.act,
      }));
    }

    const phaseName = request.tracePhase ?? 'action.ground';
    const promptBuildStartedAt = performance.now();
    const promptKey = this._getPromptKeyForFeature(request.feature);
    const systemPrompt = this._loadPrompt(promptKey);

    const userParts: Array<{ type: 'text'; text: string } | { type: 'image'; image: string }> = [];

    if (request.screenshot) {
      userParts.push({ type: 'image', image: request.screenshot });
    }

    let text = `act: ${request.act}\n`;

    if (request.platform) {
      text += `platform: ${request.platform}\n`;
    }

    if (request.hierarchy) {
      const elements = request.hierarchy.toPromptElementsForGrounder(request.platform);
      text += `\nui_elements:\n${JSON.stringify(elements)}\n`;
    }

    if (request.availableApps) {
      text += `\navailable_apps:\n${JSON.stringify(request.availableApps)}\n`;
    }

    userParts.push({ type: 'text', text });

    const promptBuildMs = roundDuration(performance.now() - promptBuildStartedAt);

    // Input visibility: one INFO summary line + one DEBUG detail blob per grounder call.
    Logger.i(this._summarizeGrounderRequest(request));
    Logger.d(this._detailGrounderRequest(request, text));

    const maxAttempts = MAX_LLM_ATTEMPTS;
    let lastError: unknown;
    let parsed: GrounderResponse | undefined;
    let llmMs = 0;
    let parseMs = 0;
    let lastLLMCall: LLMCallTrace | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const phase = startTracePhase(
        request.traceStep,
        phaseName,
        `feature=${request.feature} attempt=${attempt}/${maxAttempts}`,
      );
      const llmStartedAt = performance.now();

      let rawOutput: unknown;
      let rawText: string;
      try {
        const llmResult = await this._callLLM(
          systemPrompt,
          userParts,
          request.feature,
        );
        rawOutput = llmResult.output;
        rawText = llmResult.text;
        lastLLMCall = llmResult.llmCall;
      } catch (error) {
        finishTracePhase(
          phase,
          'failure',
          error instanceof Error ? error.message : String(error),
        );
        if (FatalProviderError.isInstance(error)) {
          throw error;
        }
        lastError = error;
        if (attempt < maxAttempts) {
          Logger.w(
            `Grounder attempt ${attempt}/${maxAttempts} failed (llm) for feature=${request.feature}, retrying: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          continue;
        }
        throw error;
      }

      llmMs = roundDuration(performance.now() - llmStartedAt);
      const parseStartedAt = performance.now();

      try {
        parsed = this._parseGrounderResponse(rawOutput, rawText);
        parseMs = roundDuration(performance.now() - parseStartedAt);
        finishTracePhase(
          phase,
          'success',
          describeLLMTrace({
            promptBuildMs,
            llmMs,
            parseMs,
            extraDetail: `feature=${request.feature}`,
          }),
        );
        break;
      } catch (error) {
        finishTracePhase(
          phase,
          'failure',
          error instanceof Error ? error.message : String(error),
        );
        lastError = error;
        if (attempt < maxAttempts) {
          Logger.w(
            `Grounder attempt ${attempt}/${maxAttempts} failed (parse) for feature=${request.feature}, retrying: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          continue;
        }
        throw error;
      }
    }

    if (!parsed) {
      throw lastError ?? new Error('Grounder failed after all retry attempts');
    }

    if (request.traceStep !== undefined) {
      let bounds: [number, number, number, number] | null = null;
      const idx = parsed.output['index'];
      if (typeof idx === 'number' && request.hierarchy) {
        const node = request.hierarchy.flattenedHierarchy[idx];
        bounds = node?.bounds ?? null;
      }
      Logger.i(formatGrounderResult({
        step: request.traceStep,
        output: parsed.output,
        bounds,
      }));
    }

    return {
      ...parsed,
      trace: {
        totalMs: promptBuildMs + llmMs + parseMs,
        promptBuildMs,
        llmMs,
        parseMs,
      },
      ...(lastLLMCall ? { llmCall: lastLLMCall } : {}),
    };
  }

  // ---------- private ----------

  /**
   * Call an LLM via Vercel AI SDK. Uses Output.json() so the provider emits
   * strict JSON (Google response_mime_type, OpenAI response_format, Anthropic
   * structuredOutputMode), matching the Kotlin backend's behavior.
   */
  private async _callLLM(
    systemPrompt: string,
    userParts: Array<{ type: 'text'; text: string } | { type: 'image'; image: string }>,
    feature: FeatureName,
  ): Promise<{ output: unknown; text: string; llmCall: LLMCallTrace }> {
    const resolved = this._resolveFeatureConfig(feature);
    const model = this._getModel(resolved);
    const providerOptions = this._getProviderOptions(resolved, feature);
    const phase = phaseForFeature(feature);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userContent: any[] = userParts.map((part) => {
      if (part.type === 'image') {
        return { type: 'image' as const, image: part.image };
      }
      return { type: 'text' as const, text: part.text };
    });

    // Persist the exact messages we send so we can forward them verbatim to
    // observability backends (Langfuse stores these for debugging).
    const messages = [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user' as const, content: userContent },
    ];

    const startedAt = new Date().toISOString();
    const startPerfMs = performance.now();

    let output: unknown;
    let text = '';
    let reasoningText: string | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let usage: any;
    let thrownError: unknown;
    try {
      const result = await generateText({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        // Anthropic has no schema-less JSON mode — the @ai-sdk/anthropic
        // adapter drops responseFormat silently without a schema, letting
        // Claude free-write multiple candidate JSONs. Passing a schema routes
        // the call through Anthropic's tool-use API for enforced structured
        // output. OpenAI and Google keep their working schema-less paths.
        output:
          resolved.provider === 'anthropic'
            ? Output.object({ schema: schemaForFeature(feature) })
            : Output.json(),
        maxOutputTokens: phase === 'planner' ? 8192 : 4096,
        // The SDK wants `Record<string, JSONObject>`, but its own provider
        // option types aren't assignable to `JSONObject` (they carry `unknown`
        // -typed fields — see AIAgentProviderOptions). Everything we build here
        // is plain JSON, and each provider's options are `satisfies`-checked in
        // `_getProviderOptions`, so widening at this one boundary is sound.
        providerOptions: providerOptions as SdkProviderOptions,
      });
      output = result.output;
      text = result.text;
      reasoningText = result.reasoningText;
      usage = result.usage;
    } catch (error) {
      thrownError = error;
    }

    const completedAt = new Date().toISOString();
    const durationMs = roundDuration(performance.now() - startPerfMs);

    const llmCall: LLMCallTrace = {
      provider: resolved.provider,
      model: resolved.modelName,
      feature: feature ?? phase,
      prompt: messages,
      completion: text,
      usage: normalizeUsage(usage),
      startedAt,
      completedAt,
      durationMs,
      ...(thrownError
        ? { statusMessage: thrownError instanceof Error ? thrownError.message : String(thrownError) }
        : {}),
    };

    if (thrownError) {
      throw (
        classifyFatalProviderError(thrownError, {
          provider: resolved.provider,
          modelName: resolved.modelName,
        }) ?? thrownError
      );
    }

    if (reasoningText) {
      Logger.d(
        `LLM reasoning [${feature}] (${resolved.provider}/${resolved.modelName}):\n${reasoningText}`,
      );
    }

    Logger.d(
      `LLM response [${feature}] (${resolved.provider}/${resolved.modelName}):\n${text || '<empty response>'}`,
    );
    return { output, text, llmCall };
  }


  /**
   * Resolve the effective provider / model / reasoning for a feature by
   * merging the optional per-feature override on top of workspace defaults.
   */
  private _resolveFeatureConfig(feature: FeatureName): ResolvedFeatureConfig {
    const override = this._features[feature];
    let provider = this._defaults.provider;
    let modelName = this._defaults.modelName;
    if (override?.model) {
      // Reuse the shared parser so per-feature overrides fail with the same
      // validation errors (empty provider/model, unsupported provider) as
      // workspace-level `model:` and the `--model` CLI flag.
      const parsed = parseModel(override.model, `features.${feature}.model`);
      provider = parsed.provider;
      modelName = parsed.modelName;
    }
    const reasoning: ReasoningLevel =
      override?.reasoning ?? this._defaults.reasoning ?? DEFAULT_REASONING_BY_PHASE[phaseForFeature(feature)];
    return { provider, modelName, reasoning };
  }

  /**
   * Create (or reuse a cached) Vercel AI SDK model instance for the
   * resolved provider/modelName.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _getModel(resolved: ResolvedFeatureConfig): any {
    const cacheKey = `${resolved.provider}/${resolved.modelName}`;
    const cached = this._clientCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const apiKey = this._apiKeys[resolved.provider];
    if (!apiKey) {
      throw new Error(
        `Missing API key for provider "${resolved.provider}". Set the corresponding env var (e.g. OPENAI_API_KEY, GOOGLE_API_KEY, ANTHROPIC_API_KEY).`,
      );
    }
    let client: unknown;
    switch (resolved.provider) {
      case 'openai': {
        const openai = createOpenAI({ apiKey });
        // Use the Responses API (not Chat Completions) so that
        // `providerOptions.openai.reasoningEffort` is honored by reasoning
        // models like gpt-5.4-mini. `openai(modelId)` defaults to Chat
        // Completions and silently ignores reasoning effort.
        client = openai.responses(resolved.modelName);
        break;
      }
      case 'google': {
        const google = createGoogleGenerativeAI({ apiKey });
        client = google(resolved.modelName);
        break;
      }
      case 'anthropic': {
        const anthropic = createAnthropic({ apiKey });
        client = anthropic(resolved.modelName);
        break;
      }
      default:
        throw new Error(`Unsupported AI provider: ${resolved.provider}`);
    }
    this._clientCache.set(cacheKey, client);
    return client;
  }

  private _getProviderOptions(
    resolved: ResolvedFeatureConfig,
    feature: FeatureName,
  ): AIAgentProviderOptions | undefined {
    const { provider, reasoning } = resolved;
    if (reasoning === 'minimal' && provider !== 'openai') {
      throw new Error(
        `Reasoning level "minimal" is only supported for OpenAI. Feature "${feature}" is configured for provider "${provider}".`,
      );
    }
    switch (provider) {
      case 'google': {
        return {
          google: {
            thinkingConfig: {
              thinkingLevel: reasoning as 'low' | 'medium' | 'high',
              includeThoughts: false,
            },
          } satisfies GoogleLanguageModelOptions,
        };
      }
      case 'openai':
        return {
          openai: {
            reasoningEffort: reasoning,
          } satisfies OpenAILanguageModelResponsesOptions,
        };
      case 'anthropic':
        return {
          anthropic: {
            effort: reasoning as 'low' | 'medium' | 'high',
            // Force Anthropic's native structured-output API
            // (`output_config.format`). The SDK's `auto` mode falls back to a
            // `json` tool wrapper when its hardcoded model-capability table
            // doesn't recognize the model — but that table lags behind new
            // releases (e.g. Opus 4.7 isn't listed even though it supports
            // structured output). Pinning `outputFormat` makes us forward-
            // compatible with every Claude 4.5+ model without any
            // model-version checks on our side.
            structuredOutputMode: 'outputFormat',
          } satisfies AnthropicLanguageModelOptions,
        };
      default:
        return undefined;
    }
  }

  /**
   * Load a system prompt from the bundled .md files.
   */
  private _loadPrompt(key: string): string {
    if (this._promptCache.has(key)) {
      return this._promptCache.get(key)!;
    }

    const candidates = [
      process.env['FINALRUN_PROMPTS_DIR']
        ? path.resolve(process.env['FINALRUN_PROMPTS_DIR'], `${key}.md`)
        : undefined,
      path.resolve(__dirname, `../prompts/${key}.md`),
      path.resolve(__dirname, `../../src/prompts/${key}.md`),
      path.resolve(__dirname, `../../../src/prompts/${key}.md`),
    ].filter((candidate): candidate is string => Boolean(candidate));

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        const content = fs.readFileSync(candidate, 'utf-8');
        this._promptCache.set(key, content);
        return content;
      }
    }

    throw new Error(`Prompt file not found for key "${key}". Searched: ${candidates.join(', ')}`);
  }

  /**
   * Map feature name to prompt file name.
   */
  private _getPromptKeyForFeature(feature: string): string {
    switch (feature) {
      case FEATURE_GROUNDER:
        return 'grounder';
      case FEATURE_VISUAL_GROUNDER:
        return 'visual-grounder';
      case FEATURE_SCROLL_INDEX_GROUNDER:
        return 'scroll-grounder';
      case FEATURE_INPUT_FOCUS_GROUNDER:
        return 'input-focus-grounder';
      case FEATURE_LAUNCH_APP_GROUNDER:
        return 'launch-app-grounder';
      case FEATURE_SET_LOCATION_GROUNDER:
        return 'set-location-grounder';
      case FEATURE_PLANNER:
        return 'planner';
      default:
        return 'grounder';
    }
  }

  /**
   * Parse the planner LLM response into PlannerResponse. The SDK has already
   * parsed the JSON via Output.json(), so we just normalize the shape.
   */
  private _parsePlannerResponse(output: unknown, rawText: string): PlannerResponse {
    const record = asRecord(output);
    if (!record) {
      throw new Error(
        `Planner response is not a JSON object: ${rawText.substring(0, 200)}`,
      );
    }

    const normalized = normalizePlannerResponse(record);
    if (!normalized.act) {
      throw new Error(
        `Planner response missing actionable action_type: ${rawText.substring(0, 300)}`,
      );
    }

    return normalized;
  }

  /**
   * Parse the grounder LLM response into GrounderResponse. The SDK has already
   * parsed the JSON via Output.json(), so we just unwrap the `output` key when
   * present.
   */
  private _parseGrounderResponse(output: unknown, rawText: string): GrounderResponse {
    const record = asRecord(output);
    if (!record) {
      throw new Error(
        `Grounder response is not a JSON object: ${rawText.substring(0, 200)}`,
      );
    }

    const grounderOutput = asRecord(record['output']) ?? record;
    return { output: grounderOutput, raw: rawText };
  }

  // ---------- Input visibility logging ----------

  private _summarizePlannerRequest(req: PlannerRequest): string {
    const parts: string[] = ['[AI plan]'];
    parts.push(this._formatLogContext(req.logContext, req.traceStep));
    const plannerResolved = this._resolveFeatureConfig(FEATURE_PLANNER);
    parts.push(`provider=${plannerResolved.provider}/${plannerResolved.modelName}`);
    parts.push(this._screenshotMetric('screenshot', req.preActionScreenshot));
    if (req.postActionScreenshot) {
      parts.push(this._screenshotMetric('postScreenshot', req.postActionScreenshot));
    }
    const hierarchyCount = req.hierarchy
      ? req.hierarchy.toPromptElementsForPlanner(req.platform).length
      : 0;
    parts.push(`hierarchy=${hierarchyCount}`);
    parts.push(`history=${this._countHistoryLines(req.history)}`);
    parts.push(`remember=${req.remember?.length ?? 0}`);
    parts.push(`preContext=${req.preContext ? 'yes' : 'no'}`);
    parts.push(`appKnowledge=${req.appKnowledge ? 'yes' : 'no'}`);
    parts.push(`goal=${req.testObjective.length}ch`);
    return parts.join(' ');
  }

  private _summarizeGrounderRequest(req: GrounderRequest): string {
    const parts: string[] = ['[AI ground]'];
    parts.push(this._formatLogContext(req.logContext, req.traceStep));
    const grounderResolved = this._resolveFeatureConfig(req.feature);
    parts.push(`provider=${grounderResolved.provider}/${grounderResolved.modelName}`);
    parts.push(`feature=${req.feature}`);
    parts.push(this._screenshotMetric('screenshot', req.screenshot));
    const hierarchyCount = req.hierarchy
      ? req.hierarchy.toPromptElementsForGrounder(req.platform).length
      : 0;
    parts.push(`hierarchy=${hierarchyCount}`);
    const actSnippet = req.act.length > 80 ? `${req.act.slice(0, 80)}…` : req.act;
    parts.push(`act="${actSnippet}"`);
    return parts.join(' ');
  }

  private _detailPlannerRequest(req: PlannerRequest, prompt: string): string {
    const payload = {
      logContext: req.logContext,
      platform: req.platform,
      goal: req.testObjective,
      screenshot: req.preActionScreenshot
        ? `<base64 ${req.preActionScreenshot.length} chars>`
        : null,
      postScreenshot: req.postActionScreenshot
        ? `<base64 ${req.postActionScreenshot.length} chars>`
        : null,
      hierarchy: req.hierarchy
        ? {
            count: req.hierarchy.toPromptElementsForPlanner(req.platform).length,
            firstFew: req.hierarchy
              .toPromptElementsForPlanner(req.platform)
              .slice(0, 3),
          }
        : null,
      history: req.history ? req.history.split('\n').filter(Boolean) : [],
      remember: req.remember ?? [],
      preContext: req.preContext ?? null,
      appKnowledge: req.appKnowledge ?? null,
      promptLength: prompt.length,
    };
    return `[AI plan detail] ${this._formatLogContext(req.logContext, req.traceStep)} ${JSON.stringify(payload, null, 2)}`;
  }

  private _detailGrounderRequest(req: GrounderRequest, prompt: string): string {
    const payload = {
      logContext: req.logContext,
      feature: req.feature,
      platform: req.platform,
      act: req.act,
      screenshot: req.screenshot
        ? `<base64 ${req.screenshot.length} chars>`
        : null,
      hierarchy: req.hierarchy
        ? {
            count: req.hierarchy.toPromptElementsForGrounder(req.platform).length,
            firstFew: req.hierarchy
              .toPromptElementsForGrounder(req.platform)
              .slice(0, 3),
          }
        : null,
      availableApps: req.availableApps ?? null,
      promptLength: prompt.length,
    };
    return `[AI ground detail] ${this._formatLogContext(req.logContext, req.traceStep)} ${JSON.stringify(payload, null, 2)}`;
  }

  private _formatLogContext(
    logContext: string | undefined,
    traceStep: number | undefined,
  ): string {
    const ctx = logContext && logContext.length > 0 ? logContext : 'no-ctx';
    return traceStep !== undefined ? `ctx=${ctx} iter=${traceStep}` : `ctx=${ctx}`;
  }

  private _screenshotMetric(label: string, base64: string | undefined): string {
    if (!base64 || base64.length === 0) return `${label}=no`;
    // base64 → bytes: length * 3/4, rounded.
    const bytes = Math.round((base64.length * 3) / 4);
    const kb = Math.max(1, Math.round(bytes / 1024));
    return `${label}=${kb}KB`;
  }

  private _countHistoryLines(history: string | undefined): number {
    if (!history) return 0;
    return history.split('\n').filter((line) => line.trim().length > 0).length;
  }
}

function normalizePlannerResponse(json: JsonRecord): PlannerResponse {
  const output = asRecord(json['output']) ?? json;
  const thought = asRecord(output['thought']);
  const action =
    asRecord(output['action']) ??
    asRecord(json['action']) ??
    (normalizeString(output['action_type']) ? output : undefined) ??
    (normalizeString(json['action_type']) ? json : undefined);

  if (!action) {
    if (typeof json['act'] === 'string') {
      return {
        act: json['act'],
        reason: normalizeString(json['reason']) ?? '',
        remember: normalizeRemember(json['remember']),
      };
    }

    return {
      act: '',
      reason: '',
      remember: normalizeRemember(output['remember']),
    };
  }

  const normalizedAction = normalizePromptAction(
    normalizeString(action['action_type']) ?? '',
    action,
  );
  const thoughtAct = normalizeString(thought?.['act']);
  const isTerminalAction =
    normalizedAction.act === PLANNER_ACTION_COMPLETED ||
    normalizedAction.act === PLANNER_ACTION_FAILED;

  return {
    act: normalizedAction.act,
    reason: isTerminalAction
      ? normalizedAction.reason
      : firstNonEmpty(thoughtAct, normalizedAction.reason) ?? '',
    remember: normalizeRemember(output['remember']),
    text: normalizeString(action['text']),
    clearText: normalizeBoolean(action['clear_text']),
    direction: normalizeString(action['direction']),
    durationSeconds: normalizeNumber(action['duration']),
    url: normalizeString(action['url']),
    result: normalizeString(action['result']),
    analysis: normalizeString(action['analysis']),
    severity: normalizeString(action['severity']),
    repeat: normalizeNumber(action['repeat']),
    delayBetweenTapMs: normalizeNumber(
      action['delay_between_tap'] ?? action['delayBetweenTap'],
    ),
    thought: thought
      ? {
          plan: normalizeString(thought['plan']),
          think: normalizeString(thought['think']),
          act: thoughtAct,
        }
      : undefined,
  };
}

function normalizePromptAction(
  actionType: string,
  action: JsonRecord,
): { act: string; reason: string } {
  switch (actionType) {
    case 'tap':
      return { act: PLANNER_ACTION_TAP, reason: 'Tap the target element.' };
    case 'long_press':
      return { act: PLANNER_ACTION_LONG_PRESS, reason: 'Long press the target element.' };
    case 'input_text':
      return { act: PLANNER_ACTION_TYPE, reason: 'Type text into the target input field.' };
    case 'swipe':
      return {
        act: PLANNER_ACTION_SCROLL,
        reason: firstNonEmpty(
          normalizeString(action['act']),
          normalizeString(action['direction']) ? `Swipe ${normalizeString(action['direction'])}` : undefined,
          'Scroll the current view.',
        ) ?? 'Scroll the current view.',
      };
    case 'navigate_home':
      return { act: PLANNER_ACTION_HOME, reason: 'Navigate to the device home screen.' };
    case 'rotate':
      return { act: PLANNER_ACTION_ROTATE, reason: 'Rotate the device orientation.' };
    case 'navigate_back':
      return { act: PLANNER_ACTION_BACK, reason: 'Navigate back one screen.' };
    case 'hide_keyboard':
      return { act: PLANNER_ACTION_HIDE_KEYBOARD, reason: 'Hide the software keyboard.' };
    case 'keyboard_enter':
      return { act: PLANNER_ACTION_PRESS_ENTER, reason: 'Press the enter key.' };
    case 'wait':
      return { act: PLANNER_ACTION_WAIT, reason: 'Wait for the UI to stabilize.' };
    case 'deep_link':
      return { act: PLANNER_ACTION_DEEPLINK, reason: 'Open the deeplink URL.' };
    case 'set_location':
      return { act: PLANNER_ACTION_SET_LOCATION, reason: 'Set the device location.' };
    case 'launch_app':
      return { act: PLANNER_ACTION_LAUNCH_APP, reason: 'Launch the target app.' };
    case 'status': {
      const result = normalizeString(action['result'])?.toLowerCase();
      return {
        act: result === 'success' ? PLANNER_ACTION_COMPLETED : PLANNER_ACTION_FAILED,
        reason: firstNonEmpty(
          normalizeString(action['analysis']),
          normalizeString(action['result']),
          'Planner returned final status.',
        ) ?? 'Planner returned final status.',
      };
    }
    default:
      return {
        act: actionType,
        reason: `Planner returned unsupported action_type: ${actionType}`,
      };
  }
}

function asRecord(value: unknown): JsonRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as JsonRecord;
}

function normalizeRemember(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (typeof item === 'string') {
        return item.trim();
      }
      try {
        return JSON.stringify(item);
      } catch {
        return String(item);
      }
    })
    .filter((item): item is string => item.length > 0);
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

function normalizeBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  return undefined;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === 'string' && value.trim().length > 0);
}

/**
 * Convert the Vercel AI SDK's `LanguageModelUsage` (inputTokens/outputTokens
 * with nested *TokenDetails) into the Langfuse canonical shape
 * (input/output/total, optional input_cached_tokens only if > 0).
 * Fields default to 0 when the provider omits them.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeUsage(usage: any): { input: number; output: number; total: number; input_cached_tokens?: number } {
  const input =
    typeof usage?.inputTokens === 'number'
      ? usage.inputTokens
      : typeof usage?.promptTokens === 'number'
        ? usage.promptTokens
        : 0;
  const output =
    typeof usage?.outputTokens === 'number'
      ? usage.outputTokens
      : typeof usage?.completionTokens === 'number'
        ? usage.completionTokens
        : 0;
  const total =
    typeof usage?.totalTokens === 'number'
      ? usage.totalTokens
      : input + output;

  const cacheRead =
    typeof usage?.inputTokenDetails?.cacheReadTokens === 'number'
      ? usage.inputTokenDetails.cacheReadTokens
      : undefined;

  return cacheRead !== undefined && cacheRead > 0
    ? { input, output, total, input_cached_tokens: cacheRead }
    : { input, output, total };
}
