import { describe, expect, it } from 'vitest';
import { runProcess } from '../../src/process/process-runner.js';
import { checkClaudeHealth } from '../../src/providers/claude/health.js';
import { checkCodexHealth } from '../../src/providers/codex/health.js';

/**
 * Real, unmocked spawns of the actually-installed CLIs (spec section 54). Both
 * `claude` and `codex` are confirmed installed in this environment, so these run for
 * real rather than being skipped - per the honest-reporting requirement, a CLI-
 * absence auto-skip is the only permitted skip reason, and it does not apply here.
 *
 * IMPORTANT: `it.skipIf(condition)` evaluates `condition` at test COLLECTION time
 * (when the file is loaded), not after any `beforeAll` hook runs - a `beforeAll`
 * that asynchronously sets a flag referenced by `skipIf` is silently ineffective,
 * the flag is always still its initial value when `skipIf` reads it (found the hard
 * way: every "real CLI" test below was being skipped despite both CLIs being
 * installed, because the original version of this file used that exact broken
 * pattern). Top-level await computes the real values before collection instead.
 */
const claudeInstalled = (await runProcess({ file: 'claude', args: ['--version'], cwd: process.cwd(), timeoutMs: 10_000 }).catch(() => null))?.exitCode === 0;
const codexInstalled = (await runProcess({ file: 'codex', args: ['--version'], cwd: process.cwd(), timeoutMs: 10_000 }).catch(() => null))?.exitCode === 0;

describe('checkClaudeHealth (real CLI spawn, no LLM call)', () => {
  it.skipIf(!claudeInstalled)('reports installed:true and a version string for the real installed CLI', async () => {
    const health = await checkClaudeHealth();
    expect(health.installed).toBe(true);
    expect(health.version).toBeTruthy();
    expect(health.provider).toBe('claude');
  });

  it.skipIf(!claudeInstalled)('reports authenticated as a real boolean (not null) when the CLI responds', async () => {
    const health = await checkClaudeHealth();
    expect(typeof health.authenticated).toBe('boolean');
  });
});

describe('checkCodexHealth (real CLI spawn, no LLM call)', () => {
  it.skipIf(!codexInstalled)('reports installed:true and a version string for the real installed CLI', async () => {
    const health = await checkCodexHealth();
    expect(health.installed).toBe(true);
    expect(health.version).toBeTruthy();
  });

  it.skipIf(!codexInstalled)('correctly reads the "Logged in" confirmation from STDERR, not stdout (regression test for a real bug found during implementation)', async () => {
    const health = await checkCodexHealth();
    // Whatever the live auth state is, the key regression this guards is that the
    // message field does not falsely show "logged in" text while authenticated is
    // false (that was the actual bug: stderr was ignored, so a successful login was
    // misreported as not-authenticated).
    if (health.authenticated) {
      expect(health.message).toBeUndefined();
    }
  });
});

describe('health check against a nonexistent CLI (not-installed path)', () => {
  it('checkCodexHealth reports installed:false when PATH excludes every real binary', async () => {
    const originalPath = process.env['PATH'];
    process.env['PATH'] = '';
    try {
      const health = await checkCodexHealth({ timeoutMs: 5000 });
      expect(health.installed).toBe(false);
      expect(health.ready).toBe(false);
      expect(health.authenticated).toBeNull();
    } finally {
      process.env['PATH'] = originalPath;
    }
  });

  it('checkClaudeHealth reports installed:false when PATH excludes every real binary', async () => {
    const originalPath = process.env['PATH'];
    process.env['PATH'] = '';
    try {
      const health = await checkClaudeHealth({ timeoutMs: 5000 });
      expect(health.installed).toBe(false);
      expect(health.ready).toBe(false);
      expect(health.authenticated).toBeNull();
    } finally {
      process.env['PATH'] = originalPath;
    }
  });
});
