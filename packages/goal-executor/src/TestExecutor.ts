// The main loop: screenshot → plan → act → repeat.

import { v4 as uuidv4 } from 'uuid';
import {
  DeviceAgent,
  DeviceActionRequest,
  Hierarchy,
  Logger,
  GetScreenshotAndHierarchyAction,
  DEFAULT_MAX_ITERATIONS,
  PLANNER_ACTION_COMPLETED,
  PLANNER_ACTION_FAILED,
  type ActionPayload,
  type PlannerThought,
  type RuntimeBindings,
} from '@finalrun/common';
import { AIAgent, PlannerResponse } from './ai/AIAgent.js';
import {
  type TerminalFailureSignal,
  terminalFailureFromError,
} from './ai/providerFailure.js';
import { ActionExecutor, type ActionOutput } from './ActionExecutor.js';
import {
  StepTraceBuilder,
  formatStepTraceSummary,
  startTracePhase,
  type ActiveTracePhase,
  type SpanTiming,
  type StepTrace,
  type TimingMetadata,
  type LLMCallTrace,
} from './trace.js';

// ============================================================================
// Helpers
// ============================================================================

const MAX_LOG_FIELD_LENGTH = 300;

/** Strip ANSI escapes and ASCII control chars from model-generated strings before logging. */
function sanitizeLogField(value: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  return cleaned.length > MAX_LOG_FIELD_LENGTH
    ? cleaned.slice(0, MAX_LOG_FIELD_LENGTH) + '…'
    : cleaned;
}

// ============================================================================
// Types
// ============================================================================

export interface TestExecutorConfig {
  goal: string;
  platform: string;
  maxIterations?: number;
  agent: DeviceAgent;
  aiAgent: AIAgent;
  preContext?: string;
  appKnowledge?: string;
  appIdentifier?: string;
  runtimeBindings?: RuntimeBindings;
  /**
   * Free-form label attached to every planner/grounder log line for this run.
   * Typically a device serial. Helps distinguish concurrent/sequential runs
   * in the logs.
   */
  logContext?: string;
}

export interface AgentActionResult {
  iteration: number;
  action: string;
  reason: string;
  naturalLanguageAction?: string;
  analysis?: string;
  thought?: PlannerThought;
  actionPayload?: ActionPayload;
  success: boolean;
  errorMessage?: string;
  screenshot?: string;
  screenWidth?: number;
  screenHeight?: number;
  timestamp?: string;
  durationMs?: number;
  timing?: TimingMetadata;
  trace?: StepTrace;
  /**
   * Raw LLM call traces that happened during this step (planner + any
   * grounder / visual grounder calls). Consumers can forward these to
   * observability backends (e.g., Langfuse). Empty for steps with no
   * LLM activity.
   */
  llmCalls?: LLMCallTrace[];
}

export interface TestRecordingResult {
  filePath: string;
  startedAt: string;
  completedAt?: string;
}

export type ExecutionStatus = 'success' | 'failure' | 'aborted';

export interface TestExecutionResult {
  success: boolean;
  status: ExecutionStatus;
  message: string;
  terminalFailure?: TerminalFailureSignal;
  analysis?: string;
  platform: string;
  startedAt: string;
  completedAt: string;
  recording?: TestRecordingResult;
  deviceLog?: import('@finalrun/common').DeviceLogCaptureResult;
  steps: AgentActionResult[];
  totalIterations: number;
}

/**
 * Progress callback — called on each iteration. Supports both sync (CLI
 * terminal renderer) and async (cloud-server step persistence) consumers.
 * The executor awaits the callback so async consumers can safely perform
 * I/O (S3 uploads, DB writes) before the next iteration starts.
 */
export type ExecutionProgressCallback = (event: ExecutionProgressEvent) => void | Promise<void>;

export interface ExecutionProgressEvent {
  type: 'planning' | 'executing' | 'step_complete' | 'goal_complete' | 'error';
  iteration: number;
  totalIterations: number;
  status?: ExecutionStatus;
  action?: string;
  reason?: string;
  success?: boolean;
  message?: string;
  /** Full step result — available on `step_complete` events. */
  stepResult?: AgentActionResult;
}

interface DeviceState {
  screenshot: string;
  hierarchy: Hierarchy;
  screenWidth: number;
  screenHeight: number;
}

