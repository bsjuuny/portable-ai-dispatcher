import type { TaskStatus } from '../models/task.js';
import { DispatcherError } from '../models/error.js';

/**
 * Table-driven so illegal transitions are structurally impossible to miss - every
 * legal edge is listed explicitly, and anything not listed throws rather than being
 * silently accepted.
 */
const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  created: ['classifying', 'cancelled'],
  classifying: ['loading_context', 'failed', 'cancelled'],
  loading_context: ['selecting_provider', 'failed', 'cancelled'],
  selecting_provider: ['running', 'failed', 'cancelled'],
  running: ['validating', 'failed', 'timed_out', 'cancelled'],
  validating: ['fixing', 'reviewing', 'failed', 'cancelled'],
  fixing: ['validating', 'failed', 'cancelled'],
  reviewing: ['fixing', 'completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  timed_out: [],
  cancelled: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function transition(
  from: TaskStatus,
  to: TaskStatus,
  context: { taskId?: string } = {},
): TaskStatus {
  if (!canTransition(from, to)) {
    throw new DispatcherError({
      code: 'INVALID_STATE_TRANSITION',
      message: `Illegal task state transition: ${from} -> ${to}`,
      retryable: false,
      taskId: context.taskId,
    });
  }
  return to;
}

export function isTerminal(status: TaskStatus): boolean {
  return TRANSITIONS[status].length === 0;
}
