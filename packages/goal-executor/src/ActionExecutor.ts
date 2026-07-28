// Executes individual device actions: ground → coordinates → execute on device.

import { v4 as uuidv4 } from 'uuid';
import {
  DeviceAgent,
  Hierarchy,
  DeviceActionRequest,
  Logger,
  Point,
  TapAction,
  LongPressAction,
  EnterTextAction,
  ScrollAbsAction,
  BackAction,
  HomeAction,
  RotateAction,
  HideKeyboardAction,
  PressKeyAction,
  LaunchAppAction,
  DeeplinkAction,
  SetLocationAction,
  WaitAction,
  AppUpload,
  GetAppListAction,
  FEATURE_GROUNDER,
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
  PLANNER_ACTION_DEEPLINK,
  type FeatureName,
  type RuntimeBindings,
  redactResolvedValue,
  resolveRuntimePlaceholders,
} from '@finalrun/common';
import { AIAgent } from './ai/AIAgent.js';
import { VisualGrounder } from './ai/VisualGrounder.js';
import {
  type TerminalFailureSignal,
  terminalFailureFromError,
} from './ai/providerFailure.js';
import { GrounderResponseConverter, ConversionResult } from './GrounderResponseConverter.js';
import {
  describeLLMTrace,
  finishTracePhase,
  nowMs,
  roundDuration,
  startTracePhase,
  type LLMTrace,
  type LLMCallTrace,
  type SpanTiming,
  type TimingMetadata,
  type TraceStatus,
} from './trace.js';

// ============================================================================
// Types
// ============================================================================

export interface ActionInput {
  action: string;
  reason: string;
  text?: string;
  clearText?: boolean;
  direction?: string;
  durationSeconds?: number;
  url?: string;
  repeat?: number;
  delayBetweenTapMs?: number;
  screenshot?: string;
  hierarchy?: Hierarchy;
  screenWidth: number;
  screenHeight: number;
  traceStep?: number;
}

export interface ActionOutput {
  success: boolean;
  error?: string;
  trace?: TimingMetadata;
  terminalFailure?: TerminalFailureSignal;
  /** Raw LLM calls made during this action (grounder + visual grounder). Forwarded to observability. */
  llmCalls?: LLMCallTrace[];
}

interface GroundToPointResult {
  result: ConversionResult<Point | null>;
  trace?: LLMTrace;
  detail?: string;
}

/** Every device action the executor can hand to the driver. */
type ExecutableDeviceAction =
  | TapAction
  | LongPressAction
  | EnterTextAction
  | ScrollAbsAction
  | BackAction
  | HomeAction
  | RotateAction
  | HideKeyboardAction
  | PressKeyAction
  | LaunchAppAction
  | DeeplinkAction
  | SetLocationAction
  | WaitAction;

/**
 * Outcome of a non-terminal action phase: either a value the orchestrating
 * method proceeds with, or the terminal ActionOutput to return as-is.
 */
type PhaseOutcome<T> =
  | { kind: 'proceed'; value: T }
  | { kind: 'done'; output: ActionOutput };

class TimedActionPhaseFailure extends Error {
  readonly span: SpanTiming;