interface CaptureTraceMetadata {
  totalMs: number;
  stabilityMs?: number;
  finalPayloadMs: number;
  stable: boolean;
  pollCount: number;
  attempts: number;
  failureReason?: string;
}

interface PostActionCaptureResult {
  status: 'success' | 'transient' | 'fatal';
  screenshot?: string;
  screenWidth?: number;
  screenHeight?: number;
  captureTrace?: CaptureTraceMetadata;
  message?: string;
}

type DeviceStateCaptureResult =
  | {
      status: 'success';
      deviceState: DeviceState;
      captureTrace?: CaptureTraceMetadata;
    }
  | {
      status: 'transient' | 'fatal';
      message: string;
      captureTrace?: CaptureTraceMetadata;
    };

/**
 * Mutable state accumulated across iterations of one `executeGoal` run.
 * Created as a local per invocation and threaded explicitly through the
 * phase methods — never stored on the executor instance.
 */
interface GoalRunState {
  readonly startedAt: string;
  readonly maxIterations: number;
  history: string;
  remember: string[];
  consecutiveTransientCaptureFailures: number;
}

/** How a phase method directs the iteration loop in `executeGoal`. */
type PhaseOutcome<T> =
  | { kind: 'proceed'; value: T }
  | { kind: 'continue' }
  | { kind: 'return'; result: TestExecutionResult };

/** Per-iteration inputs shared by the action-phase methods. */
interface ActionStepContext {
  run: GoalRunState;
  iteration: number;
  stepTrace: StepTraceBuilder;
  deviceState: DeviceState;
  plannerResponse: PlannerResponse;
}

/** Optional result fields whose key presence varies per return path. */
interface TerminalResultExtras {
  analysis?: string;
  terminalFailure?: TerminalFailureSignal;
}

const MAX_CONSECUTIVE_TRANSIENT_CAPTURE_FAILURES = 2;

// ============================================================================
// TestExecutor
// ============================================================================

/**
 * Orchestrates the full goal execution loop:
 *   1. Capture device state (screenshot + hierarchy)
 *   2. Call AI planner → get next action
 *   3. Execute action via ActionExecutor
 *   4. Record result, check for done/failure
 *   5. Repeat
 *
 */
export class TestExecutor {
  private _config: TestExecutorConfig;
  private _actionExecutor: ActionExecutor;
  private _aborted = false;
  private _steps: AgentActionResult[] = [];

  constructor(config: TestExecutorConfig) {
    this._config = config;
    this._actionExecutor = new ActionExecutor({
      agent: config.agent,
      aiAgent: config.aiAgent,
      platform: config.platform,
      appIdentifier: config.appIdentifier,
      runtimeBindings: config.runtimeBindings,
      logContext: config.logContext,
    });
  }

  /**
   * Abort the goal execution.
   * The loop will stop after the current iteration completes.
   */
  abort(): void {
    this._aborted = true;
    Logger.i('Goal execution aborted');
  }

  /**
   * Backward-compatible alias for abort().
   */
  cancel(): void {
    this.abort();
  }

  /**
   * Execute the goal. Main entry point.
   * Runs the iteration loop; each phase of a step is handled by a
   * dedicated private method that reports back how to proceed.
   */
  async executeGoal(
    onProgress?: ExecutionProgressCallback,
  ): Promise<TestExecutionResult> {
    const run: GoalRunState = {
      startedAt: new Date().toISOString(),
      maxIterations: this._config.maxIterations ?? DEFAULT_MAX_ITERATIONS,
      history: '',
      remember: [],
      consecutiveTransientCaptureFailures: 0,
    };

    Logger.i(`Starting goal execution: "${this._config.goal}"`);
    Logger.i(`Max iterations: ${run.maxIterations}`);

    for (let iteration = 1; iteration <= run.maxIterations; iteration++) {
      const stepTrace = new StepTraceBuilder(iteration);

      if (this._aborted) {
        return this._terminalResult(run, 'aborted', 'Goal execution was aborted', iteration - 1);
      }

      const capture = await this._runCapturePhase(run, iteration, stepTrace, onProgress);
      if (capture.kind === 'return') {
        return capture.result;
      }
      if (capture.kind === 'continue') {
        continue;
      }

      const planning = await this._runPlanningPhase(
        run,
        iteration,
        stepTrace,
        capture.value,
        onProgress,
      );
      if (planning.kind === 'return') {
        return planning.result;
      }
      if (planning.kind === 'continue') {
        continue;
      }

      const terminalResult = await this._runActionPhase(
        run,
        iteration,
        stepTrace,
        capture.value,
        planning.value,
        onProgress,
      );
      if (terminalResult) {
        return terminalResult;
      }
    }

    Logger.w(`Max iterations (${run.maxIterations}) reached`);
    return this._terminalResult(
      run,
      'failure',
      `Max iterations (${run.maxIterations}) exceeded without completing the goal`,
      run.maxIterations,
    );
  }

