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
import { RepositoryLock, type RepositoryLockHandle } from '../safety/repository-lock.js';
import { acquireWorkspace, releaseWorkspace, type AcquiredWorkspace } from '../safety/workspace.js';
import { checkBaseRevisionUnchanged } from '../safety/base-revision.js';
import { checkContentHashesUnchanged } from '../safety/content-hash-lock.js';
import { computeChangeScope } from '../safety/change-scope.js';
import { classifyRisk } from '../safety/risk-classifier.js';
import { decideAutoApply, type CompletionEvidence } from '../safety/auto-apply-gate.js';
import { applyWorkspaceChanges } from '../safety/patch-apply.js';
import { buildExecutionPlan } from '../task/execution-planner.js';
import { resolveExecutionBudget, type ExecutionBudget } from '../execution/budget.js';
import type { ProcessActivity } from '../process/process-runner.js';

export type FinalVerdict =
  | 'SUCCESS'
  | 'SUCCESS_WITH_WARNING'
  | 'FAILED_VALIDATION'
  | 'FAILED_REVIEW'
  | 'FAILED_PROVIDER'
  | 'CANCELLED'
  // Local LLM Adapter + Hardening increment: the task itself succeeded (validation
  // passed, review non-blocking) in an isolated workspace, but safety/policy state
  // withheld the automatic apply into the real repository - see safety/auto-apply-gate.ts.
  | 'BLOCKED_BY_POLICY';

export type ChangeDisposition =
  | 'planned'
  | 'applied'
  | 'withheld'
  | 'discarded'
  | 'left-in-place'
  | 'no-code-change'
  | 'unknown';

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
  /** What happened to code changes, separately from whether the task succeeded. */
  changeDisposition?: ChangeDisposition;
}

const CODE_CHANGING_COMMANDS = new Set<DispatcherTask['command']>(['fix', 'implement']);

export class Orchestrator {
  private readonly circuitBreaker: CircuitBreaker;
  private readonly usageTracker: UsageTracker;
  private readonly repositoryLock = new RepositoryLock();

  constructor(private readonly deps: OrchestratorDeps) {
    this.usageTracker = new UsageTracker(deps.usageStore);
    this.circuitBreaker = new CircuitBreaker(deps.config.circuitBreaker);
  }

