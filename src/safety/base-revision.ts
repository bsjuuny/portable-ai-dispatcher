import { runProcess } from '../process/process-runner.js';
import { DispatcherError } from '../models/error.js';

export interface BaseRevisionCheck {
  matches: boolean;
  expectedRevision: string;
  currentRevision: string;
}

/**
 * Read-only comparison, not an enforcement point itself - callers decide what to
 * do with a mismatch (patch-apply.ts throws BASE_REVISION_CHANGED right before
 * applying; auto-apply-gate.ts treats it as one input among several so a single
 * boolean field can't be "assumed true" by omission).
 */
export async function checkBaseRevisionUnchanged(realRepoDir: string, expectedRevision: string): Promise<BaseRevisionCheck> {
  const outcome = await runProcess({ file: 'git', args: ['rev-parse', 'HEAD'], cwd: realRepoDir, timeoutMs: 15_000 });
  if (outcome.exitCode !== 0) {
    throw new DispatcherError({
      code: 'WORKSPACE_ACQUIRE_FAILED',
      message: `Could not resolve HEAD in "${realRepoDir}" while checking base revision: ${outcome.stderr.trim()}`,
      retryable: false,
    });
  }
  const currentRevision = outcome.stdout.trim();
  return { matches: currentRevision === expectedRevision, expectedRevision, currentRevision };
}

export function assertBaseRevisionUnchanged(check: BaseRevisionCheck, taskId: string): void {
  if (check.matches) return;
  throw new DispatcherError({
    code: 'BASE_REVISION_CHANGED',
    message: `Repository HEAD moved from ${check.expectedRevision} to ${check.currentRevision} since this task started - refusing to apply.`,
    taskId,
    retryable: false,
  });
}