  // ---------- private ----------

  /**
   * Build a final TestExecutionResult. `extras` is spread verbatim between
   * `message` and `platform` so each return path keeps the exact key set and
   * key order of its original inline literal.
   */
  private _terminalResult(
    run: GoalRunState,
    status: ExecutionStatus,
    message: string,
    totalIterations: number,
    extras: TerminalResultExtras = {},
  ): TestExecutionResult {
    return {
      success: status === 'success',
      status,
      message,
      ...extras,
      platform: this._config.platform,
      startedAt: run.startedAt,
      completedAt: new Date().toISOString(),
      steps: this._steps,
      totalIterations,
    };
  }

  /** Phase 1: capture device state (screenshot + hierarchy) and record its trace. */
  private async _runCapturePhase(
    run: GoalRunState,
    iteration: number,
    stepTrace: StepTraceBuilder,
    onProgress?: ExecutionProgressCallback,
  ): Promise<PhaseOutcome<DeviceState>> {
    await onProgress?.({
      type: 'planning',
      iteration,
      totalIterations: run.maxIterations,
      message: 'Capturing device state...',
    });

    const capturePhase = startTracePhase(iteration, 'capture.total');
    const captureResult = await this._captureDeviceState(iteration);
    const captureSpan = stepTrace.addSpanFromActivePhase(
      capturePhase,
      captureResult.status === 'success' ? 'success' : 'failure',
      captureResult.status === 'success' ? undefined : captureResult.message,
    );
    stepTrace.setAction('captureDeviceState');
    stepTrace.addSequentialTimings(this._captureTraceToTimings(captureResult.captureTrace), {
      startMs: captureSpan.startMs,
    });

    if (captureResult.status !== 'success') {
      return this._handleCaptureFailure(run, iteration, stepTrace, captureResult, onProgress);
    }

    run.consecutiveTransientCaptureFailures = 0;
    return { kind: 'proceed', value: captureResult.deviceState };
  }

  /** Record a capture failure step and decide: fatal/repeated → end the run, else retry. */
  private async _handleCaptureFailure(
    run: GoalRunState,
    iteration: number,
    stepTrace: StepTraceBuilder,
    captureResult: Extract<DeviceStateCaptureResult, { status: 'transient' | 'fatal' }>,
    onProgress?: ExecutionProgressCallback,
  ): Promise<PhaseOutcome<DeviceState>> {
    run.consecutiveTransientCaptureFailures += 1;
    stepTrace.markFailure(captureResult.message);
    const trace = this._emitTraceSummary(stepTrace);
    this._steps.push({
      iteration,
      action: 'captureDeviceState',
      reason: captureResult.message,
      naturalLanguageAction: 'Capture device state',
      success: false,
      errorMessage: captureResult.message,
      timestamp: new Date().toISOString(),
      durationMs: trace.totalMs,
      trace,
    });

    await onProgress?.({
      type: 'error',
      iteration,
      totalIterations: run.maxIterations,
      message: captureResult.message,
    });

    if (captureResult.status === 'fatal') {
      return {
        kind: 'return',
        result: this._terminalResult(run, 'failure', captureResult.message, iteration),
      };
    }

    Logger.w(
      `Transient device state capture failure (${run.consecutiveTransientCaptureFailures}/${MAX_CONSECUTIVE_TRANSIENT_CAPTURE_FAILURES}): ${captureResult.message}`,
    );
    if (run.consecutiveTransientCaptureFailures >= MAX_CONSECUTIVE_TRANSIENT_CAPTURE_FAILURES) {
      return {
        kind: 'return',
        result: this._terminalResult(
          run,
          'failure',
          `Repeated transient device state capture failures: ${captureResult.message}`,
          iteration,
        ),
      };
    }

    return { kind: 'continue' };
  }

