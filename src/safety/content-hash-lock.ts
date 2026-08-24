import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runProcess } from '../process/process-runner.js';
import { DispatcherError } from '../models/error.js';
import { hashContent } from '../logging/redaction.js';

export interface ContentHashCheck {
  matches: boolean;
  staleFiles: string[];
}

const ABSENT_SENTINEL = '(absent)';

/**
 * Catches the TOCTOU gap base-revision.ts can't: an operator editing a file in
 * realRepoDir's *working tree* without committing does not move HEAD, so
 * checkBaseRevisionUnchanged() alone would miss it. This compares, per file the
 * patch is about to touch, what the file looked like at `baseRevision` (the
 * content the isolated worktree actually started from, read via `git show
 * <rev>:<path>` - live-verified: exits 128 for a path absent at that revision,
 * treated as ABSENT_SENTINEL rather than a hard failure, since "the AI created a
 * new file" is the expected common case) against what is in realRepoDir's working
 * tree right now. A mismatch on either side (someone else edited it, or someone
 * else created a file at a path the AI also just created) is stale.
 *
 * Both sides are normalized (CRLF collapsed to LF, one trailing newline trimmed)
 * before hashing - found live while writing this module's own test: execa
 * (process-runner.ts) strips a captured process's final trailing newline by
 * default, so `git show <rev>:path`'s captured stdout for content "hello\n" comes
 * back as "hello" while the same unchanged file read straight off disk still has
 * its "\n". Without normalizing, every single file would always register as
 * "stale" even with zero real changes - a systemic false positive, not a
 * corner case, that would have made auto-apply permanently unreachable.
 */
export async function checkContentHashesUnchanged(
  realRepoDir: string,
  baseRevision: string,
  changedFiles: string[],
): Promise<ContentHashCheck> {
  const staleFiles: string[] = [];

  for (const relPath of changedFiles) {
    const [baseHash, currentHash] = await Promise.all([
      hashAtRevision(realRepoDir, baseRevision, relPath),
      hashCurrentFile(realRepoDir, relPath),
    ]);
    if (baseHash !== currentHash) staleFiles.push(relPath);
  }

  return { matches: staleFiles.length === 0, staleFiles };
}

export function assertContentHashesUnchanged(check: ContentHashCheck, taskId: string): void {
  if (check.matches) return;
  throw new DispatcherError({
    code: 'STALE_PATCH',
    message: `File(s) changed in the real repository since this task started, outside of any commit: ${check.staleFiles.join(', ')}`,
    taskId,
    retryable: false,
  });
}

async function hashAtRevision(cwd: string, revision: string, relPath: string): Promise<string> {
  const outcome = await runProcess({ file: 'git', args: ['show', `${revision}:${relPath}`], cwd, timeoutMs: 15_000 });
  if (outcome.exitCode !== 0) return ABSENT_SENTINEL; // path did not exist at that revision
  return hashContent(normalizeForComparison(outcome.stdout));
}

async function hashCurrentFile(cwd: string, relPath: string): Promise<string> {
  try {
    const content = await readFile(join(cwd, relPath), 'utf8');
    return hashContent(normalizeForComparison(content));
  } catch {
    return ABSENT_SENTINEL;
  }
}

function normalizeForComparison(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\n$/, '');
}