  constructor(message: string, span: SpanTiming, cause?: unknown) {
    super(message);
    this.name = 'TimedActionPhaseFailure';
    this.span = span;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

// ============================================================================
// ActionExecutor
// ============================================================================

/**
 * Executes individual actions: ground UI element → compute coordinates → device action.
 *
 */
export class ActionExecutor {
  private _agent: DeviceAgent;
  private _aiAgent: AIAgent;
  private _visualGrounder: VisualGrounder;
  private _platform: string;
  private _appIdentifier?: string;
  private _runtimeBindings?: RuntimeBindings;
  private _logContext?: string;

  constructor(params: {
    agent: DeviceAgent;
    aiAgent: AIAgent;
    platform: string;
    appIdentifier?: string;
    runtimeBindings?: RuntimeBindings;
    /** Attached to every grounder log line. See TestExecutorConfig.logContext. */
    logContext?: string;
  }) {
    this._agent = params.agent;
    this._aiAgent = params.aiAgent;
    this._visualGrounder = new VisualGrounder(params.aiAgent);
    this._platform = params.platform;
    this._appIdentifier = params.appIdentifier;
    this._runtimeBindings = params.runtimeBindings;
    this._logContext = params.logContext;
  }

  /**
   * Execute an action based on the planner's output.
   * Routes to the correct handler based on action type.
   */
  async executeAction(input: ActionInput): Promise<ActionOutput> {
    // Per-invocation accumulator — passed into helpers so concurrent
    // executeAction() calls on the same executor do not share state.
    const llmCalls: LLMCallTrace[] = [];
    let output: ActionOutput;
    try {
      const handler = this._resolveHandler(input.action);
      output = handler
        ? await handler(input, llmCalls)
        : { success: false, error: `Unknown action: ${input.action}` };
    } catch (error) {
      const terminalFailure = terminalFailureFromError(error);
      if (terminalFailure) {
        Logger.e(terminalFailure.message);
      } else {
        Logger.e(`Action ${input.action} failed:`, error);
      }
      output = this._failure([], error);
    }

    if (llmCalls.length > 0) {
      output = { ...output, llmCalls };
    }
    return output;
  }

  /** Map a planner action string to its handler. Undefined for unknown actions. */
  private _resolveHandler(
    action: string,
  ): ((input: ActionInput, llmCalls: LLMCallTrace[]) => Promise<ActionOutput>) | undefined {
    const handlers: Record<
      string,
      (input: ActionInput, llmCalls: LLMCallTrace[]) => Promise<ActionOutput>
    > = {
      [PLANNER_ACTION_TAP]: (input, llmCalls) => this._executeTap(input, llmCalls),
      [PLANNER_ACTION_LONG_PRESS]: (input, llmCalls) => this._executeLongPress(input, llmCalls),
      [PLANNER_ACTION_TYPE]: (input, llmCalls) => this._executeType(input, llmCalls),
      [PLANNER_ACTION_SCROLL]: (input, llmCalls) => this._executeScroll(input, llmCalls),
      [PLANNER_ACTION_BACK]: (input) => this._executeSimpleAction(input, new BackAction()),
      [PLANNER_ACTION_HOME]: (input) => this._executeSimpleAction(input, new HomeAction()),
      [PLANNER_ACTION_ROTATE]: (input) =>
        this._executeSingleDevicePhase(input, new RotateAction()),
      [PLANNER_ACTION_HIDE_KEYBOARD]: (input) =>
        this._executeSimpleAction(input, new HideKeyboardAction()),
      [PLANNER_ACTION_PRESS_ENTER]: (input) => this._executePressEnter(input),
      [PLANNER_ACTION_LAUNCH_APP]: (input, llmCalls) => this._executeLaunchApp(input, llmCalls),
      [PLANNER_ACTION_SET_LOCATION]: (input, llmCalls) =>
        this._executeSetLocation(input, llmCalls),
      [PLANNER_ACTION_WAIT]: (input) => this._executeWait(input),
      [PLANNER_ACTION_DEEPLINK]: (input) => this._executeDeeplink(input),
    };
    return Object.prototype.hasOwnProperty.call(handlers, action)
      ? handlers[action]
      : undefined;
  }

  private async _executeTap(
    input: ActionInput,
    llmCalls: LLMCallTrace[],
  ): Promise<ActionOutput> {
    const spans: SpanTiming[] = [];

    const grounded = await this._groundTargetPoint(input, 'tap', spans, llmCalls);
    if (grounded.kind === 'done') {
      return grounded.output;
    }

    const point = grounded.value;
    const repeatCount = Math.max(1, input.repeat ?? 1);
    const delayBetweenTapMs = input.delayBetweenTapMs ?? 500;

    return this._finishWithDevicePhase(
      input,
      spans,
      async () => {
        for (let index = 0; index < repeatCount; index++) {
          const action = new TapAction({
            point: new Point({ x: point.x, y: point.y }),
          });
          await this._runSingleDeviceAction(action, input.traceStep);

          if (index < repeatCount - 1) {
            await this._delay(delayBetweenTapMs);
          }
        }
      },
      {
        successDetail: () =>
          `repeats=${repeatCount} delayBetweenTapMs=${delayBetweenTapMs}`,
      },
    );
  }

  private async _executeLongPress(
    input: ActionInput,
    llmCalls: LLMCallTrace[],
  ): Promise<ActionOutput> {
    const spans: SpanTiming[] = [];

    const grounded = await this._groundTargetPoint(input, 'longPress', spans, llmCalls);
    if (grounded.kind === 'done') {
      return grounded.output;
    }

    const action = new LongPressAction({
      point: new Point({ x: grounded.value.x, y: grounded.value.y }),
    });
    return this._finishWithDevicePhase(input, spans, () =>
      this._runSingleDeviceAction(action, input.traceStep),
    );
  }

  /**
   * Shared preamble for point-targeted actions (tap/longPress): ground the
   * target element, falling back to visual grounding — which executes the
   * device action itself — when the grounder requests it.
   */
  private async _groundTargetPoint(
    input: ActionInput,
    actionType: 'tap' | 'longPress',
    spans: SpanTiming[],
    llmCalls: LLMCallTrace[],
  ): Promise<PhaseOutcome<Point>> {
    let groundOutcome: GroundToPointResult;
    try {
      groundOutcome = await this._groundToPoint(
        input,
        FEATURE_GROUNDER,
        'action.ground',
        llmCalls,
      );
    } catch (error) {
      return { kind: 'done', output: this._failure(spans, error) };
    }

    this._pushGroundSpan(spans, 'action.ground', groundOutcome);
    if (groundOutcome.result.success && groundOutcome.result.data) {
      return { kind: 'proceed', value: groundOutcome.result.data };
    }

    if (groundOutcome.result.error === 'needsVisualGrounding') {
      const fallbackResult = await this._executeVisualGroundingFallback(
        input,
        actionType,
        llmCalls,
      );
      this._mergeTrace(spans, fallbackResult.trace);
      if (!fallbackResult.success) {
        return {
          kind: 'done',
          output: {
            success: false,
            error: fallbackResult.error ?? 'Visual grounding failed',
            trace: this._buildTrace(spans),
            terminalFailure: fallbackResult.terminalFailure,
          },
        };
      }
      return { kind: 'done', output: this._success(spans) };
    }

    return {
      kind: 'done',
      output: this._failure(spans, groundOutcome.result.error ?? 'Grounding failed'),
    };
  }

  private async _executeType(
    input: ActionInput,
    llmCalls: LLMCallTrace[],
  ): Promise<ActionOutput> {
    const spans: SpanTiming[] = [];

    let textToType = '';
    let rawTextToType = '';
    const prepFailure = await this._runSpanPhase(
      input,
      spans,
      'action.prep',
      async () => {
        const textMatch =
          input.reason.match(/"([^"]*)"/) ??
          input.reason.match(/'([^']*)'/);
        rawTextToType = input.text ?? (textMatch ? textMatch[1] : input.reason);
        textToType = this._runtimeBindings
          ? resolveRuntimePlaceholders(rawTextToType, this._runtimeBindings)
          : rawTextToType;
      },
      {
        successDetail: () =>
          `textLength=${rawTextToType.length} clearText=${input.clearText ?? true}`,
      },
    );
    if (prepFailure) {
      return prepFailure;
    }

    let focusOutcome: GroundToPointResult;
    try {
      focusOutcome = await this._groundToPoint(
        input,
        FEATURE_INPUT_FOCUS_GROUNDER,
        'action.ground',
        llmCalls,
      );
    } catch (error) {
      return this._failure(spans, error);
    }

    this._pushGroundSpan(spans, 'action.ground', focusOutcome);
    if (!focusOutcome.result.success) {
      return this._failure(
        spans,
        focusOutcome.result.error ?? 'Input focus grounding failed',
      );
    }

    return this._finishWithDevicePhase(input, spans, () =>
      this._typeTextOnDevice(input, focusOutcome.result.data, textToType),
    );
  }