  /** Phase 2: call the AI planner with accumulated history/memory and record its trace. */
  private async _runPlanningPhase(
    run: GoalRunState,
    iteration: number,
    stepTrace: StepTraceBuilder,
    deviceState: DeviceState,
    onProgress?: ExecutionProgressCallback,
  ): Promise<PhaseOutcome<PlannerResponse>> {
    await onProgress?.({
      type: 'planning',
      iteration,
      totalIterations: run.maxIterations,
      message: 'Thinking...',
    });

    const planningPhase = startTracePhase(iteration, 'planning.total');
    let plannerResponse: PlannerResponse;
    try {
      plannerResponse = await this._config.aiAgent.plan({
        testObjective: this._config.goal,
        platform: this._config.platform,
        preActionScreenshot: deviceState.screenshot,
        hierarchy: deviceState.hierarchy,
        history: run.history || undefined,
        remember: run.remember.length > 0 ? run.remember : undefined,
        preContext: this._config.preContext,
        appKnowledge: this._config.appKnowledge,
        traceStep: iteration,
        logContext: this._config.logContext,
      });
    } catch (error) {
      return this._handlePlannerError(run, iteration, stepTrace, planningPhase, error, onProgress);
    }

    const planningSpan = stepTrace.addSpanFromActivePhase(planningPhase, 'success');
    stepTrace.addSequentialTimings(this._plannerTraceToTimings(plannerResponse), {
      startMs: planningSpan.startMs,
    });

    Logger.i(
      `[${iteration}/${run.maxIterations}] \x1b[35mAction\x1b[0m: ${sanitizeLogField(plannerResponse.act)} — ${sanitizeLogField(plannerResponse.reason)}`,
    );
    stepTrace.setAction(plannerResponse.act);
    run.remember = plannerResponse.remember;

    return { kind: 'proceed', value: plannerResponse };
  }

  /** Record a planner-call failure step; terminal provider errors end the run. */
  private async _handlePlannerError(
    run: GoalRunState,
    iteration: number,
    stepTrace: StepTraceBuilder,
    planningPhase: ActiveTracePhase | null,
    error: unknown,
    onProgress?: ExecutionProgressCallback,
  ): Promise<PhaseOutcome<PlannerResponse>> {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const terminalFailure = terminalFailureFromError(error);
    Logger.e('Planner call failed:', error);
    const planningSpan = stepTrace.addSpanFromActivePhase(planningPhase, 'failure', errorMsg);
    stepTrace.setAction('plannerError');
    stepTrace.markFailure(errorMsg);
    stepTrace.addSequentialTimings(undefined, { startMs: planningSpan.startMs });
    const trace = this._emitTraceSummary(stepTrace);

    this._steps.push({
      iteration,
      action: 'plannerError',
      reason: errorMsg,
      naturalLanguageAction: 'Planner error',
      success: false,
      errorMessage: errorMsg,
      timestamp: new Date().toISOString(),
      durationMs: trace.totalMs,
      trace,
    });

    await onProgress?.({
      type: 'error',
      iteration,
      totalIterations: run.maxIterations,
      message: `Planner error: ${errorMsg}`,
    });

    if (terminalFailure) {
      Logger.e(terminalFailure.message);
      return {
        kind: 'return',
        result: this._terminalResult(run, 'failure', terminalFailure.message, iteration, {
          terminalFailure,
        }),
      };
    }

    return { kind: 'continue' };
  }

  /**
   * Phases 3-6: handle terminal planner verdicts, execute the planned action,
   * capture the post-action screenshot, and record the completed step.
   * Returns a final result when the run must end, undefined to keep iterating.
   */
  private async _runActionPhase(
    run: GoalRunState,
    iteration: number,
    stepTrace: StepTraceBuilder,
    deviceState: DeviceState,
    plannerResponse: PlannerResponse,
    onProgress?: ExecutionProgressCallback,
  ): Promise<TestExecutionResult | undefined> {
    const step: ActionStepContext = { run, iteration, stepTrace, deviceState, plannerResponse };
    const action = plannerResponse.act;

    if (action === PLANNER_ACTION_COMPLETED || action === PLANNER_ACTION_FAILED) {
      return this._finishGoalFromPlanner(step, onProgress);
    }

    await onProgress?.({
      type: 'executing',
      iteration,
      totalIterations: run.maxIterations,
      action,
      reason: plannerResponse.reason,
    });

    const actionResult = await this._executePlannedAction(step);
    if (actionResult.terminalFailure) {
      return this._reportActionTerminalFailure(step, actionResult.terminalFailure, onProgress);
    }

    const postActionCapture = await this._runPostCapturePhase(iteration, stepTrace);
    await this._recordStepCompletion(step, actionResult, postActionCapture, onProgress);
    return undefined;
  }

