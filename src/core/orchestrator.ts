import { randomUUID } from 'node:crypto';
import type { DispatcherTask, TaskStatus } from '../models/task.js';
import type { ProviderId } from '../models/provider.js';
import type { TaskResult } from '../models/result.js';
import type { ValidationResult } from '../models/validation.js';
import type { ReviewResult } from '../models/review.js';
import type { RoutingDecision } from '../models/routing.js';
import { DispatcherError, isDispatcherError } from '../models/error.js';
import { transition } from './state-machine.js';
import { classifyTask } from '../task/classifier.js';
import { buildTaskContext } from '../project/context-builder.js';
import type { ProviderRegistry } from '../providers/types.js';
import { UsageTracker } from '../routing/usage-tracker.js';
import type { UsageStore } from '../routing/usage-store.js';
import { selectProvider } from '../routing/router.js';
import { CircuitBreaker } from '../routing/circuit-breaker.js';
import { computeBackoffMs, shouldRetry } from '../routing/retry-policy.js';
import { nextFallbackProvider, assertProvidersNotExhausted } from '../routing/fallback.js';
import { executeOnce } from './dispatch-execution.js';
import { runValidationPipeline } from '../validation/pipeline.js';
import { runFixLoop } from '../validation/fix-loop.js';
import { runReview, hasBlockingFindings } from '../review/review-coordinator.js';
import type { AuditLogger } from '../logging/audit.js';
import type { DispatcherConfig } from '../config/schema.js';

export type FinalVerdict =
  | 'SUCCESS'
  | 'SUCCESS_WITH_WARNING'
  | 'FAILED_VALIDATION'
  | 'FAILED_REVIEW'
  | 'FAILED_PROVIDER'
  | 'CANCELLED';

export interface OrchestratorDeps {
  providers: ProviderRegistry;
  usageStore: UsageStore;
  auditLogger: AuditLogger;
  config: DispatcherConfig;
}

export interface TaskOutcome {
  task: DispatcherTask;
  routing: RoutingDecision;
  attempts: Array<{ executionId: string; provider: ProviderId; result: TaskResult }>;
  validation?: ValidationResult;
  review?: ReviewResult;
  verdict: FinalVerdict;
}

const CODE_CHANGING_COMMANDS = new Set<DispatcherTask['command']>(['fix', 'implement']);

export class Orchestrator {
  private readonly circuitBreaker = new CircuitBreaker();
  private readonly usageTracker: UsageTracker;

  constructor(private readonly deps: OrchestratorDeps) {
    this.usageTracker = new UsageTracker(deps.usageStore);
  }

  async runTask(task: DispatcherTask, opts: { forcedProvider?: ProviderId; dryRun?: boolean } = {}): Promise<TaskOutcome> {
    const audit = this.deps.auditLogger;
    await audit.record(task.id, 'task.created', { command: task.command });

    task.status = transition(task.status, 'classifying', { taskId: task.id });
    const classification = classifyTask(task);
    task.classification = classification;
    await audit.record(task.id, 'task.classified', { type: classification.type, confidence: classification.confidence });

    task.status = transition(task.status, 'loading_context', { taskId: task.id });
    const context = await buildTaskContext(task);
    await audit.record(task.id, 'project.context.loaded', { language: context.project?.language });

    task.status = transition(task.status, 'selecting_provider', { taskId: task.id });
    const routing = await selectProvider(this.deps.providers, this.usageTracker, {
      taskId: task.id,
      classification,
      forcedProvider: opts.forcedProvider,
    });
    await audit.record(task.id, 'provider.selected', { provider: routing.selected, reasons: routing.reasons });

    if (opts.dryRun) {
      return { task, routing, attempts: [], verdict: 'SUCCESS' };
    }

    task.status = transition(task.status, 'running', { taskId: task.id });
    const { attempts, finalResult } = await this.dispatchWithRetryAndFallback(task, context, routing);

    if (finalResult.status !== 'success' && finalResult.status !== 'success_with_warning') {
      task.status = transition(task.status, 'failed', { taskId: task.id });
      await audit.record(task.id, 'task.failed', { error: finalResult.error });
      return { task, routing, attempts, verdict: 'FAILED_PROVIDER' };
    }

    if (!CODE_CHANGING_COMMANDS.has(task.command)) {
      task.status = transition(task.status, 'validating', { taskId: task.id });
      task.status = transition(task.status, 'reviewing', { taskId: task.id });
      task.status = transition(task.status, 'completed', { taskId: task.id });
      await audit.record(task.id, 'task.completed', { verdict: 'SUCCESS' });
      return { task, routing, attempts, verdict: 'SUCCESS' };
    }

    return this.validateAndReview(task, context, routing, attempts);
  }