  async runTask(task: DispatcherTask, opts: { forcedProvider?: ProviderId; dryRun?: boolean } = {}): Promise<TaskOutcome> {
    const audit = this.deps.auditLogger;
    await audit.record(task.id, 'task.created', { command: task.command });

    task.status = transition(task.status, 'classifying', { taskId: task.id });
    task.status = transition(task.status, 'loading_context', { taskId: task.id });
    const context = await buildTaskContext(task);
    await audit.record(task.id, 'project.context.loaded', { language: context.project?.language });

    const classification = classifyTask(task, context.project);
    task.classification = classification;
    task.executionPlan = buildExecutionPlan(task, classification, context.project);
    const budget = this.executionBudget(task);
    await audit.record(task.id, 'task.classified', {
      type: classification.type,
      confidence: classification.confidence,
      scope: classification.scope,
      complexity: classification.estimatedComplexity,
      repositoryMetrics: context.project?.metrics,
    });
    await audit.record(task.id, 'task.plan.created', {
      intent: task.executionPlan.intent,
      scope: task.executionPlan.scope,
      workUnits: task.executionPlan.workUnits,
      budget,
    });

    task.status = transition(task.status, 'selecting_provider', { taskId: task.id });
    const routing = await selectProvider(this.deps.providers, this.usageTracker, {
      taskId: task.id,
      classification,
      forcedProvider: opts.forcedProvider,
      weights: this.deps.config.routing.weights,
      isProviderAvailable: (provider) => this.circuitBreaker.canAttempt(provider),
    });
    await audit.record(task.id, 'provider.selected', { provider: routing.selected, reasons: routing.reasons });

    if (opts.dryRun) {
      task.status = transition(task.status, 'running', { taskId: task.id });
      task.status = transition(task.status, 'validating', { taskId: task.id });
      task.status = transition(task.status, 'reviewing', { taskId: task.id });
      task.status = transition(task.status, 'completed', { taskId: task.id });
      await audit.record(task.id, 'task.completed', { verdict: 'SUCCESS', dryRun: true });
      return { task, routing, attempts: [], verdict: 'SUCCESS', changeDisposition: 'planned' };
    }

    task.status = transition(task.status, 'running', { taskId: task.id });

    // Local LLM Adapter + Hardening increment: code-changing commands, with
    // workspace isolation enabled (the default), run through the isolated-worktree
    // + safety-gate path below instead of executing directly against the real
    // repository. Everything else - ask/analyze/review, dry-run, and fix/implement
    // when an operator has explicitly disabled workspaceIsolation - takes the exact
    // v1.0 path underneath this branch, unchanged.
    if (CODE_CHANGING_COMMANDS.has(task.command) && this.deps.config.safety.workspaceIsolation.enabled) {
      return this.runIsolatedCodeChangingTask(task, context, routing);
    }

    const { attempts, finalResult } = await this.dispatchWithRetryAndFallback(task, context, routing);

    if (finalResult.status !== 'success' && finalResult.status !== 'success_with_warning') {
      task.status = transition(task.status, 'failed', { taskId: task.id });
      await audit.record(task.id, 'task.failed', { error: finalResult.error });
      return {
        task,
        routing,
        attempts,
        verdict: 'FAILED_PROVIDER',
        changeDisposition: CODE_CHANGING_COMMANDS.has(task.command) ? 'left-in-place' : 'no-code-change',
      };
    }

    if (!CODE_CHANGING_COMMANDS.has(task.command)) {
      task.status = transition(task.status, 'validating', { taskId: task.id });
      task.status = transition(task.status, 'reviewing', { taskId: task.id });
      task.status = transition(task.status, 'completed', { taskId: task.id });
      await audit.record(task.id, 'task.completed', { verdict: 'SUCCESS' });
      return { task, routing, attempts, verdict: 'SUCCESS', changeDisposition: 'no-code-change' };
    }

    const outcome = await this.validateAndReview(task, context, routing, attempts);
    return {
      ...outcome,
      changeDisposition:
        outcome.verdict === 'SUCCESS' || outcome.verdict === 'SUCCESS_WITH_WARNING' ? 'applied' : 'left-in-place',
    };
  }

