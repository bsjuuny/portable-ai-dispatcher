import { execa } from 'execa';
import { DispatcherError } from '../models/error.js';

/**
 * The ONLY file in this codebase allowed to import execa/child_process (enforced by
 * eslint no-restricted-imports elsewhere, and by a dist/*.js static-scan test after
 * build). Every provider command reaches the OS exclusively through this function.
 *
 * `shell` is passed explicitly as `false` even though it is execa's default - so a
 * future edit "fixing a quoting bug" can't silently flip it to `true` and reintroduce
 * shell interpretation of user-controlled argv elements.
 */

export interface ProcessPlan {
  file: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  stdinContent?: string;
  signal?: AbortSignal;
}

export interface ProcessOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export async function runProcess(plan: ProcessPlan): Promise<ProcessOutcome> {
  assertArgvIsStringArray(plan.args);
  const startedAt = Date.now();

  try {
    const result = await execa(plan.file, plan.args, {
      cwd: plan.cwd,
      env: plan.env,
      shell: false,
      timeout: plan.timeoutMs,
      input: plan.stdinContent,
      cancelSignal: plan.signal,
      reject: false,
    });

    return {
      exitCode: result.exitCode ?? null,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      timedOut: result.timedOut ?? false,
      durationMs: Date.now() - startedAt,
    };
  } catch (cause) {
    if (isAbortError(cause)) {
      throw new DispatcherError({
        code: 'PROCESS_CANCELLED',
        message: `Process cancelled: ${plan.file}`,
        cause,
        retryable: false,
      });
    }
    throw new DispatcherError({
      code: 'PROCESS_START_FAILED',
      message: `Failed to start process "${plan.file}": ${(cause as Error).message}`,
      cause,
      retryable: true,
      severity: 'error',
    });
  }
}

function isAbortError(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    ('name' in cause ? cause.name === 'AbortError' : false)
  );
}

/**
 * Defensive guard used by runProcess: proves at runtime that argv is really a flat
 * array of strings, never a pre-joined shell string. This is what makes the
 * shell-injection test suite meaningful - it fails loudly if anything ever tries to
 * pass a single concatenated command string through this path.
 */
export function assertArgvIsStringArray(args: unknown): asserts args is string[] {
  if (!Array.isArray(args)) {
    throw new DispatcherError({
      code: 'INTERNAL_LOGIC_ERROR',
      message: 'Process argv must be an array, not a pre-joined string.',
      retryable: false,
    });
  }
  for (const arg of args) {
    if (typeof arg !== 'string') {
      throw new DispatcherError({
        code: 'INTERNAL_LOGIC_ERROR',
        message: `Process argv element is not a string: ${typeof arg}`,
        retryable: false,
      });
    }
  }
}