  /** The planner declared the goal completed or failed: record the final step and finish. */
  private async _finishGoalFromPlanner(
    step: ActionStepContext,
    onProgress?: ExecutionProgressCallback,
  ): Promise<TestExecutionResult> {
    const { run, iteration, stepTrace, deviceState, plannerResponse } = step;
    const succeeded = plannerResponse.act === PLANNER_ACTION_COMPLETED;
    if (succeeded) {
      Logger.i('✓ Goal completed successfully!');
    } else {
      Logger.w('✖ Goal failed: ' + plannerResponse.reason);
      stepTrace.markFailure(plannerResponse.reason);
    }

    const trace = this._emitTraceSummary(stepTrace);
    this._steps.push({
      iteration,
      action: plannerResponse.act,
      reason: plannerResponse.reason,
      naturalLanguageAction: plannerResponse.thought?.act ?? plannerResponse.reason,
      analysis: plannerResponse.analysis,
      thought: plannerResponse.thought,
      actionPayload: this._buildActionPayload(plannerResponse),
      success: succeeded,
      screenshot: deviceState.screenshot,
      screenWidth: deviceState.screenWidth,
      screenHeight: deviceState.screenHeight,
      timestamp: new Date().toISOString(),
      durationMs: trace.totalMs,
      trace,
    });

    await onProgress?.({
      type: 'goal_complete',
      iteration,
      totalIterations: run.maxIterations,
      status: succeeded ? 'success' : 'failure',
      action: plannerResponse.act,
      reason: plannerResponse.reason,
      success: succeeded,
    });

    return this._terminalResult(
      run,
      succeeded ? 'success' : 'failure',
      plannerResponse.reason,
      iteration,
      { analysis: plannerResponse.analysis },
    );
  }

  /** Phase 4: execute the planner's action on the device and record its trace. */
  private async _executePlannedAction(step: ActionStepContext): Promise<ActionOutput> {
    const { iteration, stepTrace, deviceState, plannerResponse } = step;
    const actionPhase = startTracePhase(iteration, 'action.total');
    const actionResult = await this._actionExecutor.executeAction({
      action: plannerResponse.act,
      reason: plannerResponse.reason,
      text: plannerResponse.text,
      clearText: plannerResponse.clearText,
      direction: plannerResponse.direction,
      durationSeconds: plannerResponse.durationSeconds,
      url: plannerResponse.url,
      repeat: plannerResponse.repeat,
      delayBetweenTapMs: plannerResponse.delayBetweenTapMs,
      screenshot: deviceState.screenshot,
      hierarchy: deviceState.hierarchy,
      screenWidth: deviceState.screenWidth,
      screenHeight: deviceState.screenHeight,
      traceStep: iteration,
    });

    const actionSpan = stepTrace.addSpanFromActivePhase(
      actionPhase,
      actionResult.success ? 'success' : 'failure',
      actionResult.error,
    );
    stepTrace.addSequentialTimings(actionResult.trace, { startMs: actionSpan.startMs });
    return actionResult;
  }

