import { randomUUID } from 'node:crypto';
import type { DispatcherTask } from '../models/task.js';
import type { TaskContext } from '../models/context.js';
import type { TaskResult } from '../models/result.js';
import type { ProviderId } from '../models/provider.js';
import type { AIProvider, ProviderRunOptions } from '../providers/types.js';
import type { ProcessActivity, ProcessOutcome } from '../process/process-runner.js';
import { runProcess } from '../process/process-runner.js';
import { DispatcherError, wrapUnknownError } from '../models/error.js';
import { saveFailureArtifact } from '../logging/failure-artifacts.js';

export interface ExecuteOnceResult {
  executionId: string;
  provider: ProviderId;
  result: TaskResult;
}

export interface ExecuteOnceOptions {
  /** spec section 74 - when true, a failed/timed-out/errored attempt is persisted to
   * `.dispatcher/runs/<executionId>/` before this function returns or throws. */
  saveFailureArtifacts?: boolean;
  /**
   * Directory failure artifacts are written under (defaults to `task.workingDirectory`
   * when omitted). Callers operating against an isolated `git worktree`
   * (safety/workspace.ts) MUST pass the real repository directory here instead of
   * relying on the default - found live: with the default, a failed execution
   * attempt during an isolated fix/implement task wrote its artifact into the
   * worktree, which `releaseWorkspace()` then deletes, silently losing it and
   * defeating the whole point of failure artifacts for exactly the autonomous
   * tasks this increment targets.
   */
  artifactRoot?: string;
  onActivity?: (activity: ProcessActivity) => void;
}

const FAILURE_STATUSES = new Set<TaskResult['status']>(['failed', 'timeout', 'auth_error', 'unavailable']);

/**
 * A single execution attempt against one provider: build command -> run process ->
 * parse outcome. Retry/fallback (routing/retry-policy.ts, routing/fallback.ts) wrap
 * *this*, they don't live inside it - this function only ever tries once.
 */
export async function executeOnce(
  provider: AIProvider,
  task: DispatcherTask,
  context: TaskContext,
  runOptions: ProviderRunOptions,
  options: ExecuteOnceOptions = {},
): Promise<ExecuteOnceResult> {
  const executionId = `exec_${randomUUID()}`;
  const startedAt = new Date().toISOString();

  // Local LLM Adapter increment: providers that are not process-spawn shaped
  // (LocalProvider talking to a local runtime adapter) define executeDirect instead
  // of buildCommand/parseOutcome. Checked first so Claude/Codex, which never
  // define it, fall through to the exact path that already existed.
  if (provider.executeDirect) {
    return executeDirectOnce(provider, task, context, runOptions, executionId, startedAt, options);
  }

  const plan = provider.buildCommand(task, context, runOptions);

  let outcome: ProcessOutcome;
  try {
    outcome = await runProcess({
      file: plan.file,
      args: plan.args,
      cwd: plan.cwd,
      timeoutMs: plan.timeoutMs,
      idleTimeoutMs: runOptions.idleTimeoutMs,
      stdinContent: plan.stdinContent,
      onActivity: options.onActivity,
    });
  } catch (cause) {
    const error = wrapUnknownError(cause, { taskId: task.id, executionId, provider: provider.id });
    if (options.saveFailureArtifacts) {
      await persistFailureArtifact(task, options, executionId, provider.id, plan, emptyOutcome(), error, startedAt);
    }
    throw error;
  }

  let result: TaskResult;
  try {
    result = await provider.parseOutcome(outcome, task, executionId, plan);
  } catch (cause) {
    const error = wrapUnknownError(cause, { taskId: task.id, executionId, provider: provider.id });
    if (options.saveFailureArtifacts) {
      await persistFailureArtifact(task, options, executionId, provider.id, plan, outcome, error, startedAt);
    }
    throw error;
  }

  // A "failed" TaskResult is not thrown here - the caller (orchestrator) decides
  // whether a failed result is retryable/fallback-eligible using result.status, not
  // an exception. Only process-level problems (spawn failure, unparseable output)
  // become DispatcherError, thrown above.
  if (options.saveFailureArtifacts && FAILURE_STATUSES.has(result.status)) {
    const artifactDir = await persistFailureArtifact(task, options, executionId, provider.id, plan, outcome, result.error, startedAt);
    if (artifactDir) result = { ...result, rawOutputPath: artifactDir };
  }

  return { executionId, provider: provider.id, result };
}

/**
 * Same build->run->parse shape as the code above, collapsed into a single
 * provider.executeDirect() call since there is no separate process outcome to
 * build a command plan for. Failure-artifact saving still fires, through a
 * synthetic ProviderCommandPlan carrying no real argv - failure-artifacts.ts's
 * signature is unchanged, it just never sees a `file`/`args` that map to a real
 * spawned process for a local provider.
 */
async function executeDirectOnce(
  provider: AIProvider,
  task: DispatcherTask,
  context: TaskContext,
  runOptions: ProviderRunOptions,
  executionId: string,
  startedAt: string,
  options: ExecuteOnceOptions,
): Promise<ExecuteOnceResult> {
  const plan = syntheticCommandPlan(provider, task, runOptions);

  let result: TaskResult;
  try {
    result = await provider.executeDirect!(task, context, runOptions, executionId);
  } catch (cause) {
    const error = wrapUnknownError(cause, { taskId: task.id, executionId, provider: provider.id });
    if (options.saveFailureArtifacts) {
      await persistFailureArtifact(task, options, executionId, provider.id, plan, emptyOutcome(), error, startedAt);
    }
    throw error;
  }

  if (options.saveFailureArtifacts && FAILURE_STATUSES.has(result.status)) {
    const artifactDir = await persistFailureArtifact(task, options, executionId, provider.id, plan, emptyOutcome(), result.error, startedAt);
    if (artifactDir) result = { ...result, rawOutputPath: artifactDir };
  }

  return { executionId, provider: provider.id, result };
}

function syntheticCommandPlan(provider: AIProvider, task: DispatcherTask, runOptions: ProviderRunOptions): Parameters<typeof saveFailureArtifact>[1]['command'] {
  return { file: `<executeDirect:${provider.id}>`, args: [], cwd: task.workingDirectory, timeoutMs: runOptions.timeoutMs };
}

/** Never lets an artifact-write failure mask the real failure already being reported. */
async function persistFailureArtifact(
  task: DispatcherTask,
  options: ExecuteOnceOptions,
  executionId: string,
  provider: ProviderId,
  plan: Parameters<typeof saveFailureArtifact>[1]['command'],
  outcome: ProcessOutcome,
  error: DispatcherError | TaskResult['error'],
  startedAt: string,
): Promise<string | undefined> {
  try {
    return await saveFailureArtifact(options.artifactRoot ?? task.workingDirectory, {
      taskId: task.id,
      executionId,
      provider,
      command: plan,
      outcome,
      error,
      startedAt,
      finishedAt: new Date().toISOString(),
    });
  } catch {
    return undefined;
  }
}

function emptyOutcome(): ProcessOutcome {
  return { exitCode: null, stdout: '', stderr: '', timedOut: false, durationMs: 0 };
}

export function assertResultUsable(result: TaskResult, taskId: string): void {
  if (result.status === 'unavailable') {
    throw new DispatcherError({
      code: 'PROVIDER_UNREACHABLE',
      message: result.error?.message ?? 'Provider unavailable.',
      taskId,
      retryable: true,
    });
  }
}
