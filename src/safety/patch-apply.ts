import { runProcess } from '../process/process-runner.js';
import { DispatcherError } from '../models/error.js';
import { computeChangeScope } from './change-scope.js';
import type { AcquiredWorkspace } from './workspace.js';
import { checkBaseRevisionUnchanged, assertBaseRevisionUnchanged } from './base-revision.js';
import { checkContentHashesUnchanged, assertContentHashesUnchanged } from './content-hash-lock.js';

export interface ApplyWorkspaceChangesParams {
  workspace: AcquiredWorkspace;
  changedFiles: string[];
}

export interface ApplyWorkspaceChangesResult {
  applied: boolean;
  filesChanged: string[];
}

/**
 * The only place that actually merges a worktree's changes into the real
 * repository - called exclusively after decideAutoApply() returns AUTO_APPLY.
 * Re-runs the base-revision and content-hash checks immediately before touching
 * the real tree (the TOCTOU close-out mentioned in both of those modules' own
 * comments): validation/review/risk-classification all ran minutes earlier
 * against a snapshot that could be stale by the time this actually executes.
 *
 * Mechanism (live-verified against a real git worktree - see docs/architecture.md):
 * stage everything in the worktree (`git add -A`, so untracked new files are
 * included, not just tracked modifications), diff the index against HEAD with
 * `--binary`, then apply that patch text to the real repository's working tree
 * via stdin through the existing process-runner chokepoint. This lands as an
 * ordinary uncommitted working-tree change in the real repo - patch-apply.ts
 * never commits on the operator's behalf.
 */
export async function applyWorkspaceChanges(params: ApplyWorkspaceChangesParams): Promise<ApplyWorkspaceChangesResult> {
  const { workspace, changedFiles } = params;

  const revisionCheck = await checkBaseRevisionUnchanged(workspace.realRepoDir, workspace.baseRevision);
  assertBaseRevisionUnchanged(revisionCheck, workspace.taskId);

  const hashCheck = await checkContentHashesUnchanged(workspace.realRepoDir, workspace.baseRevision, changedFiles);
  assertContentHashesUnchanged(hashCheck, workspace.taskId);

  if (changedFiles.length === 0) {
    return { applied: true, filesChanged: [] };
  }

  const finalScope = await computeChangeScope(workspace.worktreeDir);
  const approved = [...new Set(changedFiles)].sort();
  const actual = [...new Set(finalScope.files)].sort();
  if (approved.length !== actual.length || approved.some((file, index) => file !== actual[index])) {
    throw new DispatcherError({
      code: 'STALE_PATCH',
      message: `Workspace changes no longer match the approved manifest. Approved: ${approved.join(', ') || '(none)'}; actual: ${actual.join(', ') || '(none)'}.`,
      taskId: workspace.taskId,
      retryable: false,
    });
  }

  const addOutcome = await runProcess({
    file: 'git',
    args: ['add', '-A', '--', ...approved],
    cwd: workspace.worktreeDir,
    timeoutMs: 30_000,
  });
  if (addOutcome.exitCode !== 0) {
    throw new DispatcherError({
      code: 'PATCH_APPLY_FAILED',
      message: `git add -A failed in worktree: ${addOutcome.stderr.trim()}`,
      taskId: workspace.taskId,
      retryable: false,
    });
  }

  const diffOutcome = await runProcess({ file: 'git', args: ['diff', '--cached', '--binary', 'HEAD'], cwd: workspace.worktreeDir, timeoutMs: 30_000 });
  if (diffOutcome.exitCode !== 0) {
    throw new DispatcherError({
      code: 'PATCH_APPLY_FAILED',
      message: `git diff --cached failed in worktree: ${diffOutcome.stderr.trim()}`,
      taskId: workspace.taskId,
      retryable: false,
    });
  }

  if (!diffOutcome.stdout.trim()) {
    return { applied: true, filesChanged: [] };
  }

  // execa (process-runner.ts) strips a captured process's final trailing newline
  // by default - found live while testing this exact function: `git apply` then
  // fails with "corrupt patch" because a valid patch's last hunk line must end in
  // a newline. Restoring it is safe and necessary here, unlike a general fix in
  // process-runner.ts itself, which is shared by every other caller and not worth
  // risking for this one patch-format-sensitive consumer.
  const patchText = diffOutcome.stdout.endsWith('\n') ? diffOutcome.stdout : `${diffOutcome.stdout}\n`;

  const checkOutcome = await runProcess({
    file: 'git',
    args: ['apply', '--check', '--binary'],
    cwd: workspace.realRepoDir,
    timeoutMs: 30_000,
    stdinContent: patchText,
  });
  if (checkOutcome.exitCode !== 0) {
    throw new DispatcherError({
      code: 'PATCH_APPLY_FAILED',
      message: `Patch does not apply cleanly to the real repository: ${checkOutcome.stderr.trim()}`,
      taskId: workspace.taskId,
      retryable: false,
    });
  }

  const applyOutcome = await runProcess({
    file: 'git',
    args: ['apply', '--binary'],
    cwd: workspace.realRepoDir,
    timeoutMs: 30_000,
    stdinContent: patchText,
  });
  if (applyOutcome.exitCode !== 0) {
    throw new DispatcherError({
      code: 'PATCH_APPLY_FAILED',
      message: `git apply failed after passing --check: ${applyOutcome.stderr.trim()}`,
      taskId: workspace.taskId,
      retryable: false,
    });
  }

  return { applied: true, filesChanged: changedFiles };
}
