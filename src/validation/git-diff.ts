import { runProcess } from '../process/process-runner.js';
import type { GitDiffSummary } from '../models/validation.js';
import { DispatcherError } from '../models/error.js';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_REVIEW_PATCH_BYTES = 200_000;
const MAX_UNTRACKED_PREVIEW_BYTES = 40_000;

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
  if (statusOutcome.exitCode !== 0) {
    throw new DispatcherError({
      code: 'VALIDATION_FAILED',
      message: `git status failed: ${statusOutcome.stderr.trim()}`,
      retryable: false,
    });
  }

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

  const patchOutcome = await runProcess({
    file: 'git',
    args: ['diff', '--no-ext-diff', '--unified=3', 'HEAD'],
    cwd,
    timeoutMs: 30_000,
  });
  if (patchOutcome.exitCode !== 0) {
    throw new DispatcherError({
      code: 'VALIDATION_FAILED',
      message: `git diff patch generation failed: ${patchOutcome.stderr.trim()}`,
      retryable: false,
    });
  }

  const untrackedPreviews = await Promise.all(addedFiles.map((file) => previewUntrackedFile(cwd, file)));
  const fullPatch = [patchOutcome.stdout, ...untrackedPreviews].filter(Boolean).join('\n');
  const patchTruncated = Buffer.byteLength(fullPatch) > MAX_REVIEW_PATCH_BYTES;
  const patchText = truncateUtf8(fullPatch, MAX_REVIEW_PATCH_BYTES);

  return {
    changedFiles: allTouched,
    addedFiles,
    deletedFiles,
    protectedPathsTouched,
    patchText,
    patchTruncated,
  };
}

async function previewUntrackedFile(cwd: string, relativePath: string): Promise<string> {
  try {
    const handle = await open(join(cwd, relativePath), 'r');
    try {
      const buffer = Buffer.alloc(MAX_UNTRACKED_PREVIEW_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const content = buffer.subarray(0, bytesRead).toString('utf8');
      const suffix = bytesRead === buffer.length ? '\n[untracked file preview truncated]' : '';
      return `diff --git a/${relativePath} b/${relativePath}\nnew file (untracked)\n--- /dev/null\n+++ b/${relativePath}\n${content}${suffix}`;
    } finally {
      await handle.close();
    }
  } catch {
    return `diff --git a/${relativePath} b/${relativePath}\n[untracked file could not be read]`;
  }
}

function truncateUtf8(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text);
  if (buffer.length <= maxBytes) return text;
  return `${buffer.subarray(0, maxBytes).toString('utf8')}\n[patch truncated]`;
}