  private async dispatchWithRetryAndFallback(
    task: DispatcherTask,
    context: Awaited<ReturnType<typeof buildTaskContext>>,
    routing: RoutingDecision,
  ): Promise<{ attempts: TaskOutcome['attempts']; finalResult: TaskResult }> {
    const audit = this.deps.auditLogger;
    const attempted: ProviderId[] = [];
    const attempts: TaskOutcome['attempts'] = [];
    let currentProvider = routing.selected;

    for (;;) {
      assertProvidersNotExhausted(routing, attempted, task.id);
      attempted.push(currentProvider);
      const provider = this.deps.providers.get(currentProvider);

      let attempt = 0;
      let lastResult: TaskResult | undefined;
      for (;;) {
        await audit.record(task.id, 'provider.execution.started', { provider: currentProvider, attempt });
        const startedAt = new Date().toISOString();

        try {
          const { executionId, result } = await executeOnce(
            provider,
            task,
            context,
            {
              sandbox: this.deps.config.execution.sandbox,
              approval: this.deps.config.execution.approval,
              timeoutMs: task.timeoutMs ?? this.deps.config.execution.timeoutMs,
            },
            { saveFailureArtifacts: this.deps.config.diagnostics.saveFailureArtifacts },
          );
          attempts.push({ executionId, provider: currentProvider, result });
          lastResult = result;

          await this.deps.usageStore.record({
            provider: currentProvider,
            taskId: task.id,
            executionId,
            outcome: result.status === 'success' || result.status === 'success_with_warning' ? 'success' : result.status === 'timeout' ? 'timeout' : 'failure',
            startedAt,
            finishedAt: new Date().toISOString(),
            durationMs: result.durationMs,
            inputTokens: result.usage?.actualInputTokens,
            outputTokens: result.usage?.actualOutputTokens,
            costUsd: result.usage?.estimatedCostUsd,
          });

          if (result.status === 'success' || result.status === 'success_with_warning') {
            this.circuitBreaker.recordSuccess(currentProvider);
            await audit.record(task.id, 'provider.execution.completed', { provider: currentProvider, status: result.status });
            return { attempts, finalResult: result };
          }

          this.circuitBreaker.recordFailure(currentProvider);
          const eventType = result.status === 'timeout' ? 'provider.execution.timeout' : 'provider.execution.failed';
          await audit.record(task.id, eventType, { provider: currentProvider, error: result.error });

          const asError = new DispatcherError({
            code: result.status === 'timeout' ? 'PROCESS_TIMEOUT' : 'PROVIDER_UNREACHABLE',
            message: result.error?.message ?? 'Provider execution failed.',
            taskId: task.id,
            provider: currentProvider,
            retryable: result.status !== 'auth_error',
          });

          if (shouldRetry(attempt, asError, { maxRetries: this.deps.config.retry.maxRetries, baseDelayMs: 1000, maxDelayMs: 15000 })) {
            await audit.record(task.id, 'retry.started', { provider: currentProvider, attempt: attempt + 1 });
            await delay(computeBackoffMs(attempt));
            await audit.record(task.id, 'retry.completed', { provider: currentProvider });
            attempt += 1;
            continue;
          }
          break;
        } catch (cause) {
          const error = isDispatcherError(cause) ? cause : new DispatcherError({
            code: 'PROCESS_START_FAILED',
            message: (cause as Error).message,
            cause,
            taskId: task.id,
            provider: currentProvider,
            retryable: true,
          });
          this.circuitBreaker.recordFailure(currentProvider);
          await audit.record(task.id, 'provider.execution.failed', { provider: currentProvider, error: error.toJSON() });

          if (shouldRetry(attempt, error, { maxRetries: this.deps.config.retry.maxRetries, baseDelayMs: 1000, maxDelayMs: 15000 })) {
            await audit.record(task.id, 'retry.started', { provider: currentProvider, attempt: attempt + 1 });
            await delay(computeBackoffMs(attempt));
            await audit.record(task.id, 'retry.completed', { provider: currentProvider });
            attempt += 1;
            continue;
          }
          lastResult = {
            taskId: task.id,
            executionId: `exec_${randomUUID()}`,
            provider: currentProvider,
            status: 'failed',
            durationMs: 0,
            error: { code: error.code, message: error.message },
          };
          break;
        }
      }

      if (!this.deps.config.fallback.enabled) {
        return { attempts, finalResult: lastResult ?? failedResult(task.id, currentProvider, 'Execution failed, fallback disabled.') };
      }

      await audit.record(task.id, 'fallback.started', { from: currentProvider });
      const next = nextFallbackProvider(routing, attempted, this.circuitBreaker);
      if (!next) {
        return { attempts, finalResult: lastResult ?? failedResult(task.id, currentProvider, 'All providers exhausted.') };
      }
      await audit.record(task.id, 'fallback.completed', { to: next });
      currentProvider = next;
    }
  }

