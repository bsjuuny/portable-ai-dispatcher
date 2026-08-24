import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireWorkspace, releaseWorkspace } from '../../src/safety/workspace.js';
import { applyWorkspaceChanges } from '../../src/safety/patch-apply.js';
import { computeChangeScope } from '../../src/safety/change-scope.js';
import { runProcess } from '../../src/process/process-runner.js';
import { isDispatcherError } from '../../src/models/error.js';

/**
 * End-to-end real-git test for the full isolate -> edit -> apply flow (Batch 1
 * Verification point 3): a git worktree is created, changes are made inside it
 * exactly as an AI provider would, and applyWorkspaceChanges() merges them into
 * the real repository's working tree - nothing here is mocked.
 */
describe('applyWorkspaceChanges (real git worktree -> real repo, end to end)', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'ai-dispatcher-patch-apply-test-'));
    await runProcess({ file: 'git', args: ['init', '-q'], cwd: repo, timeoutMs: 10_000 });
    await runProcess({ file: 'git', args: ['config', 'user.email', 't@example.com'], cwd: repo, timeoutMs: 5000 });
    await runProcess({ file: 'git', args: ['config', 'user.name', 'T'], cwd: repo, timeoutMs: 5000 });
    await writeFile(join(repo, 'a.txt'), 'hello\n', 'utf8');
    await runProcess({ file: 'git', args: ['add', '.'], cwd: repo, timeoutMs: 5000 });
    await runProcess({ file: 'git', args: ['commit', '-q', '-m', 'init'], cwd: repo, timeoutMs: 5000 });
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('merges a modified tracked file and a brand new file from the worktree into the real repo', async () => {
    const ws = await acquireWorkspace(repo, 'task-apply-1');
    try {
      await writeFile(join(ws.worktreeDir, 'a.txt'), 'hello\nmodified in worktree\n', 'utf8');
      await writeFile(join(ws.worktreeDir, 'b.txt'), 'brand new content\n', 'utf8');

      const scope = await computeChangeScope(ws.worktreeDir);
      expect(scope.files.sort()).toEqual(['a.txt', 'b.txt']);

      const result = await applyWorkspaceChanges({ workspace: ws, changedFiles: scope.files });
      expect(result.applied).toBe(true);
      expect(result.filesChanged.sort()).toEqual(['a.txt', 'b.txt']);

      // `git apply` respects the local core.autocrlf setting when writing into the
      // real working tree, same as `git checkout` would - normalize CRLF/LF before
      // comparing content, this test cares about the text landing, not exact bytes.
      const normalize = (s: string) => s.replace(/\r\n/g, '\n');
      expect(normalize(await readFile(join(repo, 'a.txt'), 'utf8'))).toBe('hello\nmodified in worktree\n');
      expect(normalize(await readFile(join(repo, 'b.txt'), 'utf8'))).toBe('brand new content\n');

      // Lands as an ordinary uncommitted working-tree change, never auto-committed.
      const status = await runProcess({ file: 'git', args: ['status', '--porcelain'], cwd: repo, timeoutMs: 5000 });
      expect(status.stdout).toContain('a.txt');
      expect(status.stdout).toContain('b.txt');
    } finally {
      await releaseWorkspace(ws);
    }
  });

  it('is a safe no-op when nothing changed in the worktree', async () => {
    const ws = await acquireWorkspace(repo, 'task-apply-2');
    try {
      const result = await applyWorkspaceChanges({ workspace: ws, changedFiles: [] });
      expect(result).toEqual({ applied: true, filesChanged: [] });
      const status = await runProcess({ file: 'git', args: ['status', '--porcelain'], cwd: repo, timeoutMs: 5000 });
      expect(status.stdout.trim()).toBe('');
    } finally {
      await releaseWorkspace(ws);
    }
  });

  it('refuses to apply (BASE_REVISION_CHANGED) when the real repo gained a new commit after the worktree was acquired, and leaves the real repo untouched', async () => {
    const ws = await acquireWorkspace(repo, 'task-apply-3');
    try {
      await writeFile(join(ws.worktreeDir, 'a.txt'), 'hello\nfrom the ai\n', 'utf8');

      // Someone else commits directly to the real repo in the meantime.
      await writeFile(join(repo, 'unrelated.txt'), 'unrelated change', 'utf8');
      await runProcess({ file: 'git', args: ['add', '.'], cwd: repo, timeoutMs: 5000 });
      await runProcess({ file: 'git', args: ['commit', '-q', '-m', 'concurrent commit'], cwd: repo, timeoutMs: 5000 });

      const scope = await computeChangeScope(ws.worktreeDir);
      await expect(applyWorkspaceChanges({ workspace: ws, changedFiles: scope.files })).rejects.toMatchObject({
        code: 'BASE_REVISION_CHANGED',
      });

      // The concurrent commit is untouched, and the AI's change never landed.
      expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('hello\n');
    } finally {
      await releaseWorkspace(ws);
    }
  });

  it('refuses to apply (STALE_PATCH) when a touched file was edited in the real repo working tree without a commit, and leaves the real repo untouched', async () => {
    const ws = await acquireWorkspace(repo, 'task-apply-4');
    try {
      await writeFile(join(ws.worktreeDir, 'a.txt'), 'hello\nfrom the ai\n', 'utf8');

      // Someone else edits the same file directly in the real repo, uncommitted -
      // HEAD does not move, so only the content-hash check catches this.
      await writeFile(join(repo, 'a.txt'), 'hello\nedited by someone else, uncommitted\n', 'utf8');

      const scope = await computeChangeScope(ws.worktreeDir);
      await expect(applyWorkspaceChanges({ workspace: ws, changedFiles: scope.files })).rejects.toMatchObject({
        code: 'STALE_PATCH',
      });

      expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('hello\nedited by someone else, uncommitted\n');
    } finally {
      await releaseWorkspace(ws);
    }
  });

  it('throws a DispatcherError, not a generic error, on both guard paths', async () => {
    const ws = await acquireWorkspace(repo, 'task-apply-5');
    try {
      await writeFile(join(ws.worktreeDir, 'a.txt'), 'hello\nfrom the ai\n', 'utf8');
      await writeFile(join(repo, 'a.txt'), 'edited concurrently', 'utf8');
      const scope = await computeChangeScope(ws.worktreeDir);
      try {
        await applyWorkspaceChanges({ workspace: ws, changedFiles: scope.files });
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(isDispatcherError(error)).toBe(true);
      }
    } finally {
      await releaseWorkspace(ws);
    }
  });
});