  /**
   * Isolated-workspace path for fix/implement with workspaceIsolation enabled:
   * acquire an exclusive repository lock + a real `git worktree` checkout, run the
   * exact same dispatch/validate/review logic as the non-isolated path against
   * that worktree (task.workingDirectory is temporarily repointed there, restored
   * in the finally block - every downstream call site already reads
   * task.workingDirectory as its single source of truth, so nothing else needs to
   * change), then decide AUTO_APPLY / BLOCKED_BY_POLICY via the safety gate before
   * ever touching the real repository. The real working tree is never reset,
   * checked out, or cleaned - only patch-apply.ts's `git apply` (through
   * process-runner) ever writes to it, and only after AUTO_APPLY.
   */
  private async runIsolatedCodeChangingTask(
    task: DispatcherTask,
    context: Awaited<ReturnType<typeof buildTaskContext>>,
    routing: RoutingDecision,
  ): Promise<TaskOutcome> {
    const audit = this.deps.auditLogger;
    const repositoryId = task.workingDirectory;
    const realWorkingDirectory = task.workingDirectory;

    let handle: RepositoryLockHandle;
    try {
      handle = this.repositoryLock.acquire(repositoryId, task.id);
      await audit.record(task.id, 'repository.lock.acquired', { repositoryId });
    } catch (cause) {
      await audit.record(task.id, 'repository.lock.blocked', { repositoryId, error: (cause as Error).message });
      throw cause;
    }

    let workspace: AcquiredWorkspace | undefined;
    try {
      workspace = await acquireWorkspace(realWorkingDirectory, task.id);
      await audit.record(task.id, 'workspace.acquired', { worktreeDir: workspace.worktreeDir, baseRevision: workspace.baseRevision });

      task.workingDirectory = workspace.worktreeDir;

      // artifactRoot pins failure-artifact writes to the REAL repository, not
      // task.workingDirectory (now the worktree) - see ExecuteOnceOptions.artifactRoot's
      // comment in dispatch-execution.ts. Without this, a failed attempt's
      // .dispatcher/runs/<executionId>/ would be written inside the worktree and
      // deleted along with it by releaseWorkspace() in the finally block below,
      // silently losing exactly the diagnostic info this feature exists to keep.
      const { attempts, finalResult } = await this.dispatchWithRetryAndFallback(task, context, routing, realWorkingDirectory);

      if (finalResult.status !== 'success' && finalResult.status !== 'success_with_warning') {
        task.status = transition(task.status, 'failed', { taskId: task.id });
        await audit.record(task.id, 'task.failed', { error: finalResult.error });
        return { task, routing, attempts, verdict: 'FAILED_PROVIDER', changeDisposition: 'discarded' };
      }

      const outcome = await this.validateAndReview(task, context, routing, attempts, realWorkingDirectory);
      if (outcome.verdict !== 'SUCCESS' && outcome.verdict !== 'SUCCESS_WITH_WARNING') {
        // Validation or review failed inside the isolated worktree - nothing to
        // apply. The worktree (and whatever the AI changed in it) is discarded
        // when the finally block below releases it; the real repository was never
        // touched.
        return { ...outcome, changeDisposition: 'discarded' };
      }

      const changeScope = await computeChangeScope(workspace.worktreeDir);
      await audit.record(task.id, 'change_scope.computed', {
        filesChanged: changeScope.filesChanged,
        linesAdded: changeScope.linesAdded,
        linesDeleted: changeScope.linesDeleted,
      });

      const risk = classifyRisk({
        taskType: task.classification?.type ?? 'implementation',
        changeScope,
        gitDiff: outcome.validation?.gitDiff ?? { changedFiles: [], addedFiles: [], deletedFiles: [], protectedPathsTouched: [] },
        blastRadius: this.deps.config.safety.blastRadius,
      });
      await audit.record(task.id, 'risk.classified', { level: risk.level, reasons: risk.reasons });

      const [revisionCheck, hashCheck] = await Promise.all([
        checkBaseRevisionUnchanged(realWorkingDirectory, workspace.baseRevision),
        checkContentHashesUnchanged(realWorkingDirectory, workspace.baseRevision, changeScope.files),
      ]);

      const evidence: CompletionEvidence = {
        autoApplyEnabled: this.deps.config.safety.autoApply.enabled,
        requireIndependentReview: this.deps.config.safety.autoApply.requireIndependentReview,
        independentReview: outcome.review?.independentReview ?? false,
        validationPassed: outcome.validation?.passed ?? false,
        reviewBlocking: outcome.review ? hasBlockingFindings(outcome.review) : false,
        riskLevel: risk.level,
        maxRiskLevel: this.deps.config.safety.autoApply.maxRiskLevel,
        repositoryLockHeld: this.repositoryLock.isLocked(repositoryId),
        baseRevisionMatches: revisionCheck.matches,
        contentHashesMatch: hashCheck.matches,
      };

      const decision = decideAutoApply(evidence);
      await audit.record(task.id, 'auto_apply.decided', { decision: decision.decision, reasons: decision.reasons });

      if (decision.decision === 'AUTO_APPLY') {
        const applyResult = await applyWorkspaceChanges({ workspace, changedFiles: changeScope.files });
        await audit.record(task.id, 'patch.applied', { filesChanged: applyResult.filesChanged });
        return { ...outcome, changeDisposition: 'applied' };
      }

      // decision.decision is 'BLOCKED_BY_POLICY' here in practice - 'FAILED' is
      // provably unreachable at this call site, since evidence.validationPassed
      // and !evidence.reviewBlocking are both guaranteed true by the early return
      // above (decideAutoApply's FAILED branch exists for callers that can't make
      // that guarantee). task.status is already 'completed' from validateAndReview
      // just above; only the reported verdict changes to reflect the withheld apply.
      await audit.record(task.id, 'patch.discarded', { decision: decision.decision, reasons: decision.reasons });
      return { ...outcome, verdict: 'BLOCKED_BY_POLICY', changeDisposition: 'withheld' };
    } finally {
      task.workingDirectory = realWorkingDirectory;
      if (workspace) {
        try {
          await releaseWorkspace(workspace);
          await audit.record(task.id, 'workspace.released', { worktreeDir: workspace.worktreeDir });
        } catch (cause) {
          await audit.record(task.id, 'workspace.released', { worktreeDir: workspace.worktreeDir, error: (cause as Error).message }).catch(() => undefined);
        }
      }
      this.repositoryLock.release(handle);
    }
  }

