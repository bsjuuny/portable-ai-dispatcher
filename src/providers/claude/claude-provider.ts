import type { DispatcherTask } from '../../models/task.js';
import type { TaskContext } from '../../models/context.js';
import type { ProviderCapability, ProviderHealth } from '../../models/provider.js';
import type { TaskResult } from '../../models/result.js';
import type { ProcessOutcome } from '../../process/process-runner.js';
import { DispatcherError } from '../../models/error.js';
import type { AIProvider, ProviderCommandPlan, ProviderRunOptions } from '../types.js';
import { buildClaudeCommand } from './command-builder.js';
import { checkClaudeHealth } from './health.js';
import { parseClaudeStreamJsonOutput } from './output-schema.js';

const CAPABILITIES: ProviderCapability[] = [
  'repository-analysis',
  'architecture',
  'analysis',
  'review',
  'large-context',
  'refactor',
  'documentation',
];

export class ClaudeProvider implements AIProvider {
  readonly id = 'claude' as const;

  capabilities(): ProviderCapability[] {
    return CAPABILITIES;
  }

  checkHealth(opts?: { timeoutMs?: number }): Promise<ProviderHealth> {
    return checkClaudeHealth(opts);
  }

  buildCommand(task: DispatcherTask, context: TaskContext, opts: ProviderRunOptions): ProviderCommandPlan {
    return buildClaudeCommand(task, context, opts);
  }

  parseOutcome(outcome: ProcessOutcome, task: DispatcherTask, executionId: string): TaskResult {
    // `plan` (4th interface param) is unused here - Claude's result text comes
    // entirely from the parsed stream-json "result" event, no side-channel file.
    if (outcome.timedOut) {
      return {
        taskId: task.id,
        executionId,
        provider: this.id,
        status: 'timeout',
        durationMs: outcome.durationMs,
        error: { code: 'PROCESS_TIMEOUT', message: 'Claude execution timed out.' },
      };
    }

    if (!outcome.stdout.trim()) {
      throw new DispatcherError({
        code: 'OUTPUT_PARSE_FAILED',
        message: 'Claude produced no stdout output.',
        taskId: task.id,
        executionId,
        provider: this.id,
        retryable: true,
      });
    }

    let event;
    try {
      event = parseClaudeStreamJsonOutput(outcome.stdout);
    } catch (cause) {
      throw new DispatcherError({
        code: 'INVALID_PROVIDER_OUTPUT',
        message: `Failed to parse Claude output: ${(cause as Error).message}`,
        cause,
        taskId: task.id,
        executionId,
        provider: this.id,
        retryable: true,
      });
    }

    if (event.is_error) {
      return {
        taskId: task.id,
        executionId,
        provider: this.id,
        status: 'failed',
        text: event.result,
        sessionId: event.session_id,
        durationMs: outcome.durationMs,
        error: { code: event.subtype, message: event.result ?? 'Claude reported an error.' },
        rawOutputPath: undefined,
      };
    }

    return {
      taskId: task.id,
      executionId,
      provider: this.id,
      status: 'success',
      summary: event.result,
      text: event.result,
      sessionId: event.session_id,
      durationMs: outcome.durationMs,
      usage: event.usage
        ? {
            provider: this.id,
            windowStart: new Date().toISOString(),
            windowEnd: new Date().toISOString(),
            requests: 1,
            successes: 1,
            failures: 0,
            timeouts: 0,
            actualInputTokens: event.usage.input_tokens,
            actualOutputTokens: event.usage.output_tokens,
            estimatedCostUsd: event.total_cost_usd,
            averageDurationMs: outcome.durationMs,
          }
        : undefined,
    };
  }
}