  /** Focus the input field when a point was grounded, then enter the text. */
  private async _typeTextOnDevice(
    input: ActionInput,
    focusPoint: Point | null | undefined,
    textToType: string,
  ): Promise<void> {
    if (focusPoint !== null && focusPoint !== undefined) {
      const tapAction = new TapAction({
        point: new Point({ x: focusPoint.x, y: focusPoint.y }),
      });
      await this._runSingleDeviceAction(tapAction, input.traceStep);
      await this._delay(300);
    }

    const action = new EnterTextAction({
      value: textToType,
      shouldEraseText: input.clearText ?? true,
    });
    await this._runSingleDeviceAction(action, input.traceStep);
  }

  private async _executeScroll(
    input: ActionInput,
    llmCalls: LLMCallTrace[],
  ): Promise<ActionOutput> {
    const spans: SpanTiming[] = [];
    const act =
      input.reason.trim() ||
      (input.direction ? `Swipe ${input.direction}` : 'Scroll the current view.');

    let grounderResponse;
    try {
      grounderResponse = await this._callGrounder(
        input,
        {
          feature: FEATURE_SCROLL_INDEX_GROUNDER,
          act,
          hierarchy: input.hierarchy,
          screenshot: input.screenshot,
          platform: this._platform,
        },
        llmCalls,
      );
    } catch (error) {
      return this._failure(spans, error);
    }

    const scrollResult = GrounderResponseConverter.extractScrollAction({
      output: grounderResponse.output,
      screenWidth: input.screenWidth,
      screenHeight: input.screenHeight,
    });

    spans.push(
      this._llmTraceToSpan(
        'action.ground',
        grounderResponse.trace,
        scrollResult.success ? 'success' : 'failure',
        this._groundTraceDetail(
          grounderResponse.trace,
          FEATURE_SCROLL_INDEX_GROUNDER,
          scrollResult.success ? undefined : scrollResult.error ?? 'Scroll grounding failed',
        ),
      ),
    );

    if (!scrollResult.success || !scrollResult.data) {
      return this._failure(
        spans,
        scrollResult.error ?? 'Scroll grounding failed',
      );
    }

    return this._finishWithDevicePhase(input, spans, () =>
      this._runSingleDeviceAction(scrollResult.data!, input.traceStep),
    );
  }