  private async dispatchWithRetryAndFallback(
    task: DispatcherTask,
    context: Awaited<ReturnType<typeof buildTaskContext>>,
    routing: RoutingDecision,
    artifactRoot?: string,
  ): Promise<{ attempts: TaskOutcome['attempts']; finalResult: TaskResult }> {
    const audit = this.deps.auditLogger;
    const attempted: ProviderId[] = [];
    const attempts: TaskOutcome['attempts'] = [];
    let currentProvider = routing.selected;
    let continuationRequired = false;

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
          const executionTask = continuationRequired ? continuationTask(task) : task;
          const budget = this.executionBudget(task);
          const { executionId, result } = await executeOnce(
            provider,
            executionTask,
            context,
            {
              sandbox: this.deps.config.execution.sandbox,
              approval: this.deps.config.execution.approval,
              timeoutMs: budget.hardTimeoutMs,
              idleTimeoutMs: budget.idleTimeoutMs,
            },
            {
              saveFailureArtifacts: this.deps.config.diagnostics.saveFailureArtifacts,
              artifactRoot,
              onActivity: this.activityReporter(task.id, currentProvider),
            },
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

          const rateLimited = result.error?.code === 'PROVIDER_RATE_LIMITED';
          if (rateLimited) {
            // A confirmed rate-limit/usage-quota response already proves this
            // provider is unusable right now - open the circuit immediately rather
            // than waiting for the sliding-window failure threshold, so routing
            // and fallback stop sending it more (doomed) attempts straight away.
            this.circuitBreaker.tripOpen(currentProvider);
          } else {
            this.circuitBreaker.recordFailure(currentProvider);
          }
          const eventType = result.status === 'timeout' ? 'provider.execution.timeout' : 'provider.execution.failed';
          await audit.record(task.id, eventType, { provider: currentProvider, error: result.error });
          if (result.status === 'timeout') {
            continuationRequired = true;
            await audit.record(task.id, 'checkpoint.saved', {
              provider: currentProvider,
              workingDirectory: task.workingDirectory,
              reason: 'timeout',
            });
          }

          const asError = new DispatcherError({
            code: result.status === 'timeout' ? 'PROCESS_TIMEOUT' : 'PROVIDER_UNREACHABLE',
            message: result.error?.message ?? 'Provider execution failed.',
            taskId: task.id,
            provider: currentProvider,
            // Retrying the same rate-limited provider again would just burn another
            // attempt against a quota that is already known to be exhausted - skip
            // straight to fallback instead, same as an auth error.
            retryable: result.status !== 'auth_error' && !rateLimited,
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
          if (error.code === 'PROVIDER_RATE_LIMITED') {
            this.circuitBreaker.tripOpen(currentProvider);
          } else {
            this.circuitBreaker.recordFailure(currentProvider);
          }
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
    artifactRoot?: string,
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
          const budget = this.executionBudget(task);
          const { result } = await executeOnce(
            implementer,
            task,
            fixContext,
            {
              sandbox: this.deps.config.execution.sandbox,
              approval: this.deps.config.execution.approval,
              timeoutMs: budget.hardTimeoutMs,
              idleTimeoutMs: budget.idleTimeoutMs,
            },
            {
              saveFailureArtifacts: this.deps.config.diagnostics.saveFailureArtifacts,
              artifactRoot,
              onActivity: this.activityReporter(task.id, implementerId),
            },
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

    const reviewerId = await this.pickReviewer(implementerId);
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
          const budget = this.executionBudget(task);
          const { result } = await executeOnce(
            reviewer,
            reviewTask,
            context,
            { sandbox: 'read-only', approval: 'never', timeoutMs: budget.hardTimeoutMs, idleTimeoutMs: budget.idleTimeoutMs },
            {
              saveFailureArtifacts: this.deps.config.diagnostics.saveFailureArtifacts,
              artifactRoot,
              onActivity: this.activityReporter(task.id, reviewerId),
            },
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
      const budget = this.executionBudget(task);
      await executeOnce(
        implementer,
        task,
        reviewFixContext,
        {
          sandbox: this.deps.config.execution.sandbox,
          approval: this.deps.config.execution.approval,
          timeoutMs: budget.hardTimeoutMs,
          idleTimeoutMs: budget.idleTimeoutMs,
        },
        {
          saveFailureArtifacts: this.deps.config.diagnostics.saveFailureArtifacts,
          artifactRoot,
          onActivity: this.activityReporter(task.id, implementerId),
        },
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

  /**
   * Prefers the non-implementer provider when it's eligible (spec section 59); falls
   * back to self-review otherwise. Among eligible non-implementer candidates, a
   * cloud (Claude/Codex) provider is preferred over a local one. Invalid structured
   * review output is fail-closed in review-schema.ts; a local reviewer is still
   * picked over pure self-review when it is the only ready non-implementer option.
   */
  private async pickReviewer(implementerId: ProviderId): Promise<ProviderId> {
    if (!this.deps.config.review.preferIndependentReviewer) return implementerId;
    const candidates = await Promise.all(
      this.deps.providers.list()
        .filter((provider) =>
          provider.id !== implementerId &&
          provider.capabilities().includes('review') &&
          this.circuitBreaker.canAttempt(provider.id),
        )
        .map(async (provider) => ({ provider, health: await provider.checkHealth() })),
    );
    const ready = candidates.filter((candidate) => candidate.health.ready && !candidate.health.rateLimited);
    const cloudReviewer = ready.find((candidate) => candidate.provider.dataResidency !== 'local');
    return cloudReviewer?.provider.id ?? ready[0]?.provider.id ?? implementerId;
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

  private executionBudget(task: DispatcherTask): ExecutionBudget {
    if (!task.classification) {
      return {
        hardTimeoutMs: task.timeoutMs ?? this.deps.config.execution.timeoutMs,
        source: task.timeoutMs === undefined ? 'fixed' : 'explicit',
      };
    }
    return resolveExecutionBudget(task, task.classification, this.deps.config.execution);
  }

  private activityReporter(taskId: string, provider: ProviderId): (activity: ProcessActivity) => void {
    let lastRecordedAt = 0;
    return (activity) => {
      const now = Date.now();
      if (now - lastRecordedAt < 15_000) return;
      lastRecordedAt = now;
      void this.deps.auditLogger.record(taskId, 'provider.execution.activity', {
        provider,
        stream: activity.stream,
        bytes: activity.bytes,
        elapsedMs: activity.elapsedMs,
        at: activity.at,
      }).catch(() => undefined);
    };
  }
}

function continuationTask(task: DispatcherTask): DispatcherTask {
  return {
    ...task,
    specification: {
      ...task.specification,
      rawDescription: [
        'Continue the existing task from the current workspace state.',
        'A previous provider attempt reached its execution limit after making partial changes.',
        'Inspect git status and git diff first. Preserve correct existing work, identify unfinished plan items, and continue from there.',
        'Do not restart the task, discard valid changes, or repeat completed investigation.',
        '',
        'Original request:',
        task.specification.rawDescription,
      ].join('\n'),
    },
  };
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
