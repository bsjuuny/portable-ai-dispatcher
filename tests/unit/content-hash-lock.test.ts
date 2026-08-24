import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkContentHashesUnchanged, assertContentHashesUnchanged } from '../../src/safety/content-hash-lock.js';
import { runProcess } from '../../src/process/process-runner.js';
import { isDispatcherError } from '../../src/models/error.js';

describe('checkContentHashesUnchanged / assertContentHashesUnchanged (real git repo)', () => {
  let repo: string;
  let baseRevision: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'ai-dispatcher-hash-lock-test-'));
    await runProcess({ file: 'git', args: ['init', '-q'], cwd: repo, timeoutMs: 10_000 });
    await runProcess({ file: 'git', args: ['config', 'user.email', 't@example.com'], cwd: repo, timeoutMs: 5000 });
    await runProcess({ file: 'git', args: ['config', 'user.name', 'T'], cwd: repo, timeoutMs: 5000 });
    await writeFile(join(repo, 'a.txt'), 'v1', 'utf8');
    await runProcess({ file: 'git', args: ['add', '.'], cwd: repo, timeoutMs: 5000 });
    await runProcess({ file: 'git', args: ['commit', '-q', '-m', 'init'], cwd: repo, timeoutMs: 5000 });
    const headOutcome = await runProcess({ file: 'git', args: ['rev-parse', 'HEAD'], cwd: repo, timeoutMs: 5000 });
    baseRevision = headOutcome.stdout.trim();
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('matches when the real repo working tree is unchanged since the base revision', async () => {
    const check = await checkContentHashesUnchanged(repo, baseRevision, ['a.txt']);
    expect(check.matches).toBe(true);
    expect(() => assertContentHashesUnchanged(check, 'task-1')).not.toThrow();
  });

  it('flags a file as stale when it was edited in the real repo without being committed (base-revision alone would miss this)', async () => {
    await writeFile(join(repo, 'a.txt'), 'edited uncommitted', 'utf8');
    const check = await checkContentHashesUnchanged(repo, baseRevision, ['a.txt']);
    expect(check.matches).toBe(false);
    expect(check.staleFiles).toEqual(['a.txt']);

    try {
      assertContentHashesUnchanged(check, 'task-2');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isDispatcherError(error)).toBe(true);
      if (isDispatcherError(error)) expect(error.code).toBe('STALE_PATCH');
    }
  });

  it('treats a new file absent both at the base revision and currently as unchanged (not stale)', async () => {
    const check = await checkContentHashesUnchanged(repo, baseRevision, ['brand-new-does-not-exist.txt']);
    expect(check.matches).toBe(true);
  });

  it('flags a conflicting new file: absent at base revision but now present in the real repo at that same path', async () => {
    await writeFile(join(repo, 'new.txt'), 'someone else created this', 'utf8');
    const check = await checkContentHashesUnchanged(repo, baseRevision, ['new.txt']);
    expect(check.matches).toBe(false);
    expect(check.staleFiles).toEqual(['new.txt']);
  });
});