  private async _executePressEnter(input: ActionInput): Promise<ActionOutput> {
    const action = new PressKeyAction({ key: 'enter' });
    return await this._executeSingleDevicePhase(input, action);
  }

  private async _executeLaunchApp(
    input: ActionInput,
    llmCalls: LLMCallTrace[],
  ): Promise<ActionOutput> {
    const spans: SpanTiming[] = [];
    let apps: Array<{ packageName: string; name: string }> = [];

    const prepFailure = await this._runSpanPhase(
      input,
      spans,
      'action.prep',
      async () => {
        apps = await this._fetchInstalledApps(input);
      },
      {
        successDetail: () => `appCount=${apps.length}`,
      },
    );
    if (prepFailure) {
      return prepFailure;
    }

    const grounded = await this._groundStructuredOutput(
      input,
      spans,
      llmCalls,
      {
        feature: FEATURE_LAUNCH_APP_GROUNDER,
        act: input.reason,
        platform: this._platform,
        availableApps: apps,
      },
      (output) =>
        output['isError']
          ? (output['reason'] as string) ?? 'Launch app grounder failed'
          : !output['packageName']
            ? 'Launch app grounder did not return packageName'
            : undefined,
    );
    if (grounded.kind === 'done') {
      return grounded.output;
    }

    const packageName = grounded.value['packageName'] as string;
    const action = this._buildLaunchAppAction(grounded.value, packageName);

    return this._finishWithDevicePhase(
      input,
      spans,
      () => this._runSingleDeviceAction(action, input.traceStep),
      {
        successDetail: () => `package=${packageName}`,
      },
    );
  }

  /** Build the LaunchAppAction from the grounder output, applying defaults. */
  private _buildLaunchAppAction(
    output: Record<string, unknown>,
    packageName: string,
  ): LaunchAppAction {
    return new LaunchAppAction({
      appUpload: new AppUpload({ id: '', platform: this._platform, packageName }),
      allowAllPermissions: readOptionalBoolean(output, 'allowAllPermissions') ?? true,
      shouldUninstallBeforeLaunch:
        readOptionalBoolean(output, 'shouldUninstallBeforeLaunch') ??
        (packageName === this._appIdentifier ? false : true),
      clearState: readOptionalBoolean(output, 'clearState') ?? false,
      stopAppBeforeLaunch: readOptionalBoolean(output, 'stopAppBeforeLaunch') ?? false,
      permissions: (output['permissions'] as Record<string, string>) ?? {},
    });
  }

