import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireWorkspace, releaseWorkspace } from '../../src/safety/workspace.js';
import { runProcess } from '../../src/process/process-runner.js';
import { isDispatcherError } from '../../src/models/error.js';

/** Real `git worktree` operations against a real temp repo (git 2.53.0 confirmed
 * available - see docs/architecture.md) - no mocking of git itself, matching the
 * project-wide convention of exercising real git behavior in tests/unit/git-diff.test.ts
 * and tests/unit/orchestrator.test.ts. */
describe('acquireWorkspace / releaseWorkspace (real git worktree)', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'ai-dispatcher-ws-test-'));
    await runProcess({ file: 'git', args: ['init', '-q'], cwd: repo, timeoutMs: 10_000 });
    await runProcess({ file: 'git', args: ['config', 'user.email', 't@example.com'], cwd: repo, timeoutMs: 5000 });
    await runProcess({ file: 'git', args: ['config', 'user.name', 'T'], cwd: repo, timeoutMs: 5000 });
    await writeFile(join(repo, 'a.txt'), 'v1', 'utf8');
    await runProcess({ file: 'git', args: ['add', '.'], cwd: repo, timeoutMs: 5000 });
    await runProcess({ file: 'git', args: ['commit', '-q', '-m', 'init'], cwd: repo, timeoutMs: 5000 });
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('creates a real worktree checked out at the real repo HEAD, on its own branch', async () => {
    const headOutcome = await runProcess({ file: 'git', args: ['rev-parse', 'HEAD'], cwd: repo, timeoutMs: 5000 });
    const expectedHead = headOutcome.stdout.trim();

    const ws = await acquireWorkspace(repo, 'task-1');
    try {
      expect(ws.baseRevision).toBe(expectedHead);
      expect(ws.branchName).toBe('ai-dispatcher/task-1');
      await expect(access(join(ws.worktreeDir, 'a.txt'))).resolves.toBeUndefined();

      // `git worktree list` always prints forward-slash paths, even on Windows -
      // normalize before comparing against the OS-native path Node's join() built.
      const listOutcome = await runProcess({ file: 'git', args: ['worktree', 'list'], cwd: repo, timeoutMs: 5000 });
      expect(listOutcome.stdout.replace(/\\/g, '/')).toContain(ws.worktreeDir.replace(/\\/g, '/'));
    } finally {
      await releaseWorkspace(ws);
    }
  });

  it('an edit made inside the worktree never touches the real repository working tree', async () => {
    const ws = await acquireWorkspace(repo, 'task-2');
    try {
      await writeFile(join(ws.worktreeDir, 'a.txt'), 'edited in worktree', 'utf8');
      const realStatus = await runProcess({ file: 'git', args: ['status', '--porcelain'], cwd: repo, timeoutMs: 5000 });
      expect(realStatus.stdout.trim()).toBe(''); // real repo working tree is untouched
    } finally {
      await releaseWorkspace(ws);
    }
  });

  it('releaseWorkspace removes the worktree and deletes its branch', async () => {
    const ws = await acquireWorkspace(repo, 'task-3');
    await releaseWorkspace(ws);

    const listOutcome = await runProcess({ file: 'git', args: ['worktree', 'list'], cwd: repo, timeoutMs: 5000 });
    expect(listOutcome.stdout).not.toContain(ws.worktreeDir);

    const branchOutcome = await runProcess({ file: 'git', args: ['branch', '--list', ws.branchName], cwd: repo, timeoutMs: 5000 });
    expect(branchOutcome.stdout.trim()).toBe('');
  });

  it('releaseWorkspace still succeeds via the fs.rm fallback when `git worktree remove` fails on a deep path (live-reproduced Windows "Filename too long")', async () => {
    const ws = await acquireWorkspace(repo, 'task-5');

    // Reproduces the real trigger: an AI implementer running `pnpm install` inside
    // the worktree produces a deeply-nested `.pnpm` store path that Windows/git's
    // own directory removal cannot delete, even though Node's fs.rm can.
    const deepDir = join(
      ws.worktreeDir,
      'node_modules',
      '.pnpm',
      '@typescript-eslint+eslint-plugin@8.67.0_@typescript-eslint+parser@8.67.0_eslint@10.8.1_typescript@5.9.3',
      'node_modules',
      '@typescript-eslint',
      'eslint-plugin',
      'dist',
      'rules',
      'naming-convention-utils',
    );
    await mkdir(deepDir, { recursive: true });
    await writeFile(join(deepDir, 'very-long-generated-filename-that-adds-to-the-total-path-length.js'), 'x', 'utf8');

    await releaseWorkspace(ws);

    const listOutcome = await runProcess({ file: 'git', args: ['worktree', 'list'], cwd: repo, timeoutMs: 5000 });
    expect(listOutcome.stdout).not.toContain(ws.worktreeDir);

    const branchOutcome = await runProcess({ file: 'git', args: ['branch', '--list', ws.branchName], cwd: repo, timeoutMs: 5000 });
    expect(branchOutcome.stdout.trim()).toBe('');

    await expect(access(ws.worktreeDir)).rejects.toThrow();
  }, 20_000);

  it('throws WORKSPACE_ACQUIRE_FAILED for a directory that is not a git repository', async () => {
    const notARepo = await mkdtemp(join(tmpdir(), 'ai-dispatcher-not-a-repo-'));
    try {
      await acquireWorkspace(notARepo, 'task-4');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isDispatcherError(error)).toBe(true);
      if (isDispatcherError(error)) expect(error.code).toBe('WORKSPACE_ACQUIRE_FAILED');
    } finally {
      await rm(notARepo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
});
