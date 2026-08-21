import { randomUUID } from 'node:crypto';
import type { DispatcherTask } from '../models/task.js';
import type { TaskContext } from '../models/context.js';
import type { TaskResult } from '../models/result.js';
import type { ProviderId } from '../models/provider.js';
import type { AIProvider, ProviderRunOptions } from '../providers/types.js';
import type { ProcessOutcome } from '../process/process-runner.js';
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
  const plan = provider.buildCommand(task, context, runOptions);
  const startedAt = new Date().toISOString();

  let outcome: ProcessOutcome;
  try {
    outcome = await runProcess({
      file: plan.file,
      args: plan.args,
      cwd: plan.cwd,
      timeoutMs: plan.timeoutMs,
      stdinContent: plan.stdinContent,
    });
  } catch (cause) {
    const error = wrapUnknownError(cause, { taskId: task.id, executionId, provider: provider.id });
    if (options.saveFailureArtifacts) {
      await persistFailureArtifact(task, executionId, provider.id, plan, emptyOutcome(), error, startedAt);
    }
    throw error;
  }

  let result: TaskResult;
  try {
    result = await provider.parseOutcome(outcome, task, executionId, plan);
  } catch (cause) {
    const error = wrapUnknownError(cause, { taskId: task.id, executionId, provider: provider.id });
    if (options.saveFailureArtifacts) {
      await persistFailureArtifact(task, executionId, provider.id, plan, outcome, error, startedAt);
    }
    throw error;
  }

  // A "failed" TaskResult is not thrown here - the caller (orchestrator) decides
  // whether a failed result is retryable/fallback-eligible using result.status, not
  // an exception. Only process-level problems (spawn failure, unparseable output)
  // become DispatcherError, thrown above.
  if (options.saveFailureArtifacts && FAILURE_STATUSES.has(result.status)) {
    const artifactDir = await persistFailureArtifact(task, executionId, provider.id, plan, outcome, result.error, startedAt);
    if (artifactDir) result = { ...result, rawOutputPath: artifactDir };
  }

  return { executionId, provider: provider.id, result };
}

/** Never lets an artifact-write failure mask the real failure already being reported. */
async function persistFailureArtifact(
  task: DispatcherTask,
  executionId: string,
  provider: ProviderId,
  plan: Parameters<typeof saveFailureArtifact>[1]['command'],
  outcome: ProcessOutcome,
  error: DispatcherError | TaskResult['error'],
  startedAt: string,
): Promise<string | undefined> {
  try {
    return await saveFailureArtifact(task.workingDirectory, {
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
