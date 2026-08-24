import { runProcess } from '../process/process-runner.js';
import { DispatcherError } from '../models/error.js';

export interface ChangeScope {
  filesChanged: number;
  linesAdded: number;
  linesDeleted: number;
  files: string[];
}

/**
 * Independent of validation/git-diff.ts (which reports file names/protected-path
 * hits for the validation pipeline, not line counts) - this one exists purely to
 * feed risk-classifier.ts's blast-radius check, and has no bearing on whether
 * validation passes.
 *
 * `git diff --numstat` alone omits untracked new files (verified live: a brand
 * new file simply does not appear). Untracked files are temporarily staged with
 * `git add -N` (intent-to-add - records the path in the index without staging
 * content) so numstat picks up their line counts too, then unstaged again via
 * `git reset --` immediately after reading the diff, in a finally block, so this
 * function is observably read-only even though it briefly touches the index.
 */
export async function computeChangeScope(cwd: string): Promise<ChangeScope> {
  const statusOutcome = await runProcess({ file: 'git', args: ['status', '--porcelain'], cwd, timeoutMs: 15_000 });
  if (statusOutcome.exitCode !== 0) {
    throw new DispatcherError({
      code: 'VALIDATION_FAILED',
      message: `git status failed: ${statusOutcome.stderr.trim()}`,
      retryable: false,
    });
  }

  const untrackedFiles = statusOutcome.stdout
    .split('\n')
    .filter((line) => line.startsWith('??'))
    .map((line) => line.slice(3).trim());

  if (untrackedFiles.length > 0) {
    const intentOutcome = await runProcess({ file: 'git', args: ['add', '-N', '--', ...untrackedFiles], cwd, timeoutMs: 15_000 });
    if (intentOutcome.exitCode !== 0) {
      throw new DispatcherError({
        code: 'VALIDATION_FAILED',
        message: `git add -N failed while measuring untracked files: ${intentOutcome.stderr.trim()}`,
        retryable: false,
      });
    }
  }

  let scope: ChangeScope | undefined;
  let failure: unknown;
  try {
    const diffOutcome = await runProcess({ file: 'git', args: ['diff', '--numstat', 'HEAD'], cwd, timeoutMs: 15_000 });
    if (diffOutcome.exitCode !== 0) {
      throw new DispatcherError({
        code: 'VALIDATION_FAILED',
        message: `git diff --numstat failed: ${diffOutcome.stderr.trim()}`,
        retryable: false,
      });
    }
    scope = parseNumstat(diffOutcome.stdout);
  } catch (cause) {
    failure = cause;
  }

  let resetFailure: DispatcherError | undefined;
  if (untrackedFiles.length > 0) {
    const resetOutcome = await runProcess({ file: 'git', args: ['reset', '--', ...untrackedFiles], cwd, timeoutMs: 15_000 });
    if (resetOutcome.exitCode !== 0) {
      resetFailure = new DispatcherError({
        code: 'VALIDATION_FAILED',
        message: `git reset failed after measuring untracked files: ${resetOutcome.stderr.trim()}`,
        retryable: false,
      });
    }
  }

  if (failure) throw failure;
  if (resetFailure) throw resetFailure;
  if (!scope) {
    throw new DispatcherError({
      code: 'INTERNAL_LOGIC_ERROR',
      message: 'Change-scope computation completed without a result.',
      retryable: false,
    });
  }
  return scope;
}

function parseNumstat(stdout: string): ChangeScope {
  let linesAdded = 0;
  let linesDeleted = 0;
  const files: string[] = [];

  for (const line of stdout.split('\n').filter(Boolean)) {
    const [addedRaw, deletedRaw, ...pathParts] = line.split('\t');
    const path = pathParts.join('\t');
    if (!path) continue;

    // git (2.53.0, confirmed live - rename detection is on by default, no `-M`
    // needed) reports a rename as ONE numstat line whose "path" field is not a
    // real path at all but one of two rewrite notations: `old => new` with no
    // common prefix/suffix, or `common/{old => new}/tail` when part of the path
    // is shared. Both old and new are included below (not just new) so a rename
    // that moves a file INTO or OUT OF a protected/CI-pattern path is still
    // visible to risk-classifier.ts, and so content-hash-lock.ts's per-file TOCTOU
    // check can verify both "the old path is still what it was" and "the new path
    // didn't already exist for an unrelated reason" - a single un-parsed path
    // would silently skip both checks for a renamed file.
    const rename = resolveRenamePaths(path);
    if (rename) {
      files.push(rename.oldPath, rename.newPath);
    } else {
      files.push(path);
    }

    // Binary files report `-` instead of a number - counted as a changed file with
    // zero measurable lines rather than skipped, so blast-radius file-count limits
    // still see them.
    const added = addedRaw === '-' ? 0 : Number(addedRaw);
    const deleted = deletedRaw === '-' ? 0 : Number(deletedRaw);
    linesAdded += Number.isFinite(added) ? added : 0;
    linesDeleted += Number.isFinite(deleted) ? deleted : 0;
  }

  return { filesChanged: files.length, linesAdded, linesDeleted, files };
}

/**
 * Parses both git rename notations observed live (git 2.53.0):
 *   - `old.txt => new.txt` (no shared prefix/suffix)
 *   - `src/{foo.txt => bar.txt}` (shared prefix/suffix around a `{old => new}` core)
 * Returns null for an ordinary (non-rename) path.
 */
function resolveRenamePaths(rawPath: string): { oldPath: string; newPath: string } | null {
  const braceMatch = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(rawPath);
  if (braceMatch) {
    const [, prefix, oldMiddle, newMiddle, suffix] = braceMatch;
    return { oldPath: `${prefix}${oldMiddle}${suffix}`, newPath: `${prefix}${newMiddle}${suffix}` };
  }
  const plainMatch = /^(.*) => (.*)$/.exec(rawPath);
  if (plainMatch) {
    const [, oldPath, newPath] = plainMatch;
    return { oldPath: oldPath!, newPath: newPath! };
  }
  return null;
}