  /** Load the installed-app list from the device, throwing on driver failure. */
  private async _fetchInstalledApps(
    input: ActionInput,
  ): Promise<Array<{ packageName: string; name: string }>> {
    const appListResponse = await this._agent.executeAction(
      new DeviceActionRequest({
        requestId: uuidv4(),
        action: new GetAppListAction(),
        timeout: 10,
        traceStep: input.traceStep,
      }),
    );
    if (!appListResponse.success) {
      throw new Error(appListResponse.message ?? 'Failed to load installed apps');
    }

    return appListResponse.data
      ? ((appListResponse.data['apps'] as Array<{ packageName: string; name: string }>) ?? [])
      : [];
  }

  private async _executeSetLocation(
    input: ActionInput,
    llmCalls: LLMCallTrace[],
  ): Promise<ActionOutput> {
    const spans: SpanTiming[] = [];

    const grounded = await this._groundStructuredOutput(
      input,
      spans,
      llmCalls,
      {
        feature: FEATURE_SET_LOCATION_GROUNDER,
        act: input.reason,
      },
      (output) =>
        output['isError']
          ? (output['reason'] as string) ?? 'Set location grounder failed'
          : !output['lat'] || !output['long']
            ? 'Set location grounder did not return coordinates'
            : undefined,
    );
    if (grounded.kind === 'done') {
      return grounded.output;
    }

    const lat = grounded.value['lat'] as string;
    const long = grounded.value['long'] as string;
    const action = new SetLocationAction({ lat: lat.trim(), long: long.trim() });
    return this._finishWithDevicePhase(
      input,
      spans,
      () => this._runSingleDeviceAction(action, input.traceStep),
      {
        successDetail: () => `lat=${lat.trim()} long=${long.trim()}`,
      },
    );
  }

  /**
   * Shared preamble for grounders whose raw output is consumed directly
   * (launchApp/setLocation): call the grounder, validate its output, and
   * record the ground span. `validate` returns the grounder error, if any.
   */
  private async _groundStructuredOutput(
    input: ActionInput,
    spans: SpanTiming[],
    llmCalls: LLMCallTrace[],
    request: {
      feature: FeatureName;
      act: string;
      platform?: string;
      availableApps?: Array<{ packageName: string; name: string }>;
    },
    validate: (output: Record<string, unknown>) => string | undefined,
  ): Promise<PhaseOutcome<Record<string, unknown>>> {
    let grounderResponse;
    try {
      grounderResponse = await this._callGrounder(input, request, llmCalls);
    } catch (error) {
      return { kind: 'done', output: this._failure(spans, error) };
    }

    const output = grounderResponse.output;
    const grounderError = validate(output);

    spans.push(
      this._llmTraceToSpan(
        'action.ground',
        grounderResponse.trace,
        grounderError ? 'failure' : 'success',
        this._groundTraceDetail(grounderResponse.trace, request.feature, grounderError),
      ),
    );

    if (grounderError) {
      return { kind: 'done', output: this._failure(spans, grounderError) };
    }

    return { kind: 'proceed', value: output };
  }

  private async _executeWait(input: ActionInput): Promise<ActionOutput> {
    const spans: SpanTiming[] = [];
    const durationSeconds = input.durationSeconds ?? 3;

    const failure = await this._runSpanPhase(
      input,
      spans,
      'action.wait',
      async () => {
        Logger.d(`Waiting ${durationSeconds} seconds...`);
        await this._delay(Math.max(0, Math.round(durationSeconds * 1000)));
      },
      {
        successDetail: () => `duration=${durationSeconds}s`,
      },
    );
    return failure ?? this._success(spans);
  }

  private async _executeDeeplink(input: ActionInput): Promise<ActionOutput> {
    const spans: SpanTiming[] = [];
    let deeplink = '';
    let rawDeeplink = '';

    const prepFailure = await this._runSpanPhase(
      input,
      spans,
      'action.prep',
      async () => {
        rawDeeplink =
          input.url ??
          input.reason.match(/(https?:\/\/\S+|[a-zA-Z][a-zA-Z0-9+.-]*:\/\/\S+)/)?.[1] ??
          '';
        if (!rawDeeplink) {
          throw new Error('Could not extract deeplink URL from reason');
        }
        deeplink = this._runtimeBindings
          ? resolveRuntimePlaceholders(rawDeeplink, this._runtimeBindings)
          : rawDeeplink;
      },
      {
        successDetail: () => `url=${rawDeeplink}`,
      },
    );
    if (prepFailure) {
      return prepFailure;
    }

    const action = new DeeplinkAction({ deeplink });
    return this._finishWithDevicePhase(input, spans, () =>
      this._runSingleDeviceAction(action, input.traceStep),
    );
  }

