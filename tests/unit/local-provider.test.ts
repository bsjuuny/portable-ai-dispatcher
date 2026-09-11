import { describe, expect, it } from 'vitest';
import { LocalProvider } from '../../src/providers/local/local-provider.js';
import type { LocalGenerationRequest, LocalGenerationResult, LocalModelInfo, LocalRuntimeAdapter, LocalRuntimeStatus } from '../../src/models/local.js';
import type { DispatcherTask } from '../../src/models/task.js';
import type { TaskContext } from '../../src/models/context.js';
import { isDispatcherError } from '../../src/models/error.js';

class FakeRuntimeAdapter implements LocalRuntimeAdapter {
  readonly kind = 'ollama' as const;
  lastRequest: LocalGenerationRequest | undefined;

  constructor(
    private readonly detectResult: LocalRuntimeStatus,
    private readonly generateResult: LocalGenerationResult | (() => never) = { text: 'a response', raw: {}, durationMs: 5, thinkingStripped: false },
    private readonly models: LocalModelInfo[] = [{ runtime: 'ollama', name: 'qwen3:4b' }],
  ) {}

  async detect(): Promise<LocalRuntimeStatus> {
    return this.detectResult;
  }

  async listModels(): Promise<LocalModelInfo[]> {
    return this.models;
  }

  async generate(request: LocalGenerationRequest): Promise<LocalGenerationResult> {
    this.lastRequest = request;
    if (typeof this.generateResult === 'function') return this.generateResult();
    return this.generateResult;
  }
}

