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
/** One part of the user message sent to the LLM. */
type UserPart = { type: 'text'; text: string } | { type: 'image'; image: string };

/** Mutable per-call timing context threaded through the attempt-phase helpers. */
interface LLMCallTimings {
  llmMs: number;
  parseMs: number;
}

/** Outcome of one attempt stage: a value to proceed with, or a retryable failure. */
type LLMAttemptOutcome<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'failed'; stage: 'llm' | 'parse'; error: unknown };
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
    const { userParts, textPrompt } = this._buildPlannerPrompt(request);
    const promptBuildMs = roundDuration(performance.now() - promptBuildStartedAt);

    // Input visibility: one INFO summary line + one DEBUG detail blob per plan call.
    Logger.i(this._summarizePlannerRequest(request));
    Logger.d(this._detailPlannerRequest(request, textPrompt));

    const timings: LLMCallTimings = { llmMs: 0, parseMs: 0 };
    let lastLLMCall: LLMCallTrace | undefined;

    const parsedResponse = await this._retryLLMAttempts<PlannerResponse>(
      { name: 'Planner', suffix: '' },
      'Planner failed after all retry attempts',
      async (attempt, maxAttempts) => {
        const llmOutcome = await this._runPlannerLLMPhase(
          request,
          systemPrompt,
          userParts,
          attempt,
          maxAttempts,
          promptBuildMs,
          timings,
        );
        if (llmOutcome.kind === 'failed') {
          return llmOutcome;
        }
        lastLLMCall = llmOutcome.value.llmCall;
        return this._runPlannerParsePhase(request, llmOutcome.value, attempt, maxAttempts, timings);
      },
    );

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
        totalMs: promptBuildMs + timings.llmMs + timings.parseMs,
        promptBuildMs,
        llmMs: timings.llmMs,
        parseMs: timings.parseMs,
      },
      ...(lastLLMCall ? { llmCall: lastLLMCall } : {}),
    };
  }

  /**
   * Shared retry engine for plan/ground: runs up to MAX_LLM_ATTEMPTS attempts,
   * logging a retry warning between attempts and rethrowing the last error when
   * attempts are exhausted. A FatalProviderError thrown by an attempt propagates
   * immediately (no retry).
   */
  private async _retryLLMAttempts<T>(
    label: { name: string; suffix: string },
    exhaustedMessage: string,
    runAttempt: (attempt: number, maxAttempts: number) => Promise<LLMAttemptOutcome<T>>,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_LLM_ATTEMPTS; attempt++) {
      const outcome = await runAttempt(attempt, MAX_LLM_ATTEMPTS);
      if (outcome.kind === 'ok') {
        return outcome.value;
      }
      lastError = outcome.error;
      if (attempt >= MAX_LLM_ATTEMPTS) {
        throw outcome.error;
      }
      Logger.w(
        `${label.name} attempt ${attempt}/${MAX_LLM_ATTEMPTS} failed (${outcome.stage})${label.suffix}, retrying: ${
          outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
        }`,
      );
    }
    throw lastError ?? new Error(exhaustedMessage);
  }

  /** Run one planner LLM call inside its 'planning.llm' trace phase. */
  private async _runPlannerLLMPhase(
    request: PlannerRequest,
    systemPrompt: string,
    userParts: UserPart[],
    attempt: number,
    maxAttempts: number,
    promptBuildMs: number,
    timings: LLMCallTimings,
  ): Promise<LLMAttemptOutcome<{ output: unknown; text: string; llmCall?: LLMCallTrace }>> {
    const plannerResolved = this._resolveFeatureConfig(FEATURE_PLANNER);
    const llmPhase = startTracePhase(
      request.traceStep,
      'planning.llm',
      `provider=${plannerResolved.provider} model=${plannerResolved.modelName} attempt=${attempt}/${maxAttempts}`,
    );
    const llmStartedAt = performance.now();

    try {
      const llmResult = await this._callLLM(systemPrompt, userParts, FEATURE_PLANNER);
      timings.llmMs = roundDuration(performance.now() - llmStartedAt);
      finishTracePhase(
        llmPhase,
        'success',
        describeLLMTrace({ promptBuildMs, llmMs: timings.llmMs }),
      );
      return { kind: 'ok', value: llmResult };
    } catch (error) {
      finishTracePhase(
        llmPhase,
        'failure',
        error instanceof Error ? error.message : String(error),
      );
      if (FatalProviderError.isInstance(error)) {
        throw error;
      }
      return { kind: 'failed', stage: 'llm', error };
    }
  }

  /** Parse one planner response inside its 'planning.parse' trace phase. */
  private _runPlannerParsePhase(
    request: PlannerRequest,
    llmResult: { output: unknown; text: string },
    attempt: number,
    maxAttempts: number,
    timings: LLMCallTimings,
  ): LLMAttemptOutcome<PlannerResponse> {
    const parsePhase = startTracePhase(
      request.traceStep,
      'planning.parse',
      `attempt=${attempt}/${maxAttempts}`,
    );
    const parseStartedAt = performance.now();
    try {
      const parsed = this._parsePlannerResponse(llmResult.output, llmResult.text);
      timings.parseMs = roundDuration(performance.now() - parseStartedAt);
      finishTracePhase(parsePhase, 'success');
      return { kind: 'ok', value: parsed };
    } catch (error) {
      finishTracePhase(
        parsePhase,
        'failure',
        error instanceof Error ? error.message : String(error),
      );
      return { kind: 'failed', stage: 'parse', error };
    }
  }

  /** Assemble the planner user-message parts and text prompt. */
  private _buildPlannerPrompt(request: PlannerRequest): {
    userParts: UserPart[];
    textPrompt: string;
  } {
    const userParts: UserPart[] = [];

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

    return { userParts, textPrompt };
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

    const promptBuildStartedAt = performance.now();
    const promptKey = this._getPromptKeyForFeature(request.feature);
    const systemPrompt = this._loadPrompt(promptKey);
    const { userParts, text } = this._buildGrounderPrompt(request);
    const promptBuildMs = roundDuration(performance.now() - promptBuildStartedAt);

    // Input visibility: one INFO summary line + one DEBUG detail blob per grounder call.
    Logger.i(this._summarizeGrounderRequest(request));
    Logger.d(this._detailGrounderRequest(request, text));

    const timings: LLMCallTimings = { llmMs: 0, parseMs: 0 };

    const { response: parsed, llmCall: lastLLMCall } = await this._retryLLMAttempts(
      { name: 'Grounder', suffix: ` for feature=${request.feature}` },
      'Grounder failed after all retry attempts',
      (attempt, maxAttempts) =>
        this._runGrounderAttempt(
          request,
          systemPrompt,
          userParts,
          attempt,
          maxAttempts,
          promptBuildMs,
          timings,
        ),
    );

    this._logGrounderResult(request, parsed);

    return {
      ...parsed,
      trace: {
        totalMs: promptBuildMs + timings.llmMs + timings.parseMs,
        promptBuildMs,
        llmMs: timings.llmMs,
        parseMs: timings.parseMs,
      },
      ...(lastLLMCall ? { llmCall: lastLLMCall } : {}),
    };
  }

  /** Assemble the grounder user-message parts and text prompt. */
  private _buildGrounderPrompt(request: GrounderRequest): {
    userParts: UserPart[];
    text: string;
  } {
    const userParts: UserPart[] = [];

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

    return { userParts, text };
  }

  /** Run one grounder LLM call + parse inside its single trace phase. */
  private async _runGrounderAttempt(
    request: GrounderRequest,
    systemPrompt: string,
    userParts: UserPart[],
    attempt: number,
    maxAttempts: number,
    promptBuildMs: number,
    timings: LLMCallTimings,
  ): Promise<LLMAttemptOutcome<{ response: GrounderResponse; llmCall?: LLMCallTrace }>> {
    const phase = startTracePhase(
      request.traceStep,
      request.tracePhase ?? 'action.ground',
      `feature=${request.feature} attempt=${attempt}/${maxAttempts}`,
    );
    const llmStartedAt = performance.now();

    let llmResult: { output: unknown; text: string; llmCall?: LLMCallTrace };
    try {
      llmResult = await this._callLLM(systemPrompt, userParts, request.feature);
    } catch (error) {
      finishTracePhase(
        phase,
        'failure',
        error instanceof Error ? error.message : String(error),
      );
      if (FatalProviderError.isInstance(error)) {
        throw error;
      }
      return { kind: 'failed', stage: 'llm', error };
    }

    timings.llmMs = roundDuration(performance.now() - llmStartedAt);
    const parseStartedAt = performance.now();

    try {
      const response = this._parseGrounderResponse(llmResult.output, llmResult.text);
      timings.parseMs = roundDuration(performance.now() - parseStartedAt);
      finishTracePhase(
        phase,
        'success',
        describeLLMTrace({
          promptBuildMs,
          llmMs: timings.llmMs,
          parseMs: timings.parseMs,
          extraDetail: `feature=${request.feature}`,
        }),
      );
      return { kind: 'ok', value: { response, llmCall: llmResult.llmCall } };
    } catch (error) {
      finishTracePhase(
        phase,
        'failure',
        error instanceof Error ? error.message : String(error),
      );
      return { kind: 'failed', stage: 'parse', error };
    }
  }

  /** Log the grounder result with resolved element bounds when tracing a step. */
  private _logGrounderResult(request: GrounderRequest, parsed: GrounderResponse): void {
    if (request.traceStep === undefined) {
      return;
    }

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

  // ---------- private ----------

  /**
   * Call an LLM via Vercel AI SDK. Uses Output.json() so the provider emits
   * strict JSON (Google response_mime_type, OpenAI response_format, Anthropic
   * structuredOutputMode), matching the Kotlin backend's behavior.
   */
  private async _callLLM(
    systemPrompt: string,
    userParts: UserPart[],
    feature: FeatureName,
  ): Promise<{ output: unknown; text: string; llmCall: LLMCallTrace }> {
    const resolved = this._resolveFeatureConfig(feature);
    const model = this._getModel(resolved);
    const providerOptions = this._getProviderOptions(resolved, feature);
    const phase = phaseForFeature(feature);

    // Persist the exact messages we send so we can forward them verbatim to
    // observability backends (Langfuse stores these for debugging).
    const messages = this._buildLLMMessages(systemPrompt, userParts);

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
        messages,
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

    const llmCall = this._buildLLMCallTrace({
      resolved,
      feature,
      phase,
      prompt: messages,
      completion: text,
      usage,
      startedAt,
      completedAt,
      durationMs,
      thrownError,
    });

    if (thrownError) {
      throw (
        classifyFatalProviderError(thrownError, {
          provider: resolved.provider,
          modelName: resolved.modelName,
        }) ?? thrownError
      );
    }

    this._logLLMResponse(feature, resolved, text, reasoningText);
    return { output, text, llmCall };
  }

  /** Map user parts to SDK message content and pair them with the system prompt. */
  private _buildLLMMessages(systemPrompt: string, userParts: UserPart[]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userContent: any[] = userParts.map((part) => {
      if (part.type === 'image') {
        return { type: 'image' as const, image: part.image };
      }
      return { type: 'text' as const, text: part.text };
    });

    return [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user' as const, content: userContent },
    ];
  }

  /** Assemble the observability record for one LLM call. */
  private _buildLLMCallTrace(params: {
    resolved: ResolvedFeatureConfig;
    feature: FeatureName;
    phase: LLMPhase;
    prompt: unknown;
    completion: string;
    usage: unknown;
    startedAt: string;
    completedAt: string;
    durationMs: number;
    thrownError: unknown;
  }): LLMCallTrace {
    const { thrownError } = params;
    return {
      provider: params.resolved.provider,
      model: params.resolved.modelName,
      feature: params.feature ?? params.phase,
      prompt: params.prompt,
      completion: params.completion,
      usage: normalizeUsage(params.usage),
      startedAt: params.startedAt,
      completedAt: params.completedAt,
      durationMs: params.durationMs,
      ...(thrownError
        ? { statusMessage: thrownError instanceof Error ? thrownError.message : String(thrownError) }
        : {}),
    };
  }

  /** Debug-log the model's reasoning (when present) and raw response text. */
  private _logLLMResponse(
    feature: FeatureName,
    resolved: ResolvedFeatureConfig,
    text: string,
    reasoningText: string | undefined,
  ): void {
    if (reasoningText) {
      Logger.d(
        `LLM reasoning [${feature}] (${resolved.provider}/${resolved.modelName}):\n${reasoningText}`,
      );
    }

    Logger.d(
      `LLM response [${feature}] (${resolved.provider}/${resolved.modelName}):\n${text || '<empty response>'}`,
    );
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

/**
 * Locate the record carrying the planner action, checking the wrapped and
 * unwrapped shapes the models actually emit.
 */
function resolvePlannerAction(json: JsonRecord, output: JsonRecord): JsonRecord | undefined {
  return (
    asRecord(output['action']) ??
    asRecord(json['action']) ??
    (normalizeString(output['action_type']) ? output : undefined) ??
    (normalizeString(json['action_type']) ? json : undefined)
  );
}

/** Fallback response for planner output that carries no action record. */
function plannerResponseWithoutAction(json: JsonRecord, output: JsonRecord): PlannerResponse {
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

function normalizePlannerResponse(json: JsonRecord): PlannerResponse {
  const output = asRecord(json['output']) ?? json;
  const thought = asRecord(output['thought']);
  const action = resolvePlannerAction(json, output);

  if (!action) {
    return plannerResponseWithoutAction(json, output);
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

/**
 * Prompt action_types that normalize to a fixed act/reason pair. A Map (not a
 * plain object) so LLM-controlled strings like "toString" cannot resolve to
 * inherited prototype members — they fall through to the unsupported default.
 */
const FIXED_PROMPT_ACTIONS: ReadonlyMap<string, { act: string; reason: string }> = new Map([
  ['tap', { act: PLANNER_ACTION_TAP, reason: 'Tap the target element.' }],
  ['long_press', { act: PLANNER_ACTION_LONG_PRESS, reason: 'Long press the target element.' }],
  ['input_text', { act: PLANNER_ACTION_TYPE, reason: 'Type text into the target input field.' }],
  ['navigate_home', { act: PLANNER_ACTION_HOME, reason: 'Navigate to the device home screen.' }],
  ['rotate', { act: PLANNER_ACTION_ROTATE, reason: 'Rotate the device orientation.' }],
  ['navigate_back', { act: PLANNER_ACTION_BACK, reason: 'Navigate back one screen.' }],
  ['hide_keyboard', { act: PLANNER_ACTION_HIDE_KEYBOARD, reason: 'Hide the software keyboard.' }],
  ['keyboard_enter', { act: PLANNER_ACTION_PRESS_ENTER, reason: 'Press the enter key.' }],
  ['wait', { act: PLANNER_ACTION_WAIT, reason: 'Wait for the UI to stabilize.' }],
  ['deep_link', { act: PLANNER_ACTION_DEEPLINK, reason: 'Open the deeplink URL.' }],
  ['set_location', { act: PLANNER_ACTION_SET_LOCATION, reason: 'Set the device location.' }],
  ['launch_app', { act: PLANNER_ACTION_LAUNCH_APP, reason: 'Launch the target app.' }],
]);

/** Normalize a `swipe` prompt action, deriving the reason from act/direction. */
function normalizeSwipeAction(action: JsonRecord): { act: string; reason: string } {
  return {
    act: PLANNER_ACTION_SCROLL,
    reason: firstNonEmpty(
      normalizeString(action['act']),
      normalizeString(action['direction']) ? `Swipe ${normalizeString(action['direction'])}` : undefined,
      'Scroll the current view.',
    ) ?? 'Scroll the current view.',
  };
}

/** Normalize a terminal `status` prompt action to completed/failed. */
function normalizeStatusAction(action: JsonRecord): { act: string; reason: string } {
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

function normalizePromptAction(
  actionType: string,
  action: JsonRecord,
): { act: string; reason: string } {
  const fixed = FIXED_PROMPT_ACTIONS.get(actionType);
  if (fixed) {
    return { ...fixed };
  }

  if (actionType === 'swipe') {
    return normalizeSwipeAction(action);
  }

  if (actionType === 'status') {
    return normalizeStatusAction(action);
  }

  return {
    act: actionType,
    reason: `Planner returned unsupported action_type: ${actionType}`,
  };
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
/** Read a token count from the SDK usage object, trying the legacy field name second. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function usageTokenCount(usage: any, field: string, legacyField: string): number {
  if (typeof usage?.[field] === 'number') {
    return usage[field];
  }
  return typeof usage?.[legacyField] === 'number' ? usage[legacyField] : 0;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeUsage(usage: any): { input: number; output: number; total: number; input_cached_tokens?: number } {
  const input = usageTokenCount(usage, 'inputTokens', 'promptTokens');
  const output = usageTokenCount(usage, 'outputTokens', 'completionTokens');
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