  private async _executeSimpleAction(
    input: ActionInput,
    action: BackAction | HomeAction | HideKeyboardAction,
  ): Promise<ActionOutput> {
    return await this._executeSingleDevicePhase(input, action);
  }

  private async _executeSingleDevicePhase(
    input: ActionInput,
    action: ExecutableDeviceAction,
  ): Promise<ActionOutput> {
    const spans: SpanTiming[] = [];
    return this._finishWithDevicePhase(input, spans, () =>
      this._runSingleDeviceAction(action, input.traceStep),
    );
  }

  /**
   * Run a timed phase and record its span. Returns the terminal failure
   * ActionOutput when the phase throws, or undefined when the caller should
   * proceed to the next phase.
   */
  private async _runSpanPhase(
    input: ActionInput,
    spans: SpanTiming[],
    name: string,
    fn: () => Promise<void>,
    options?: { successDetail?: () => string },
  ): Promise<ActionOutput | undefined> {
    try {
      const phase = await this._runTimedPhase(input, name, fn, options);
      spans.push(phase.span);
      return undefined;
    } catch (error) {
      return this._failure(spans, error);
    }
  }

  /** Run the terminal 'action.device' phase and resolve the action outcome. */
  private async _finishWithDevicePhase(
    input: ActionInput,
    spans: SpanTiming[],
    run: () => Promise<void>,
    options?: { successDetail?: () => string },
  ): Promise<ActionOutput> {
    const failure = await this._runSpanPhase(input, spans, 'action.device', run, options);
    return failure ?? this._success(spans);
  }

  /** Execute one device action, throwing when the driver reports failure. */
  private async _runSingleDeviceAction(
    action: ExecutableDeviceAction,
    traceStep: number | undefined,
  ): Promise<void> {
    const result = await this._executeDeviceAction(action, traceStep);
    if (!result.success) {
      // _executeDeviceAction always substitutes 'Action failed' for a missing
      // or blank driver message, so result.error is never nullish or empty here.
      throw new Error(result.error);
    }
  }

  private async _groundToPoint(
    input: ActionInput,
    feature: FeatureName,
    tracePhase: string,
    llmCalls: LLMCallTrace[],
  ): Promise<GroundToPointResult> {
    const grounderResponse = await this._callGrounder(
      input,
      {
        feature,
        act: input.reason,
        hierarchy: input.hierarchy,
        screenshot: input.screenshot,
        platform: this._platform,
        tracePhase,
      },
      llmCalls,
    );

    return {
      result: GrounderResponseConverter.extractPoint({
        output: grounderResponse.output,
        flattenedHierarchy: input.hierarchy?.flattenedHierarchy ?? [],
        screenWidth: input.screenWidth,
        screenHeight: input.screenHeight,
      }),
      trace: grounderResponse.trace,
      detail: this._groundTraceDetail(
        grounderResponse.trace,
        feature,
        typeof grounderResponse.output['reason'] === 'string'
          ? (grounderResponse.output['reason'] as string)
          : undefined,
      ),
    };
  }

  private async _executeVisualGroundingFallback(
    input: ActionInput,
    actionType: 'tap' | 'longPress',
    llmCalls: LLMCallTrace[],
  ): Promise<ActionOutput> {
    const spans: SpanTiming[] = [];

    if (!input.screenshot) {
      spans.push({
        name: 'action.visual_fallback',
        durationMs: 0,
        status: 'failure',
        detail: 'needsVisualGrounding but no screenshot available',
      });
      return {
        success: false,
        error: 'needsVisualGrounding but no screenshot available',
        trace: this._buildTrace(spans),
      };
    }

    const phase = await this._runVisualGroundPhase(input, spans, llmCalls);
    if (phase.kind === 'done') {
      return phase.output;
    }

    const result = phase.value;
    if (!result.success || result.x === undefined || result.y === undefined) {
      return {
        success: false,
        error: `Visual grounding failed: ${result.reason}`,
        trace: this._buildTrace(spans),
      };
    }

    const point = new Point({ x: result.x, y: result.y });
    const action = actionType === 'longPress'
      ? new LongPressAction({ point })
      : new TapAction({ point });

    return this._finishWithDevicePhase(input, spans, () =>
      this._runSingleDeviceAction(action, input.traceStep),
    );
  }

