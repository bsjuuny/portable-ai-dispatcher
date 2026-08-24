import type { TaskClassification } from '../models/classification.js';
import type { DispatcherTask } from '../models/task.js';
import type { DispatcherConfig } from '../config/schema.js';

export interface ExecutionBudget {
  hardTimeoutMs: number;
  idleTimeoutMs?: number;
  source: 'explicit' | 'adaptive' | 'fixed';
}

export function resolveExecutionBudget(
  task: DispatcherTask,
  classification: TaskClassification,
  execution: DispatcherConfig['execution'],
): ExecutionBudget {
  const adaptive = execution.adaptiveTimeout;
  const requested = task.timeoutMs;

  if (requested !== undefined) {
    const hardTimeoutMs = Math.min(requested, adaptive.maximumMs);
    return {
      hardTimeoutMs,
      idleTimeoutMs: adaptive.enabled ? boundedIdle(adaptive.idleMs, hardTimeoutMs) : undefined,
      source: 'explicit',
    };
  }

  if (!adaptive.enabled) {
    return { hardTimeoutMs: execution.timeoutMs, source: 'fixed' };
  }

  const selected = classification.estimatedComplexity === 'complex'
    ? adaptive.complexMs
    : classification.estimatedComplexity === 'normal'
      ? adaptive.normalMs
      : adaptive.simpleMs;
  const hardTimeoutMs = Math.min(Math.max(selected, execution.timeoutMs), adaptive.maximumMs);
  return {
    hardTimeoutMs,
    idleTimeoutMs: boundedIdle(adaptive.idleMs, hardTimeoutMs),
    source: 'adaptive',
  };
}

function boundedIdle(idleMs: number, hardTimeoutMs: number): number | undefined {
  if (hardTimeoutMs <= 2_000) return undefined;
  return Math.min(idleMs, hardTimeoutMs - 1_000);
}