  /** A terminal AI-provider failure occurred during the action: record it and end the run. */
  private async _reportActionTerminalFailure(
    step: ActionStepContext,
    terminalFailure: TerminalFailureSignal,
    onProgress?: ExecutionProgressCallback,
  ): Promise<TestExecutionResult> {
    const { run, iteration, stepTrace, deviceState, plannerResponse } = step;
    stepTrace.markFailure(terminalFailure.message);
    const trace = this._emitTraceSummary(stepTrace);
    this._steps.push({
      iteration,
      action: plannerResponse.act,
      reason: plannerResponse.reason,
      naturalLanguageAction: plannerResponse.thought?.act ?? plannerResponse.reason,
      analysis: plannerResponse.analysis,
      thought: plannerResponse.thought,
      actionPayload: this._buildActionPayload(plannerResponse),
      success: false,
      errorMessage: terminalFailure.message,
      screenshot: deviceState.screenshot,
      screenWidth: deviceState.screenWidth,
      screenHeight: deviceState.screenHeight,
      timestamp: new Date().toISOString(),
      durationMs: trace.totalMs,
      trace,
    });

    Logger.e(terminalFailure.message);
    await onProgress?.({
      type: 'error',
      iteration,
      totalIterations: run.maxIterations,
      message: terminalFailure.message,
    });

    return this._terminalResult(run, 'failure', terminalFailure.message, iteration, {
      terminalFailure,
      analysis: plannerResponse.analysis,
    });
  }

  /** Phase 5: capture the post-action screenshot; failures are logged, never fatal. */
  private async _runPostCapturePhase(
    iteration: number,
    stepTrace: StepTraceBuilder,
  ): Promise<PostActionCaptureResult> {
    const postCapturePhase = startTracePhase(iteration, 'post_capture.total');
    const postActionCapture = await this._capturePostActionScreenshot(iteration);
    const postCaptureSpan = stepTrace.addSpanFromActivePhase(
      postCapturePhase,
      postActionCapture.status === 'success' ? 'success' : 'failure',
      postActionCapture.status === 'success' ? undefined : postActionCapture.message,
    );
    stepTrace.addSequentialTimings(
      this._captureTraceToTimings(postActionCapture.captureTrace, 'post_capture'),
      { startMs: postCaptureSpan.startMs },
    );

    if (postActionCapture.status !== 'success') {
      Logger.w(
        `Post-action screenshot capture failed for iteration ${iteration}: ${postActionCapture.message ?? 'unknown capture error'}`,
      );
    }

    return postActionCapture;
  }

  /**
   * Aggregate LLM calls for a step: planner call + any grounder/visual-grounder
   * calls made by ActionExecutor. Order: planner first, then action calls.
   */
  private _collectStepLLMCalls(
    plannerResponse: PlannerResponse,
    actionResult: ActionOutput,
  ): LLMCallTrace[] {
    const stepLLMCalls: LLMCallTrace[] = [];
    if (plannerResponse.llmCall) {
      stepLLMCalls.push(plannerResponse.llmCall);
    }
    if (actionResult.llmCalls && actionResult.llmCalls.length > 0) {
      stepLLMCalls.push(...actionResult.llmCalls);
    }
    return stepLLMCalls;
  }

  /** Phase 6: build the completed step record, emit progress, and extend history. */
  private async _recordStepCompletion(
    step: ActionStepContext,
    actionResult: ActionOutput,
    postActionCapture: PostActionCaptureResult,
    onProgress?: ExecutionProgressCallback,
  ): Promise<void> {
    const { run, iteration, stepTrace, deviceState, plannerResponse } = step;
    const stepLLMCalls = this._collectStepLLMCalls(plannerResponse, actionResult);
    const stepResult: AgentActionResult = {
      iteration,
      action: plannerResponse.act,
      reason: plannerResponse.reason,
      naturalLanguageAction: plannerResponse.thought?.act ?? plannerResponse.reason,
      analysis: plannerResponse.analysis,
      thought: plannerResponse.thought,
      actionPayload: this._buildActionPayload(plannerResponse),
      success: actionResult.success,
      errorMessage: actionResult.error,
      screenshot: postActionCapture.screenshot,
      screenWidth: postActionCapture.screenWidth ?? deviceState.screenWidth,
      screenHeight: postActionCapture.screenHeight ?? deviceState.screenHeight,
      timestamp: new Date().toISOString(),
      timing: actionResult.trace,
      ...(stepLLMCalls.length > 0 ? { llmCalls: stepLLMCalls } : {}),
    };

    if (!actionResult.success && actionResult.error) {
      stepTrace.markFailure(actionResult.error);
    }

    const trace = this._emitTraceSummary(stepTrace);
    stepResult.trace = trace;
    stepResult.durationMs = trace.totalMs;
    this._steps.push(stepResult);

    await onProgress?.({
      type: 'step_complete',
      iteration,
      totalIterations: run.maxIterations,
      action: plannerResponse.act,
      reason: plannerResponse.reason,
      success: actionResult.success,
      message: actionResult.error,
      stepResult,
    });

    const statusText = actionResult.success ? 'SUCCESS' : `FAILED: ${actionResult.error}`;
    run.history += `${iteration}. [${plannerResponse.act}] ${this._formatHistoryReason(plannerResponse)} → ${statusText}\n`;
  }

