import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess } from '../../src/process/process-runner.js';
import { computeGitDiff } from '../../src/validation/git-diff.js';

async function git(cwd: string, args: string[]): Promise<void> {
  const outcome = await runProcess({ file: 'git', args, cwd, timeoutMs: 10_000 });
  if (outcome.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${outcome.stderr}`);
}

describe('computeGitDiff (real git repo)', () => {
  let repo: string;

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), 'ai-dispatcher-gitdiff-'));
    await git(repo, ['init', '-q']);
    await git(repo, ['config', 'user.email', 'test@example.com']);
    await git(repo, ['config', 'user.name', 'Test']);
    await writeFile(join(repo, 'existing.txt'), 'v1', 'utf8');
    await writeFile(join(repo, '.env'), 'SECRET=1', 'utf8');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-q', '-m', 'initial']);
  });

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('reports no changes on a clean tree', async () => {
    const diff = await computeGitDiff(repo, []);
    expect(diff.changedFiles).toEqual([]);
    expect(diff.protectedPathsTouched).toEqual([]);
  });

  it('detects a modified tracked file', async () => {
    await writeFile(join(repo, 'existing.txt'), 'v2', 'utf8');
    const diff = await computeGitDiff(repo, []);
    expect(diff.changedFiles).toContain('existing.txt');
    await git(repo, ['checkout', '--', 'existing.txt']); // reset for the next test
  });

  it('detects a new untracked file as added', async () => {
    await writeFile(join(repo, 'new-file.txt'), 'hello', 'utf8');
    const diff = await computeGitDiff(repo, []);
    expect(diff.addedFiles).toContain('new-file.txt');
    expect(diff.changedFiles).toContain('new-file.txt');
    await unlink(join(repo, 'new-file.txt'));
  });

  it('detects a deleted tracked file', async () => {
    await writeFile(join(repo, 'to-delete.txt'), 'bye', 'utf8');
    await git(repo, ['add', 'to-delete.txt']);
    await git(repo, ['commit', '-q', '-m', 'add file to delete']);
    await unlink(join(repo, 'to-delete.txt'));

    const diff = await computeGitDiff(repo, []);
    expect(diff.deletedFiles).toContain('to-delete.txt');
  });

  it('flags a protected path when it is modified', async () => {
    await writeFile(join(repo, '.env'), 'SECRET=2', 'utf8');
    const diff = await computeGitDiff(repo, ['.env', 'secrets/']);
    expect(diff.protectedPathsTouched).toContain('.env');
    await git(repo, ['checkout', '--', '.env']);
  });
});