  private async validateAndReview(
    task: DispatcherTask,
    context: Awaited<ReturnType<typeof buildTaskContext>>,
    routing: RoutingDecision,
    attempts: TaskOutcome['attempts'],
  ): Promise<TaskOutcome> {
    const audit = this.deps.auditLogger;

    task.status = transition(task.status, 'validating', { taskId: task.id });
    await audit.record(task.id, 'validation.started', {});

    if (!context.project) {
      throw new DispatcherError({ code: 'INTERNAL_LOGIC_ERROR', message: 'Project context missing.', taskId: task.id, retryable: false });
    }

    const implementerId = attempts.at(-1)?.provider ?? routing.selected;
    const runValidation = () => this.runValidationForTask(task, context.project!);

    let validation = await runValidation();

    if (!validation.passed) {
      task.status = transition(task.status, 'fixing', { taskId: task.id });
      await audit.record(task.id, 'fix.started', { failedStage: validation.failedStage });

      validation = await runFixLoop(
        validation,
        runValidation,
        async (failedResult) => {
          const fixContext = { ...context, validationResults: [failedResult] };
          const implementer = this.deps.providers.get(implementerId);
          const { result } = await executeOnce(
            implementer,
            task,
            fixContext,
            {
              sandbox: this.deps.config.execution.sandbox,
              approval: this.deps.config.execution.approval,
              timeoutMs: this.deps.config.execution.timeoutMs,
            },
            { saveFailureArtifacts: this.deps.config.diagnostics.saveFailureArtifacts },
          );
          if (result.status !== 'success' && result.status !== 'success_with_warning') {
            throw new DispatcherError({ code: 'VALIDATION_FAILED', message: 'Fix attempt did not succeed.', taskId: task.id, retryable: false });
          }
        },
        { maxIterations: this.deps.config.validation.maxFixAttempts },
      );
      task.status = transition(task.status, 'validating', { taskId: task.id });
      await audit.record(task.id, validation.passed ? 'fix.completed' : 'validation.failed', { passed: validation.passed });
    }

    await audit.record(task.id, validation.passed ? 'validation.passed' : 'validation.failed', { failedStage: validation.failedStage });

    if (!validation.passed) {
      task.status = transition(task.status, 'failed', { taskId: task.id });
      await audit.record(task.id, 'task.failed', { reason: 'validation' });
      return { task, routing, attempts, validation, verdict: 'FAILED_VALIDATION' };
    }

    if (!this.deps.config.review.enabled) {
      task.status = transition(task.status, 'reviewing', { taskId: task.id });
      task.status = transition(task.status, 'completed', { taskId: task.id });
      await audit.record(task.id, 'task.completed', { verdict: 'SUCCESS' });
      return { task, routing, attempts, validation, verdict: 'SUCCESS' };
    }

    task.status = transition(task.status, 'reviewing', { taskId: task.id });
    await audit.record(task.id, 'review.started', {});

    const reviewerId = this.pickReviewer(implementerId, routing);
    const independentReview = reviewerId !== implementerId;

    let review: ReviewResult | undefined;
    let cycle = 0;
    for (;;) {
      cycle += 1;
      const reviewer = this.deps.providers.get(reviewerId);
      review = await runReview({
        task,
        implementer: implementerId,
        reviewer: reviewerId,
        independentReview,
        diff: validation.gitDiff ?? { changedFiles: [], addedFiles: [], deletedFiles: [], protectedPathsTouched: [] },
        cycle,
        dispatchReview: async (promptText) => {
          const reviewTask: DispatcherTask = { ...task, specification: { ...task.specification, rawDescription: promptText } };
          const { result } = await executeOnce(
            reviewer,
            reviewTask,
            context,
            { sandbox: 'read-only', approval: 'never', timeoutMs: this.deps.config.execution.timeoutMs },
            { saveFailureArtifacts: this.deps.config.diagnostics.saveFailureArtifacts },
          );
          return result;
        },
      });

      if (!hasBlockingFindings(review)) break;
      if (cycle > this.deps.config.review.maxReviewCycles) {
        await audit.record(task.id, 'review.failed', { reason: 'max cycles exceeded' });
        break;
      }

      task.status = transition(task.status, 'fixing', { taskId: task.id });
      const implementer = this.deps.providers.get(implementerId);
      const reviewFixContext = { ...context, reviewResults: [review] };
      await executeOnce(
        implementer,
        task,
        reviewFixContext,
        {
          sandbox: this.deps.config.execution.sandbox,
          approval: this.deps.config.execution.approval,
          timeoutMs: this.deps.config.execution.timeoutMs,
        },
        { saveFailureArtifacts: this.deps.config.diagnostics.saveFailureArtifacts },
      );
      validation = await runValidation();
      task.status = transition(task.status, 'validating', { taskId: task.id });
      if (!validation.passed) {
        task.status = transition(task.status, 'failed', { taskId: task.id });
        await audit.record(task.id, 'task.failed', { reason: 'validation-after-review-fix' });
        return { task, routing, attempts, validation, review, verdict: 'FAILED_VALIDATION' };
      }
      task.status = transition(task.status, 'reviewing', { taskId: task.id });
    }

    await audit.record(task.id, 'review.completed', { verdict: review.verdict });

    const verdict: FinalVerdict = hasBlockingFindings(review) ? 'FAILED_REVIEW' : review.findings.length > 0 ? 'SUCCESS_WITH_WARNING' : 'SUCCESS';
    task.status = transition(task.status, verdict === 'FAILED_REVIEW' ? 'failed' : 'completed', { taskId: task.id });
    await audit.record(task.id, verdict === 'FAILED_REVIEW' ? 'task.failed' : 'task.completed', { verdict });

    return { task, routing, attempts, validation, review, verdict };
  }