function buildTask(overrides: Partial<DispatcherTask> = {}): DispatcherTask {
  const now = new Date().toISOString();
  return {
    id: 'task-1',
    command: 'ask',
    specification: { rawDescription: 'what does this repo do?', attachments: [], sourcePaths: [] },
    workingDirectory: process.cwd(),
    status: 'created',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const emptyContext: TaskContext = {};

describe('LocalProvider', () => {
  it('derives its id as local-<profile name>', () => {
    const provider = new LocalProvider(
      { name: 'fast', runtime: 'ollama', model: 'qwen3:4b' },
      new FakeRuntimeAdapter({ runtime: 'ollama', host: 'x', reachable: true, checkedAt: 'now' }),
      'http://127.0.0.1:11434',
    );
    expect(provider.id).toBe('local-fast');
    expect(provider.dataResidency).toBe('local');
  });

  it('defaults capabilities to autonomous coding when local coding is enabled', () => {
    const provider = new LocalProvider(
      { name: 'fast', runtime: 'ollama', model: 'qwen3:4b' },
      new FakeRuntimeAdapter({ runtime: 'ollama', host: 'x', reachable: true, checkedAt: 'now' }),
      'http://127.0.0.1:11434',
    );
    expect(provider.capabilities()).toEqual(expect.arrayContaining(['analysis', 'review', 'implementation', 'bugfix']));
  });

  it('uses text-only capabilities when autonomous coding is disabled', () => {
    const provider = new LocalProvider(
      { name: 'fast', runtime: 'ollama', model: 'qwen3:4b' },
      new FakeRuntimeAdapter({ runtime: 'ollama', host: 'x', reachable: true, checkedAt: 'now' }),
      'http://127.0.0.1:11434',
      { enabled: false, maxTurns: 24, maxFilesChanged: 20, maxFileBytes: 1_048_576, maxReadLines: 400, maxOutputTokens: 1_024 },
    );
    expect(provider.capabilities()).toEqual(['analysis', 'review', 'documentation']);
  });

  it('uses the profile-declared capabilities when present', () => {
    const provider = new LocalProvider(
      { name: 'fast', runtime: 'ollama', model: 'qwen3:4b', capabilities: ['implementation'] },
      new FakeRuntimeAdapter({ runtime: 'ollama', host: 'x', reachable: true, checkedAt: 'now' }),
      'http://127.0.0.1:11434',
    );
    expect(provider.capabilities()).toEqual(['implementation']);
  });

  it('checkHealth maps runtime reachability onto ProviderHealth (installed/authenticated/ready mirror reachable)', async () => {
    const provider = new LocalProvider(
      { name: 'fast', runtime: 'ollama', model: 'qwen3:4b' },
      new FakeRuntimeAdapter({ runtime: 'ollama', host: 'x', reachable: true, version: '0.32.14', checkedAt: 'now' }),
      'http://127.0.0.1:11434',
    );
    const health = await provider.checkHealth();
    expect(health.provider).toBe('local-fast');
    expect(health.installed).toBe(true);
    expect(health.ready).toBe(true);
    expect(health.reachable).toBe(true);
    expect(health.authenticated).toBe(true);
    expect(health.version).toBe('0.32.14');
  });

  it('checkHealth reports not-ready when the runtime is unreachable', async () => {
    const provider = new LocalProvider(
      { name: 'fast', runtime: 'ollama', model: 'qwen3:4b' },
      new FakeRuntimeAdapter({ runtime: 'ollama', host: 'x', reachable: false, checkedAt: 'now', message: 'connection refused' }),
      'http://127.0.0.1:11434',
    );
    const health = await provider.checkHealth();
    expect(health.ready).toBe(false);
    expect(health.reachable).toBe(false);
    expect(health.message).toBe('connection refused');
  });

  it('checkHealth reports not-ready when the configured model is not loaded', async () => {
    const provider = new LocalProvider(
      { name: 'heavy', runtime: 'ollama', model: 'qwen3:8b' },
      new FakeRuntimeAdapter(
        { runtime: 'ollama', host: 'x', reachable: true, checkedAt: 'now' },
        { text: '', raw: {}, durationMs: 0, thinkingStripped: false },
        [{ runtime: 'ollama', name: 'qwen3:4b' }],
      ),
      'http://127.0.0.1:11434',
    );

    const health = await provider.checkHealth();
    expect(health).toMatchObject({ ready: false, reachable: true, reasonCode: 'LOCAL_MODEL_NOT_FOUND' });
    expect(health.message).toContain('qwen3:8b');
  });

  it('treats an omitted :latest tag as the same loaded model', async () => {
    const provider = new LocalProvider(
      { name: 'fast', runtime: 'ollama', model: 'qwen3' },
      new FakeRuntimeAdapter(
        { runtime: 'ollama', host: 'x', reachable: true, checkedAt: 'now' },
        { text: '', raw: {}, durationMs: 0, thinkingStripped: false },
        [{ runtime: 'ollama', name: 'qwen3:latest' }],
      ),
      'http://127.0.0.1:11434',
    );

    await expect(provider.checkHealth()).resolves.toMatchObject({ ready: true });
  });

  it('buildCommand throws INTERNAL_LOGIC_ERROR - LocalProvider is executeDirect-only', () => {
    const provider = new LocalProvider(
      { name: 'fast', runtime: 'ollama', model: 'qwen3:4b' },
      new FakeRuntimeAdapter({ runtime: 'ollama', host: 'x', reachable: true, checkedAt: 'now' }),
      'http://127.0.0.1:11434',
    );
    try {
      provider.buildCommand();
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isDispatcherError(error)).toBe(true);
      if (isDispatcherError(error)) expect(error.code).toBe('INTERNAL_LOGIC_ERROR');
    }
  });

  it('parseOutcome throws INTERNAL_LOGIC_ERROR - LocalProvider is executeDirect-only', () => {
    const provider = new LocalProvider(
      { name: 'fast', runtime: 'ollama', model: 'qwen3:4b' },
      new FakeRuntimeAdapter({ runtime: 'ollama', host: 'x', reachable: true, checkedAt: 'now' }),
      'http://127.0.0.1:11434',
    );
    expect(() => provider.parseOutcome()).toThrow();
  });

  it('executeDirect builds a prompt from the task/context and returns a TaskResult with no filesChanged (raw completion API, no tool access)', async () => {
    const adapter = new FakeRuntimeAdapter(
      { runtime: 'ollama', host: 'x', reachable: true, checkedAt: 'now' },
      { text: 'This repo is an AI dispatcher CLI.', raw: {}, durationMs: 42, thinkingStripped: true },
    );
    const provider = new LocalProvider({ name: 'fast', runtime: 'ollama', model: 'qwen3:4b' }, adapter, 'http://127.0.0.1:11434');

    const task = buildTask({ command: 'ask' });
    const result = await provider.executeDirect(task, emptyContext, { sandbox: 'read-only', approval: 'never', timeoutMs: 30_000 }, 'exec-1');

    expect(result.status).toBe('success');
    expect(result.text).toBe('This repo is an AI dispatcher CLI.');
    expect(result.summary).toBe('This repo is an AI dispatcher CLI.');
    expect(result.filesChanged).toBeUndefined();
    expect(result.durationMs).toBe(42);
    expect(result.usage?.requests).toBe(1);

    expect(adapter.lastRequest?.model).toBe('qwen3:4b');
    expect(adapter.lastRequest?.host).toBe('http://127.0.0.1:11434');
    expect(adapter.lastRequest?.prompt).toContain('what does this repo do?');
    expect(adapter.lastRequest?.prompt).toContain('Operating Constraints'); // fixed prompt structure section
  });

  it('executeDirect propagates a runtime failure as a thrown error (not a TaskResult), matching the process-spawn failure pattern', async () => {
    const adapter = new FakeRuntimeAdapter({ runtime: 'ollama', host: 'x', reachable: true, checkedAt: 'now' }, () => {
      throw new Error('model not found');
    });
    const provider = new LocalProvider({ name: 'fast', runtime: 'ollama', model: 'does-not-exist' }, adapter, 'http://127.0.0.1:11434');

    await expect(
      provider.executeDirect(buildTask(), emptyContext, { sandbox: 'read-only', approval: 'never', timeoutMs: 30_000 }, 'exec-2'),
    ).rejects.toThrow('model not found');
  });

  it('requests structured JSON when a code-changing task is dispatched in read-only review mode', async () => {
    const adapter = new FakeRuntimeAdapter(
      { runtime: 'ollama', host: 'x', reachable: true, checkedAt: 'now' },
      { text: '{"verdict":"approve","findings":[]}', raw: {}, durationMs: 3, thinkingStripped: false },
    );
    const provider = new LocalProvider(
      { name: 'reviewer', runtime: 'ollama', model: 'qwen3:4b' },
      adapter,
      'http://127.0.0.1:11434',
    );

    const result = await provider.executeDirect(
      buildTask({ command: 'fix' }),
      emptyContext,
      { sandbox: 'read-only', approval: 'never', timeoutMs: 30_000 },
      'exec-review',
    );

    expect(result.status).toBe('success');
    expect(adapter.lastRequest?.jsonSchema).toMatchObject({ required: ['verdict', 'findings'] });
    expect(adapter.lastRequest?.maxOutputTokens).toBe(1_024);
  });
});