  /** Request a stabilized screenshot + hierarchy payload and parse its capture trace. */
  private async _requestCapture(traceStep: number): Promise<{
    response: Awaited<ReturnType<DeviceAgent['executeAction']>>;
    captureTrace: CaptureTraceMetadata | undefined;
  }> {
    const response = await this._config.agent.executeAction(
      new DeviceActionRequest({
        requestId: uuidv4(),
        action: new GetScreenshotAndHierarchyAction(),
        timeout: 30,
        shouldEnsureStability: true,
        traceStep,
      }),
    );

    const captureTrace = response.data
      ? this._parseCaptureTrace(response.data['captureTrace'])
      : undefined;

    return { response, captureTrace };
  }

  private _classifyCaptureFailure(
    message: string,
    captureTrace?: CaptureTraceMetadata,
  ): { status: 'transient' | 'fatal'; message: string; captureTrace?: CaptureTraceMetadata } {
    return {
      status: this._isTransientCaptureFailure(message) ? 'transient' : 'fatal',
      message,
      captureTrace,
    };
  }

  private async _captureDeviceState(
    traceStep: number,
  ): Promise<DeviceStateCaptureResult> {
    try {
      const { response, captureTrace } = await this._requestCapture(traceStep);

      if (!response.success || !response.data) {
        return this._classifyCaptureFailure(
          response.message ?? 'Failed to capture device state',
          captureTrace,
        );
      }

      const data = response.data;
      const screenshot = data['screenshot'] as string;
      const hierarchyStr = data['hierarchy'] as string;
      const screenWidth = data['screenWidth'] as number;
      const screenHeight = data['screenHeight'] as number;

      if (!screenshot?.trim()) {
        return {
          status: 'transient',
          message: 'Empty screenshot from device capture',
          captureTrace,
        };
      }

      if (!hierarchyStr?.trim()) {
        return {
          status: 'transient',
          message: 'Missing hierarchy from device capture',
          captureTrace,
        };
      }

      return {
        status: 'success',
        captureTrace,
        deviceState: {
          screenshot,
          hierarchy: Hierarchy.fromJsonString(hierarchyStr),
          screenWidth,
          screenHeight,
        },
      };
    } catch (error) {
      return this._classifyCaptureFailure(error instanceof Error ? error.message : String(error));
    }
  }

  private _emitTraceSummary(stepTrace: StepTraceBuilder): StepTrace {
    const trace = stepTrace.build();
    Logger.d(formatStepTraceSummary(trace));
    return trace;
  }

  private _captureTraceToTimings(
    captureTrace: CaptureTraceMetadata | undefined,
    prefix: 'capture' | 'post_capture' = 'capture',
  ): TimingMetadata | undefined {
    if (!captureTrace) {
      return undefined;
    }

    const spans: SpanTiming[] = [];
    if (captureTrace.stabilityMs !== undefined) {
      spans.push({
        name: `${prefix}.stability`,
        durationMs: captureTrace.stabilityMs,
        status: captureTrace.stable ? 'success' : 'failure',
        detail: `polls=${captureTrace.pollCount}`,
      });
    }

    spans.push({
      name: `${prefix}.final_payload`,
      durationMs: captureTrace.finalPayloadMs,
      status: captureTrace.failureReason ? 'failure' : 'success',
      detail:
        `attempts=${captureTrace.attempts}` +
        (captureTrace.failureReason ? ` reason=${captureTrace.failureReason}` : ''),
    });

    return {
      totalMs: captureTrace.totalMs,
      spans,
    };
  }

