import { describe, expect, it } from 'vitest';
import { OllamaRuntimeAdapter } from '../../src/providers/local/ollama-runtime.js';

const OLLAMA_HOST = 'http://127.0.0.1:11434';
const adapter = new OllamaRuntimeAdapter();

/**
 * Real, unmocked HTTP calls against an actually-running Ollama instance (spec
 * section 54's "real CLI verification" requirement extended to local runtimes -
 * confirmed live this session: Ollama 0.32.14 on 127.0.0.1:11434 with 3 real
 * models installed). Same it.skipIf(!reachable) pattern and same collection-time
 * top-level-await gotcha as tests/contract/provider-health.test.ts - the detect()
 * result is awaited before `describe` runs, not inside a beforeAll.
 */
const detected = await adapter.detect(OLLAMA_HOST, { timeoutMs: 5000 }).catch(() => null);
const ollamaReachable = detected?.reachable === true;
const liveGenerationRequested = process.env['AI_DISPATCHER_LIVE_LOCAL_GENERATION'] === '1';

describe('OllamaRuntimeAdapter (real HTTP calls, no mocking)', () => {
  it.skipIf(!ollamaReachable)('detect() reports a real version string', async () => {
    const status = await adapter.detect(OLLAMA_HOST);
    expect(status.reachable).toBe(true);
    expect(status.version).toBeTruthy();
  });

  it.skipIf(!ollamaReachable)('listModels() returns at least one real installed model with parameter/quantization info', async () => {
    const models = await adapter.listModels(OLLAMA_HOST);
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      expect(model.name).toBeTruthy();
      expect(model.runtime).toBe('ollama');
    }
  });

  it.skipIf(!ollamaReachable || !liveGenerationRequested)('generate() performs a real completion and strips the reasoning preamble down to the actual answer', async () => {
    const models = await adapter.listModels(OLLAMA_HOST);
    const model = models[0];
    if (!model) return;

    const result = await adapter.generate({
      profileId: 'local-contract-test',
      runtime: 'ollama',
      host: OLLAMA_HOST,
      model: model.name,
      prompt: 'Reply with exactly one word: OK',
      timeoutMs: 60_000,
    });

    expect(result.text.length).toBeGreaterThan(0);
    // Whatever the model actually said, no raw <think> markup should survive into
    // the returned text - that is the entire point of stripThinking().
    expect(result.text).not.toContain('<think>');
    expect(result.text).not.toContain('</think>');
  }, 90_000);

  it.skipIf(!ollamaReachable)('generate() against a model that does not exist throws LOCAL_MODEL_NOT_FOUND', async () => {
    await expect(
      adapter.generate({
        profileId: 'local-contract-test',
        runtime: 'ollama',
        host: OLLAMA_HOST,
        model: 'this-model-does-not-exist:latest',
        prompt: 'hi',
        timeoutMs: 15_000,
      }),
    ).rejects.toMatchObject({ code: 'LOCAL_MODEL_NOT_FOUND' });
  });

  if (!ollamaReachable) {
    it('Ollama is not reachable on 127.0.0.1:11434 - the tests above were skipped, not silently passed', () => {
      expect(ollamaReachable).toBe(false);
    });
  }
});
