import type { ProviderId, ProviderUsage } from './provider.js';

// Named TaskResultStatus (not TaskStatus) to avoid colliding with the task lifecycle
// state machine's TaskStatus in ./task.ts - the spec uses "status" for both concepts
// but they are distinct: this one is per-execution-attempt outcome, that one is the
// task's overall position in the CREATED -> ... -> COMPLETED state machine.
export type TaskResultStatus =
  | 'success'
  | 'success_with_warning'
  | 'failed'
  | 'timeout'
  | 'auth_error'
  | 'unavailable'
  | 'cancelled';

export interface CommandResult {
  command: string[];
  exitCode: number | null;
  durationMs: number;
}

export interface TaskResult {
  taskId: string;
  executionId: string;
  provider: ProviderId;
  status: TaskResultStatus;
  summary?: string;
  text?: string;
  filesChanged?: string[];
  commandsExecuted?: CommandResult[];
  sessionId?: string;
  usage?: ProviderUsage;
  durationMs: number;
  error?: {
    code?: string;
    message: string;
  };
  rawOutputPath?: string;
}
