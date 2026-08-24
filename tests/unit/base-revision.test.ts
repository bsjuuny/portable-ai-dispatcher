import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkBaseRevisionUnchanged, assertBaseRevisionUnchanged } from '../../src/safety/base-revision.js';
import { runProcess } from '../../src/process/process-runner.js';
import { isDispatcherError } from '../../src/models/error.js';

describe('checkBaseRevisionUnchanged / assertBaseRevisionUnchanged (real git repo)', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'ai-dispatcher-base-rev-test-'));
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

  it('matches when HEAD has not moved', async () => {
    const headOutcome = await runProcess({ file: 'git', args: ['rev-parse', 'HEAD'], cwd: repo, timeoutMs: 5000 });
    const head = headOutcome.stdout.trim();

    const check = await checkBaseRevisionUnchanged(repo, head);
    expect(check.matches).toBe(true);
    expect(() => assertBaseRevisionUnchanged(check, 'task-1')).not.toThrow();
  });

  it('does not match after a new commit lands on the real repo', async () => {
    const headOutcome = await runProcess({ file: 'git', args: ['rev-parse', 'HEAD'], cwd: repo, timeoutMs: 5000 });
    const originalHead = headOutcome.stdout.trim();

    await writeFile(join(repo, 'a.txt'), 'v2', 'utf8');
    await runProcess({ file: 'git', args: ['add', '.'], cwd: repo, timeoutMs: 5000 });
    await runProcess({ file: 'git', args: ['commit', '-q', '-m', 'second'], cwd: repo, timeoutMs: 5000 });

    const check = await checkBaseRevisionUnchanged(repo, originalHead);
    expect(check.matches).toBe(false);
    expect(check.currentRevision).not.toBe(originalHead);

    try {
      assertBaseRevisionUnchanged(check, 'task-2');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isDispatcherError(error)).toBe(true);
      if (isDispatcherError(error)) expect(error.code).toBe('BASE_REVISION_CHANGED');
    }
  });
});