  private async _capturePostActionScreenshot(
    traceStep: number,
  ): Promise<PostActionCaptureResult> {
    try {
      const { response, captureTrace } = await this._requestCapture(traceStep);

      if (!response.success || !response.data) {
        return this._classifyCaptureFailure(
          response.message ?? 'Failed to capture post-action screenshot',
          captureTrace,
        );
      }

      const data = response.data;
      const screenshot = data['screenshot'] as string | undefined;
      if (!screenshot?.trim()) {
        return {
          status: 'transient',
          message: 'Empty screenshot from post-action capture',
          captureTrace,
        };
      }

      return {
        status: 'success',
        screenshot,
        screenWidth:
          typeof data['screenWidth'] === 'number' ? (data['screenWidth'] as number) : undefined,
        screenHeight:
          typeof data['screenHeight'] === 'number' ? (data['screenHeight'] as number) : undefined,
        captureTrace,
      };
    } catch (error) {
      return this._classifyCaptureFailure(error instanceof Error ? error.message : String(error));
    }
  }

  private _plannerTraceToTimings(
    plannerResponse: PlannerResponse,
  ): TimingMetadata | undefined {
    if (!plannerResponse.trace) {
      return undefined;
    }

    return {
      totalMs: plannerResponse.trace.totalMs,
      spans: [
        {
          name: 'planning.llm',
          durationMs: plannerResponse.trace.promptBuildMs + plannerResponse.trace.llmMs,
          status: 'success',
          detail:
            `prompt=${plannerResponse.trace.promptBuildMs}ms ` +
            `model=${plannerResponse.trace.llmMs}ms`,
        },
        {
          name: 'planning.parse',
          durationMs: plannerResponse.trace.parseMs,
          status: 'success',
        },
      ],
    };
  }

  private _parseCaptureTrace(value: unknown): CaptureTraceMetadata | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }

    const record = value as Record<string, unknown>;
    const totalMs = toNumber(record['totalMs']);
    const finalPayloadMs = toNumber(record['finalPayloadMs']);
    if (totalMs === undefined || finalPayloadMs === undefined) {
      return undefined;
    }

    return {
      totalMs,
      stabilityMs: toNumber(record['stabilityMs']),
      finalPayloadMs,
      stable: Boolean(record['stable']),
      pollCount: toNumber(record['pollCount']) ?? 0,
      attempts: toNumber(record['attempts']) ?? 0,
      failureReason:
        typeof record['failureReason'] === 'string'
          ? record['failureReason']
          : undefined,
    };
  }

  private _isTransientCaptureFailure(message: string): boolean {
    const normalized = message.toLowerCase();
    return (
      normalized.includes('uiautomation not connected') ||
      normalized.includes('unavailable') ||
      normalized.includes('no connection established') ||
      normalized.includes('empty screenshot') ||
      normalized.includes('missing hierarchy') ||
      normalized.includes('invalid hierarchy')
    );
  }

  private _formatHistoryReason(plannerResponse: PlannerResponse): string {
    const details: string[] = [];

    if (plannerResponse.text) {
      details.push(`text="${plannerResponse.text}"`);
    }
    if (plannerResponse.direction) {
      details.push(`direction=${plannerResponse.direction}`);
    }
    if (plannerResponse.durationSeconds !== undefined) {
      details.push(`duration=${plannerResponse.durationSeconds}s`);
    }
    if (plannerResponse.url) {
      details.push(`url=${plannerResponse.url}`);
    }
    if (plannerResponse.repeat !== undefined) {
      details.push(`repeat=${plannerResponse.repeat}`);
    }
    if (plannerResponse.delayBetweenTapMs !== undefined) {
      details.push(`delayBetweenTapMs=${plannerResponse.delayBetweenTapMs}`);
    }

    if (details.length === 0) {
      return plannerResponse.reason;
    }

    return `${plannerResponse.reason} (${details.join(', ')})`;
  }

  private _buildActionPayload(
    plannerResponse: PlannerResponse,
  ): ActionPayload | undefined {
    const payload: ActionPayload = {
      text: plannerResponse.text,
      url: plannerResponse.url,
      direction: plannerResponse.direction,
      clearText: plannerResponse.clearText,
      durationSeconds: plannerResponse.durationSeconds,
      repeat: plannerResponse.repeat,
      delayBetweenTapMs: plannerResponse.delayBetweenTapMs,
    };

    return Object.values(payload).some((value) => value !== undefined)
      ? payload
      : undefined;
  }
}

function toNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return undefined;
  }

  return Math.max(0, Math.round(value));
}