  /**
   * Call the visual grounder and record its span. Returns the raw grounder
   * result — the caller decides whether the located point is usable.
   */
  private async _runVisualGroundPhase(
    input: ActionInput,
    spans: SpanTiming[],
    llmCalls: LLMCallTrace[],
  ): Promise<PhaseOutcome<Awaited<ReturnType<VisualGrounder['ground']>>>> {
    const startedAt = nowMs();
    let result: Awaited<ReturnType<VisualGrounder['ground']>>;
    try {
      result = await this._visualGrounder.ground({
        act: input.reason,
        screenshot: input.screenshot!,
        platform: this._platform,
        traceStep: input.traceStep,
        logContext: this._logContext,
      });
      if (result.llmCall) {
        llmCalls.push(result.llmCall);
      }
    } catch (error) {
      const message = this._redactRuntimeString(
        error instanceof Error ? error.message : String(error),
      );
      const failure = new TimedActionPhaseFailure(
        message ?? 'Visual grounding failed',
        {
          name: 'action.visual_fallback',
          durationMs: roundDuration(nowMs() - startedAt),
          status: 'failure',
          detail: message,
        },
        error,
      );
      return { kind: 'done', output: this._failure(spans, failure) };
    }

    spans.push(
      this._llmTraceToSpan(
        'action.visual_fallback',
        result.trace ?? {
          totalMs: roundDuration(nowMs() - startedAt),
          promptBuildMs: 0,
          llmMs: roundDuration(nowMs() - startedAt),
          parseMs: 0,
        },
        result.success && result.x !== undefined && result.y !== undefined
          ? 'success'
          : 'failure',
        result.reason,
      ),
    );

    return { kind: 'proceed', value: result };
  }

  private async _executeDeviceAction(
    action: ExecutableDeviceAction,
    traceStep?: number,
  ): Promise<ActionOutput> {
    const response = await this._agent.executeAction(
      new DeviceActionRequest({
        requestId: uuidv4(),
        action,
        timeout: 30,
        traceStep,
      }),
    );

    if (response.success) {
      return { success: true };
    }

    // Treat an empty or whitespace-only driver message as missing — callers
    // throw result.error directly, so a blank message must never surface as
    // a blank action error.
    const message = response.message?.trim() ? response.message : undefined;
    return {
      success: false,
      error: message ?? 'Action failed',
    };
  }

  private async _callGrounder(
    input: ActionInput,
    request: {
      feature: FeatureName;
      act: string;
      hierarchy?: Hierarchy;
      screenshot?: string;
      platform?: string;
      availableApps?: Array<{ packageName: string; name: string }>;
      tracePhase?: string;
    },
    llmCalls: LLMCallTrace[],
  ) {
    const startedAt = nowMs();

    try {
      const response = await this._aiAgent.ground({
        ...request,
        traceStep: input.traceStep,
        tracePhase: request.tracePhase ?? 'action.ground',
        logContext: this._logContext,
      });

      if (response.llmCall) {
        llmCalls.push(response.llmCall);
      }

      return {
        ...response,
        trace:
          response.trace ??
          {
            totalMs: roundDuration(nowMs() - startedAt),
            promptBuildMs: 0,
            llmMs: roundDuration(nowMs() - startedAt),
            parseMs: 0,
          },
      };
    } catch (error) {
      const message = this._redactRuntimeString(
        error instanceof Error ? error.message : String(error),
      );
      throw new TimedActionPhaseFailure(
        message ?? 'Grounder call failed',
        {
          name: request.tracePhase ?? 'action.ground',
          durationMs: roundDuration(nowMs() - startedAt),
          status: 'failure',
          detail: message,
        },
        error,
      );
    }
  }

