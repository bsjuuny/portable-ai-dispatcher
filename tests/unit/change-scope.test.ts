import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeChangeScope } from '../../src/safety/change-scope.js';
import { runProcess } from '../../src/process/process-runner.js';

describe('computeChangeScope (real git repo)', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'ai-dispatcher-change-scope-test-'));
    await runProcess({ file: 'git', args: ['init', '-q'], cwd: repo, timeoutMs: 10_000 });
    await runProcess({ file: 'git', args: ['config', 'user.email', 't@example.com'], cwd: repo, timeoutMs: 5000 });
    await runProcess({ file: 'git', args: ['config', 'user.name', 'T'], cwd: repo, timeoutMs: 5000 });
    await writeFile(join(repo, 'tracked.txt'), 'line1\nline2\n', 'utf8');
    await runProcess({ file: 'git', args: ['add', '.'], cwd: repo, timeoutMs: 5000 });
    await runProcess({ file: 'git', args: ['commit', '-q', '-m', 'init'], cwd: repo, timeoutMs: 5000 });
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('reports zero scope for a clean working tree', async () => {
    const scope = await computeChangeScope(repo);
    expect(scope).toEqual({ filesChanged: 0, linesAdded: 0, linesDeleted: 0, files: [] });
  });

  it('counts added/deleted lines for a tracked-file modification', async () => {
    await writeFile(join(repo, 'tracked.txt'), 'line1\nline2 modified\nline3\n', 'utf8');
    const scope = await computeChangeScope(repo);
    expect(scope.filesChanged).toBe(1);
    expect(scope.linesAdded).toBe(2);
    expect(scope.linesDeleted).toBe(1);
    expect(scope.files).toEqual(['tracked.txt']);
  });

  it('counts an untracked new file too, via a temporary intent-to-add that is fully undone afterward', async () => {
    await writeFile(join(repo, 'brand-new.txt'), 'a\nb\nc\n', 'utf8');
    const scope = await computeChangeScope(repo);
    expect(scope.filesChanged).toBe(1);
    expect(scope.linesAdded).toBe(3);
    expect(scope.linesDeleted).toBe(0);
    expect(scope.files).toEqual(['brand-new.txt']);

    // The intent-to-add used internally to make numstat see the new file must be
    // fully reverted - the file must still show as untracked (??), not staged.
    const statusOutcome = await runProcess({ file: 'git', args: ['status', '--porcelain'], cwd: repo, timeoutMs: 5000 });
    expect(statusOutcome.stdout.trim()).toBe('?? brand-new.txt');
  });

  it('combines a tracked modification and an untracked new file in one call', async () => {
    await writeFile(join(repo, 'tracked.txt'), 'line1\nline2\nline3\n', 'utf8');
    await writeFile(join(repo, 'brand-new.txt'), 'x\n', 'utf8');
    const scope = await computeChangeScope(repo);
    expect(scope.filesChanged).toBe(2);
    expect(scope.files.sort()).toEqual(['brand-new.txt', 'tracked.txt']);
  });

  it('resolves a pure rename (no shared prefix) into both the old and new path, not the raw "old => new" notation', async () => {
    await runProcess({ file: 'git', args: ['mv', 'tracked.txt', 'renamed.txt'], cwd: repo, timeoutMs: 5000 });
    const scope = await computeChangeScope(repo);
    expect(scope.files.sort()).toEqual(['renamed.txt', 'tracked.txt']);
    expect(scope.files.some((f) => f.includes('=>'))).toBe(false);
  });

  it("resolves a same-directory rename using git's compact `dir/{old => new}` brace notation into real paths", async () => {
    // Live-verified (git 2.53.0): renaming a file within a subdirectory it already
    // shares a committed parent with produces exactly the `sub/{old => new}`
    // notation, distinct from the no-shared-prefix case above.
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(repo, 'sub'), { recursive: true });
    await writeFile(join(repo, 'sub', 'original.txt'), 'a\nb\n', 'utf8');
    await runProcess({ file: 'git', args: ['add', '.'], cwd: repo, timeoutMs: 5000 });
    await runProcess({ file: 'git', args: ['commit', '-q', '-m', 'add sub/original.txt'], cwd: repo, timeoutMs: 5000 });

    await runProcess({ file: 'git', args: ['mv', 'sub/original.txt', 'sub/renamed.txt'], cwd: repo, timeoutMs: 5000 });

    const scope = await computeChangeScope(repo);
    // git always reports forward-slash paths, regardless of OS - not `join()`, which
    // would produce a backslash on Windows and never match.
    expect(scope.files.sort()).toEqual(['sub/original.txt', 'sub/renamed.txt']);
    for (const f of scope.files) {
      expect(f).not.toMatch(/[{}]/);
      expect(f).not.toMatch(/=>/);
    }
  });
});