  /** Prefers the non-implementer provider when it's eligible (spec section 59); falls back to self-review otherwise. */
  private pickReviewer(implementerId: ProviderId, routing: RoutingDecision): ProviderId {
    if (!this.deps.config.review.preferIndependentReviewer) return implementerId;
    const other = routing.scores.find((s) => s.provider !== implementerId && s.eligible);
    return other?.provider ?? implementerId;
  }

  /**
   * The single call site for running the validation pipeline, so config.validation.
   * commands is always threaded through - having three separate inline call sites
   * previously let one of them silently omit commandOverrides, which meant a
   * configured custom test command was ignored and validation trivially "passed" by
   * falling through to project-analyzer auto-detection (empty commands on a bare
   * repo). Caught by tests/unit/orchestrator.test.ts, fixed here structurally rather
   * than by re-copying the options object a third time.
   */
  private runValidationForTask(task: DispatcherTask, project: NonNullable<Awaited<ReturnType<typeof buildTaskContext>>['project']>) {
    return runValidationPipeline({
      taskId: task.id,
      cwd: task.workingDirectory,
      project,
      protectedPaths: this.deps.config.safety.protectedPaths,
      commandOverrides: this.deps.config.validation.commands,
    });
  }
}

function failedResult(taskId: string, provider: ProviderId, message: string): TaskResult {
  return {
    taskId,
    executionId: `exec_${randomUUID()}`,
    provider,
    status: 'failed',
    durationMs: 0,
    error: { message },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type { TaskStatus };
