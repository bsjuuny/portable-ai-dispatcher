import { readFile, unlink } from 'node:fs/promises';
import type { DispatcherTask } from '../../models/task.js';
import type { TaskContext } from '../../models/context.js';
import type { ProviderCapability, ProviderHealth } from '../../models/provider.js';
import type { TaskResult } from '../../models/result.js';
import type { ProcessOutcome } from '../../process/process-runner.js';
import type { AIProvider, ProviderCommandPlan, ProviderRunOptions } from '../types.js';
import { buildCodexCommand } from './command-builder.js';
import { checkCodexHealth } from './health.js';
import { parseCodexStream } from './output-schema.js';

const CAPABILITIES: ProviderCapability[] = [
  'implementation',
  'bugfix',
  'test-generation',
  'terminal',
  'refactor',
];

export class CodexProvider implements AIProvider {
  readonly id = 'codex' as const;

  capabilities(): ProviderCapability[] {
    return CAPABILITIES;
  }

  checkHealth(opts?: { timeoutMs?: number }): Promise<ProviderHealth> {
    return checkCodexHealth(opts);
  }

  buildCommand(task: DispatcherTask, context: TaskContext, opts: ProviderRunOptions): ProviderCommandPlan {
    return buildCodexCommand(task, context, opts);
  }

  async parseOutcome(
    outcome: ProcessOutcome,
    task: DispatcherTask,
    executionId: string,
    plan: ProviderCommandPlan,
  ): Promise<TaskResult> {
    if (outcome.timedOut) {
      return {
        taskId: task.id,
        executionId,
        provider: this.id,
        status: 'timeout',
        durationMs: outcome.durationMs,
        error: { code: 'PROCESS_TIMEOUT', message: 'Codex execution timed out.' },
      };
    }

    const stream = parseCodexStream(outcome.stdout);
    const finalMessage = await readOutputLastMessage(plan.metadata);

    if (stream.failed || stream.errors.length > 0) {
      return {
        taskId: task.id,
        executionId,
        provider: this.id,
        status: 'failed',
        text: finalMessage,
        sessionId: stream.threadId,
        durationMs: outcome.durationMs,
        error: {
          code: 'PROVIDER_TASK_FAILED',
          message: stream.errors.join('; ') || 'Codex reported a failed turn.',
        },
      };
    }

    if (outcome.exitCode !== 0) {
      return {
        taskId: task.id,
        executionId,
        provider: this.id,
        status: 'failed',
        text: finalMessage,
        sessionId: stream.threadId,
        durationMs: outcome.durationMs,
        error: {
          code: 'PROCESS_EXIT_ERROR',
          message: outcome.stderr.trim() || `codex exited with code ${outcome.exitCode}`,
        },
      };
    }

    return {
      taskId: task.id,
      executionId,
      provider: this.id,
      status: 'success',
      summary: finalMessage,
      text: finalMessage,
      sessionId: stream.threadId,
      durationMs: outcome.durationMs,
    };
  }
}

async function readOutputLastMessage(metadata: Record<string, unknown> | undefined): Promise<string | undefined> {
  const path = metadata?.['outputLastMessagePath'];
  if (typeof path !== 'string') return undefined;
  try {
    const content = await readFile(path, 'utf8');
    return content.trim() || undefined;
  } catch {
    return undefined;
  } finally {
    await unlink(path).catch(() => undefined);
  }
}
