import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeOnce } from '../../src/core/dispatch-execution.js';
import type { AIProvider, ProviderCommandPlan } from '../../src/providers/types.js';
import type { DispatcherTask } from '../../src/models/task.js';
import type { TaskContext } from '../../src/models/context.js';
import type { TaskResult } from '../../src/models/result.js';

/** A provider that defines executeDirect - the new alternate path dispatch-
 * execution.ts must check before ever calling buildCommand/parseOutcome. */
class DirectProvider implements AIProvider {
  readonly id = 'local-fast' as const;
  buildCommandCalled = false;

  constructor(private readonly impl: (task: DispatcherTask) => Promise<TaskResult>) {}

  capabilities() {
    return ['analysis'] as never;
  }

  async checkHealth() {
    return { provider: this.id, checkedAt: new Date().toISOString(), installed: true, authenticated: true, reachable: true, rateLimited: false, ready: true };
  }

  buildCommand(): ProviderCommandPlan {
    this.buildCommandCalled = true;
    throw new Error('buildCommand should never be called for a provider that defines executeDirect');
  }

  parseOutcome(): TaskResult {
    throw new Error('parseOutcome should never be called for a provider that defines executeDirect');
  }

  async executeDirect(task: DispatcherTask): Promise<TaskResult> {
    return this.impl(task);
  }
}

function buildTask(overrides: Partial<DispatcherTask> = {}, workingDirectory: string): DispatcherTask {
  const now = new Date().toISOString();
  return {
    id: 'task-1',
    command: 'ask',
    specification: { rawDescription: 'hi', attachments: [], sourcePaths: [] },
    workingDirectory,
    status: 'created',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const emptyContext: TaskContext = {};
const runOptions = { sandbox: 'read-only' as const, approval: 'never' as const, timeoutMs: 30_000 };

describe('executeOnce - executeDirect branch (Local LLM Adapter increment)', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'ai-dispatcher-dispatch-exec-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('calls executeDirect and never buildCommand/parseOutcome when executeDirect is defined', async () => {
    const provider = new DirectProvider(async (task) => ({
      taskId: task.id,
      executionId: 'irrelevant',
      provider: 'local-fast',
      status: 'success',
      text: 'the answer',
      durationMs: 5,
    }));

    const { result } = await executeOnce(provider, buildTask({}, workDir), emptyContext, runOptions);
    expect(result.status).toBe('success');
    expect(result.text).toBe('the answer');
    expect(provider.buildCommandCalled).toBe(false);
  });

  it('assigns its own executionId, distinct from whatever the provider result carries', async () => {
    const provider = new DirectProvider(async (task) => ({
      taskId: task.id,
      executionId: 'provider-supplied-id',
      provider: 'local-fast',
      status: 'success',
      durationMs: 1,
    }));
    const { executionId } = await executeOnce(provider, buildTask({}, workDir), emptyContext, runOptions);
    expect(executionId).toMatch(/^exec_/);
  });

  it('wraps a thrown error from executeDirect the same way a process-spawn failure is wrapped', async () => {
    const provider = new DirectProvider(async () => {
      throw new Error('runtime unreachable');
    });
    await expect(executeOnce(provider, buildTask({}, workDir), emptyContext, runOptions)).rejects.toThrow('runtime unreachable');
  });

  it('saves a failure artifact for a failed-status TaskResult, using a synthetic command plan (no real process to describe)', async () => {
    const provider = new DirectProvider(async (task) => ({
      taskId: task.id,
      executionId: 'e1',
      provider: 'local-fast',
      status: 'failed',
      durationMs: 1,
      error: { message: 'model not found' },
    }));

    const { result } = await executeOnce(provider, buildTask({}, workDir), emptyContext, runOptions, { saveFailureArtifacts: true });
    expect(result.rawOutputPath).toBeDefined();
    await expect(access(result.rawOutputPath!)).resolves.toBeUndefined();
  });

  it('does not save a failure artifact for a successful result', async () => {
    const provider = new DirectProvider(async (task) => ({
      taskId: task.id,
      executionId: 'e1',
      provider: 'local-fast',
      status: 'success',
      durationMs: 1,
    }));
    const { result } = await executeOnce(provider, buildTask({}, workDir), emptyContext, runOptions, { saveFailureArtifacts: true });
    expect(result.rawOutputPath).toBeUndefined();
    await expect(access(join(workDir, '.dispatcher', 'runs'))).rejects.toThrow();
  });
});
