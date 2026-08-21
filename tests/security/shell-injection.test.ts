import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runProcess } from '../../src/process/process-runner.js';
import { buildClaudeCommand } from '../../src/providers/claude/command-builder.js';
import { buildCodexCommand } from '../../src/providers/codex/command-builder.js';
import type { DispatcherTask } from '../../src/models/task.js';
import type { TaskContext } from '../../src/models/context.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ECHO_ARGV_SCRIPT = join(__dirname, '..', 'fixtures', 'echo-argv.mjs');

// Each payload is a well-known shell-metacharacter attack shape. Spec section 14/86:
// none of these must ever be interpreted as shell syntax - they must always survive
// as inert, literal data.
const INJECTION_PAYLOADS: string[] = [
  '; rm -rf /',
  '; Remove-Item -Recurse -Force C:\\',
  '$(whoami)',
  '`id`',
  '$(Get-Process)',
  '&& echo pwned',
  '|| echo pwned',
  '| cat /etc/passwd',
  '$env:PATH',
  '%PATH%',
  '--dangerously-skip-permissions',
  '--',
  'a'.repeat(120_000), // >100KB single-line payload
];

function buildTask(rawDescription: string): DispatcherTask {
  const now = new Date().toISOString();
  return {
    id: 'task_injection_test',
    command: 'fix',
    specification: { rawDescription, attachments: [], sourcePaths: [] },
    workingDirectory: process.cwd(),
    status: 'created',
    createdAt: now,
    updatedAt: now,
  };
}

const EMPTY_CONTEXT: TaskContext = {};

describe('shell-injection resistance: command builders', () => {
  it.each(INJECTION_PAYLOADS)('Claude command builder treats %s as inert stdin content, not argv', (payload) => {
    const task = buildTask(payload);
    const plan = buildClaudeCommand(task, EMPTY_CONTEXT, {
      sandbox: 'workspace-write',
      approval: 'never',
      timeoutMs: 5000,
    });

    // The payload must appear only inside stdinContent, never as its own argv element.
    expect(plan.args).not.toContain(payload);
    expect(plan.stdinContent).toContain(payload);
  });

  it.each(INJECTION_PAYLOADS)('Codex command builder treats %s as inert stdin content, not argv', (payload) => {
    const task = buildTask(payload);
    const plan = buildCodexCommand(task, EMPTY_CONTEXT, {
      sandbox: 'workspace-write',
      approval: 'never',
      timeoutMs: 5000,
    });

    expect(plan.args).not.toContain(payload);
    expect(plan.stdinContent).toContain(payload);
  });
});

describe('shell-injection resistance: real OS spawn (contract-level)', () => {
  it.each(INJECTION_PAYLOADS.filter((p) => p.length < 10_000))(
    'runProcess passes %s through to a real child process byte-for-byte, unshelled',
    async (payload) => {
      const outcome = await runProcess({
        file: process.execPath,
        args: [ECHO_ARGV_SCRIPT, payload],
        cwd: process.cwd(),
        timeoutMs: 10_000,
      });

      expect(outcome.exitCode).toBe(0);
      const echoed = JSON.parse(outcome.stdout) as string[];
      expect(echoed).toEqual([payload]);
    },
  );

  it('runProcess never invokes a shell even when shell metacharacters are present', async () => {
    // If a shell were involved, `; echo INJECTED` would produce extra output/a
    // second process; with shell:false it's just one inert argv element.
    const outcome = await runProcess({
      file: process.execPath,
      args: [ECHO_ARGV_SCRIPT, 'safe; echo INJECTED'],
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });
    expect(outcome.stdout).not.toContain('INJECTED\n');
    const echoed = JSON.parse(outcome.stdout) as string[];
    expect(echoed).toEqual(['safe; echo INJECTED']);
  });
});
