import { describe, expect, it, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveFailureArtifact } from '../../src/logging/failure-artifacts.js';
import { DispatcherError } from '../../src/models/error.js';

const dirsToClean: string[] = [];
afterEach(async () => {
  await Promise.all(dirsToClean.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ai-dispatcher-artifacts-'));
  dirsToClean.push(dir);
  return dir;
}

describe('saveFailureArtifact', () => {
  it('writes metadata.json, stdout.log, stderr.log, and error.json under .dispatcher/runs/<executionId>/ (spec section 74)', async () => {
    const root = await tempRoot();
    const dir = await saveFailureArtifact(root, {
      taskId: 't1',
      executionId: 'exec_abc',
      provider: 'codex',
      command: { file: 'codex', args: ['-a', 'never', 'exec', '--json'], cwd: root, timeoutMs: 1000 },
      outcome: { exitCode: 1, stdout: 'partial output', stderr: 'boom', timedOut: false, durationMs: 500 },
      error: new DispatcherError({ code: 'PROCESS_EXIT_ERROR', message: 'exited 1', retryable: false }),
      startedAt: '2026-01-01T00:00:00Z',
      finishedAt: '2026-01-01T00:00:01Z',
    });

    expect(dir).toBe(join(root, '.dispatcher', 'runs', 'exec_abc'));
    await expect(access(join(dir, 'metadata.json'))).resolves.toBeUndefined();
    await expect(access(join(dir, 'stdout.log'))).resolves.toBeUndefined();
    await expect(access(join(dir, 'stderr.log'))).resolves.toBeUndefined();
    await expect(access(join(dir, 'error.json'))).resolves.toBeUndefined();

    const metadata = JSON.parse(await readFile(join(dir, 'metadata.json'), 'utf8'));
    expect(metadata.taskId).toBe('t1');
    expect(metadata.provider).toBe('codex');
    expect(metadata.exitCode).toBe(1);
    expect(metadata.args).toEqual(['-a', 'never', 'exec', '--json']);

    expect(await readFile(join(dir, 'stdout.log'), 'utf8')).toBe('partial output');
    expect(await readFile(join(dir, 'stderr.log'), 'utf8')).toBe('boom');

    const errorJson = JSON.parse(await readFile(join(dir, 'error.json'), 'utf8'));
    expect(errorJson.code).toBe('PROCESS_EXIT_ERROR');
  });

  it('does not write error.json when no error is provided', async () => {
    const root = await tempRoot();
    const dir = await saveFailureArtifact(root, {
      taskId: 't1',
      executionId: 'exec_def',
      provider: 'claude',
      command: { file: 'claude', args: [], cwd: root, timeoutMs: 1000 },
      outcome: { exitCode: 1, stdout: '', stderr: '', timedOut: false, durationMs: 100 },
      startedAt: '2026-01-01T00:00:00Z',
      finishedAt: '2026-01-01T00:00:01Z',
    });
    await expect(access(join(dir, 'error.json'))).rejects.toThrow();
  });

  it('scrubs secrets from stdout/stderr before writing (never writes raw prompt content per the redaction policy)', async () => {
    const root = await tempRoot();
    const dir = await saveFailureArtifact(root, {
      taskId: 't1',
      executionId: 'exec_ghi',
      provider: 'codex',
      command: { file: 'codex', args: [], cwd: root, timeoutMs: 1000 },
      outcome: { exitCode: 1, stdout: '', stderr: 'auth failed for token=ghp_1234567890abcdefghijklmnopqrstuvwxyz', timedOut: false, durationMs: 100 },
      startedAt: '2026-01-01T00:00:00Z',
      finishedAt: '2026-01-01T00:00:01Z',
    });
    const stderr = await readFile(join(dir, 'stderr.log'), 'utf8');
    expect(stderr).not.toContain('ghp_1234567890abcdefghijklmnopqrstuvwxyz');
    expect(stderr).toContain('[REDACTED]');
  });

  it('accepts a plain {code,message} error shape (not just a DispatcherError instance)', async () => {
    const root = await tempRoot();
    const dir = await saveFailureArtifact(root, {
      taskId: 't1',
      executionId: 'exec_jkl',
      provider: 'claude',
      command: { file: 'claude', args: [], cwd: root, timeoutMs: 1000 },
      outcome: { exitCode: 1, stdout: '', stderr: '', timedOut: false, durationMs: 100 },
      error: { code: 'SOME_CODE', message: 'plain error object' },
      startedAt: '2026-01-01T00:00:00Z',
      finishedAt: '2026-01-01T00:00:01Z',
    });
    const errorJson = JSON.parse(await readFile(join(dir, 'error.json'), 'utf8'));
    expect(errorJson).toEqual({ code: 'SOME_CODE', message: 'plain error object' });
  });
});
