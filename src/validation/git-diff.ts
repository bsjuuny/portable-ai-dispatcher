import { runProcess } from '../process/process-runner.js';
import type { GitDiffSummary } from '../models/validation.js';
import { DispatcherError } from '../models/error.js';

/**
 * Diffs the working tree against HEAD (uncommitted changes made by a provider
 * execution) using `git diff --name-status` and `git status --porcelain` (for
 * untracked new files, which `git diff` alone does not show).
 */
export async function computeGitDiff(cwd: string, protectedPaths: string[] = []): Promise<GitDiffSummary> {
  const diffOutcome = await runProcess({
    file: 'git',
    args: ['diff', '--name-status', 'HEAD'],
    cwd,
    timeoutMs: 15_000,
  });
  if (diffOutcome.exitCode !== 0) {
    throw new DispatcherError({
      code: 'VALIDATION_FAILED',
      message: `git diff failed: ${diffOutcome.stderr.trim()}`,
      retryable: false,
    });
  }

  const statusOutcome = await runProcess({
    file: 'git',
    args: ['status', '--porcelain'],
    cwd,
    timeoutMs: 15_000,
  });

  const changedFiles: string[] = [];
  const deletedFiles: string[] = [];
  let addedFiles: string[] = [];

  for (const line of diffOutcome.stdout.split('\n').filter(Boolean)) {
    const [status, ...pathParts] = line.split('\t');
    const path = pathParts.join('\t');
    if (!path) continue;
    changedFiles.push(path);
    if (status === 'D') deletedFiles.push(path);
  }

  for (const line of statusOutcome.stdout.split('\n').filter(Boolean)) {
    if (line.startsWith('??')) {
      const path = line.slice(3).trim();
      addedFiles.push(path);
      changedFiles.push(path);
    }
  }
  addedFiles = [...new Set(addedFiles)];

  const allTouched = [...new Set(changedFiles)];
  const protectedPathsTouched = allTouched.filter((file) =>
    protectedPaths.some((protectedPath) => file === protectedPath || file.startsWith(protectedPath)),
  );

  return {
    changedFiles: allTouched,
    addedFiles,
    deletedFiles,
    protectedPathsTouched,
  };
}
