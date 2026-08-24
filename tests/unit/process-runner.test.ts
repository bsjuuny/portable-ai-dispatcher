import { describe, expect, it } from 'vitest';
import { runProcess, assertArgvIsStringArray } from '../../src/process/process-runner.js';

describe('runProcess', () => {
  it('runs a real trivial process and captures stdout/exit code', async () => {
    const outcome = await runProcess({
      file: process.execPath,
      args: ['-e', 'process.stdout.write("hello"); process.exit(0)'],
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toBe('hello');
    expect(outcome.timedOut).toBe(false);
  });

  it('reports timedOut:true and a non-zero exit when the process runs past timeoutMs', async () => {
    const outcome = await runProcess({
      file: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 30_000)'],
      cwd: process.cwd(),
      timeoutMs: 1_000,
    });
    expect(outcome.timedOut).toBe(true);
  }, 15_000);

  it('uses stdout activity to renew the idle timeout lease', async () => {
    const activities: number[] = [];
    const outcome = await runProcess({
      file: process.execPath,
      args: ['-e', 'let n=0; setInterval(()=>{console.log("."); if(++n===30) process.exit(0)},200)'],
      cwd: process.cwd(),
      timeoutMs: 15_000,
      idleTimeoutMs: 5_000,
      onActivity: (event) => activities.push(event.elapsedMs),
    });
    expect(outcome.timedOut).toBe(false);
    expect(outcome.activityCount).toBeGreaterThan(1);
    expect(activities.length).toBeGreaterThan(1);
  }, 20_000);

  it('ends a silent process at the idle timeout before its hard timeout', async () => {
    const startedAt = Date.now();
    const outcome = await runProcess({
      file: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 30_000)'],
      cwd: process.cwd(),
      timeoutMs: 5_000,
      idleTimeoutMs: 500,
    });
    expect(outcome.timedOut).toBe(true);
    expect(outcome.timeoutReason).toBe('idle');
    expect(Date.now() - startedAt).toBeLessThan(4_000);
  }, 10_000);

  /**
   * Regression test for a real, live-reproduced incident (2026-08-22): `ai-dispatcher
   * fix` hung for 11+ minutes despite `execution.timeoutMs` defaulting to 5 minutes.
   * Root cause: `codex` on Windows is an npm .cmd shim -> node -> a native worker
   * binary. When the worker stalled on a network call, execa's timeout killed only
   * the process it directly spawned - the still-alive worker kept the inherited
   * stdout/stderr pipes open, so execa's own promise never resolved (it waits for
   * those streams to close), regardless of `timeoutMs`.
   *
   * This reproduces that exact shape: the direct child spawns a detached grandchild
   * that inherits its stdio (the same pipe execa is reading), then both processes
   * outlive the configured timeout. Without `killDescendants: true` in
   * process-runner.ts, this test would hang until the outer 15s vitest timeout killed
   * the *test*, not runProcess() - proving the fix, not just asserting it, requires
   * runProcess() to actually return well before that.
   */
  it('does not hang past timeoutMs when the spawned process itself spawns a further descendant that inherits its stdio', async () => {
    const script = `
      const { spawn } = require('node:child_process');
      const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], {
        stdio: 'inherit',
        detached: true,
      });
      grandchild.unref();
      setTimeout(() => {}, 60_000);
    `;
    const startedAt = Date.now();
    const outcome = await runProcess({
      file: process.execPath,
      args: ['-e', script],
      cwd: process.cwd(),
      timeoutMs: 2_000,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(outcome.timedOut).toBe(true);
    expect(outcome.treeTermination, outcome.treeTerminationMessage).toBe('succeeded');
    // Generous upper bound (still far short of the old ~11-minute real-world hang) -
    // this is the actual point of the test: runProcess() returns close to timeoutMs,
    // not "eventually, whenever the orphaned grandchild happens to exit."
    expect(elapsedMs).toBeLessThan(10_000);
  }, 15_000);
});

describe('assertArgvIsStringArray', () => {
  it('accepts a flat string array', () => {
    expect(() => assertArgvIsStringArray(['a', 'b'])).not.toThrow();
  });

  it('rejects a non-array', () => {
    expect(() => assertArgvIsStringArray('a b c')).toThrow();
  });

  it('rejects an array containing a non-string element', () => {
    expect(() => assertArgvIsStringArray(['a', 1, 'c'])).toThrow();
  });
});
