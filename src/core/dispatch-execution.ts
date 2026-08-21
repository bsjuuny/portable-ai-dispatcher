import { randomUUID } from 'node:crypto';
import type { DispatcherTask } from '../models/task.js';
import type { TaskContext } from '../models/context.js';
import type { TaskResult } from '../models/result.js';
import type { ProviderId } from '../models/provider.js';
import type { AIProvider, ProviderRunOptions } from '../providers/types.js';
import { runProcess } from '../process/process-runner.js';
import { DispatcherError, wrapUnknownError } from '../models/error.js';

export interface ExecuteOnceResult {
  executionId: string;
  provider: ProviderId;
  result: TaskResult;
}

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
): Promise<ExecuteOnceResult> {
  const executionId = `exec_${randomUUID()}`;
  const plan = provider.buildCommand(task, context, runOptions);

  let outcome;
  try {
    outcome = await runProcess({
      file: plan.file,
      args: plan.args,
      cwd: plan.cwd,
      timeoutMs: plan.timeoutMs,
      stdinContent: plan.stdinContent,
    });
  } catch (cause) {
    throw wrapUnknownError(cause, { taskId: task.id, executionId, provider: provider.id });
  }

  let result: TaskResult;
  try {
    result = await provider.parseOutcome(outcome, task, executionId, plan);
  } catch (cause) {
    throw wrapUnknownError(cause, { taskId: task.id, executionId, provider: provider.id });
  }

  // A "failed" TaskResult is not thrown here - the caller (orchestrator) decides
  // whether a failed result is retryable/fallback-eligible using result.status, not
  // an exception. Only process-level problems (spawn failure, unparseable output)
  // become DispatcherError, thrown above.
  return { executionId, provider: provider.id, result };
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