  private async _runTimedPhase<T>(
    input: ActionInput,
    name: string,
    fn: () => Promise<T>,
    options?: {
      startDetail?: string;
      successDetail?: (result: T) => string | undefined;
      failureDetail?: (error: unknown) => string | undefined;
    },
  ): Promise<{ result: T; span: SpanTiming }> {
    const activePhase = startTracePhase(input.traceStep, name, options?.startDetail);
    const startedAt = nowMs();

    try {
      const result = await fn();
      const detail = options?.successDetail?.(result);
      const durationMs = roundDuration(nowMs() - startedAt);
      finishTracePhase(activePhase, 'success', detail);
      return {
        result,
        span: {
          name,
          durationMs,
          status: 'success',
          detail,
        },
      };
    } catch (error) {
      const detail = this._redactRuntimeString(
        options?.failureDetail?.(error) ??
        (error instanceof Error ? error.message : String(error)),
      );
      const durationMs = roundDuration(nowMs() - startedAt);
      finishTracePhase(activePhase, 'failure', detail);
      throw new TimedActionPhaseFailure(
        detail ?? 'Action phase failed',
        {
          name,
          durationMs,
          status: 'failure',
          detail,
        },
        error,
      );
    }
  }

  private _pushGroundSpan(
    spans: SpanTiming[],
    name: string,
    groundOutcome: GroundToPointResult,
  ): void {
    spans.push(
      this._llmTraceToSpan(
        name,
        groundOutcome.trace,
        this._groundStatus(groundOutcome.result),
        groundOutcome.detail ??
          (groundOutcome.result.success ? undefined : groundOutcome.result.error ?? undefined),
      ),
    );
  }

  private _groundStatus(
    result: ConversionResult<Point | null>,
  ): TraceStatus {
    if (result.success || result.error === 'needsVisualGrounding') {
      return 'success';
    }

    return 'failure';
  }

  private _llmTraceToSpan(
    name: string,
    trace: LLMTrace | undefined,
    status: TraceStatus,
    detail?: string,
  ): SpanTiming {
    return {
      name,
      durationMs: trace?.totalMs ?? 0,
      status,
      detail: this._composeDetail(trace, detail),
    };
  }

  private _composeDetail(
    trace: LLMTrace | undefined,
    detail: string | undefined,
  ): string | undefined {
    const safeDetail = this._redactRuntimeString(detail);
    if (!trace && !detail) {
      return undefined;
    }

    if (!trace) {
      return safeDetail;
    }

    return describeLLMTrace({
      promptBuildMs: trace.promptBuildMs,
      llmMs: trace.llmMs,
      parseMs: trace.parseMs,
      extraDetail: safeDetail,
    });
  }

  private _groundTraceDetail(
    trace: LLMTrace | undefined,
    feature: FeatureName,
    reason?: string,
  ): string {
    const detail = `feature=${feature}${reason ? ` reason=${reason}` : ''}`;
    return this._composeDetail(trace, detail) ??
      this._redactRuntimeString(detail) ??
      detail;
  }

  private _success(spans: SpanTiming[]): ActionOutput {
    return {
      success: true,
      trace: this._buildTrace(spans),
    };
  }

  private _failure(
    spans: SpanTiming[],
    error: unknown,
  ): ActionOutput {
    const terminalFailure = terminalFailureFromError(error);
    if (error instanceof TimedActionPhaseFailure) {
      spans.push(error.span);
      return {
        success: false,
        error: this._redactRuntimeString(error.message) ?? error.message,
        trace: this._buildTrace(spans),
        terminalFailure,
      };
    }

    return {
      success: false,
      error: this._redactRuntimeString(
        error instanceof Error ? error.message : String(error),
      ) ?? (error instanceof Error ? error.message : String(error)),
      trace: this._buildTrace(spans),
      terminalFailure,
    };
  }

  private _buildTrace(spans: SpanTiming[]): TimingMetadata {
    return {
      totalMs: spans.reduce((sum, span) => sum + span.durationMs, 0),
      spans: spans.map((span) => ({
        ...span,
        detail: this._redactRuntimeString(span.detail),
      })),
    };
  }

  private _mergeTrace(
    spans: SpanTiming[],
    trace: TimingMetadata | undefined,
  ): void {
    if (!trace) {
      return;
    }

    spans.push(...trace.spans);
  }

  private _redactRuntimeString(value: string | undefined): string | undefined {
    if (!value || !this._runtimeBindings) {
      return value;
    }

    return redactResolvedValue(value, this._runtimeBindings);
  }

  private _delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function readOptionalBoolean(
  record: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}
