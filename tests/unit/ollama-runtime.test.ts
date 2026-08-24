import { describe, expect, it, vi, afterEach } from 'vitest';
import { OllamaRuntimeAdapter } from '../../src/providers/local/ollama-runtime.js';

const HOST = 'http://127.0.0.1:11434';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('OllamaRuntimeAdapter (mocked HTTP - error paths not exercisable against the real live instance)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('detect() reports unreachable:false-shaped status without throwing when the HTTP call fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    const adapter = new OllamaRuntimeAdapter();
    const status = await adapter.detect(HOST);
    expect(status.reachable).toBe(false);
    expect(status.message).toBeTruthy();
  });

  it('detect() reports unreachable for a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));
    const adapter = new OllamaRuntimeAdapter();
    const status = await adapter.detect(HOST);
    expect(status.reachable).toBe(false);
    expect(status.message).toContain('500');
  });

  it('listModels() maps the real /api/tags shape (live-verified this session) onto LocalModelInfo', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          models: [
            {
              name: 'qwen3:4b',
              digest: 'abc123',
              size: 2497293931,
              details: { family: 'qwen3', parameter_size: '4.0B', quantization_level: 'Q4_K_M', context_length: 262144 },
            },
          ],
        }),
      ),
    );
    const adapter = new OllamaRuntimeAdapter();
    const models = await adapter.listModels(HOST);
    expect(models).toEqual([
      {
        runtime: 'ollama',
        name: 'qwen3:4b',
        digest: 'abc123',
        family: 'qwen3',
        parameterSize: '4.0B',
        quantizationLevel: 'Q4_K_M',
        contextLength: 262144,
        sizeBytes: 2497293931,
      },
    ]);
  });

  it('listModels() throws LOCAL_RUNTIME_UNREACHABLE on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
    const adapter = new OllamaRuntimeAdapter();
    await expect(adapter.listModels(HOST)).rejects.toMatchObject({ code: 'LOCAL_RUNTIME_UNREACHABLE' });
  });

  it('generate() reports truncated:true when done_reason is "length"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ response: 'cut off mid', done: true, done_reason: 'length' })));
    const adapter = new OllamaRuntimeAdapter();
    const result = await adapter.generate({ profileId: 'local-x', runtime: 'ollama', host: HOST, model: 'qwen3:4b', prompt: 'hi', timeoutMs: 1000 });
    expect(result.truncated).toBe(true);
  });

  it('generate() maps a real 404 "model not found" shape (live-verified this session) onto LOCAL_MODEL_NOT_FOUND', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: "model 'does-not-exist:latest' not found" }, 404)));
    const adapter = new OllamaRuntimeAdapter();
    await expect(
      adapter.generate({ profileId: 'local-x', runtime: 'ollama', host: HOST, model: 'does-not-exist:latest', prompt: 'hi', timeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: 'LOCAL_MODEL_NOT_FOUND', message: "model 'does-not-exist:latest' not found" });
  });

  it('generate() maps a non-404 failure onto LOCAL_GENERATION_FAILED, retryable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));
    const adapter = new OllamaRuntimeAdapter();
    await expect(
      adapter.generate({ profileId: 'local-x', runtime: 'ollama', host: HOST, model: 'qwen3:4b', prompt: 'hi', timeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: 'LOCAL_GENERATION_FAILED', retryable: true });
  });

  it('generate() maps HTTP 429 onto PROVIDER_RATE_LIMITED, non-retryable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'rate limit exceeded' }, 429)));
    const adapter = new OllamaRuntimeAdapter();
    await expect(
      adapter.generate({ profileId: 'local-x', runtime: 'ollama', host: HOST, model: 'qwen3:4b', prompt: 'hi', timeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMITED', retryable: false });
  });

  it('generate() detects a rate-limit signal from the error message even on a non-429 status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'usage limit reached for this account' }, 400)));
    const adapter = new OllamaRuntimeAdapter();
    await expect(
      adapter.generate({ profileId: 'local-x', runtime: 'ollama', host: HOST, model: 'qwen3:4b', prompt: 'hi', timeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMITED', retryable: false });
  });

  it('generate() throws LOCAL_GENERATION_FAILED when the response has no usable "response" field', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ done: true })));
    const adapter = new OllamaRuntimeAdapter();
    await expect(
      adapter.generate({ profileId: 'local-x', runtime: 'ollama', host: HOST, model: 'qwen3:4b', prompt: 'hi', timeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: 'LOCAL_GENERATION_FAILED' });
  });

  it('generate() sends stream:false and think:false in the request body', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ response: 'ok' }));
    vi.stubGlobal('fetch', fetchSpy);
    const adapter = new OllamaRuntimeAdapter();
    await adapter.generate({ profileId: 'local-x', runtime: 'ollama', host: HOST, model: 'qwen3:4b', prompt: 'hi', timeoutMs: 1000 });
    const init = (fetchSpy.mock.calls[0] as unknown as Parameters<typeof fetch>)[1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ model: 'qwen3:4b', prompt: 'hi', stream: false, think: false, options: { temperature: 0 } });
  });

  it('generate() always sends temperature:0, even without maxOutputTokens set', async () => {
    // Previously nested under maxOutputTokens's spread, so a call without it (e.g.
    // every ask/analyze request) silently fell back to Ollama's own non-zero
    // default temperature instead of the deterministic decoding structured local-
    // coding-agent JSON actions actually need.
    const fetchSpy = vi.fn(async () => jsonResponse({ response: 'ok' }));
    vi.stubGlobal('fetch', fetchSpy);
    const adapter = new OllamaRuntimeAdapter();
    await adapter.generate({ profileId: 'local-x', runtime: 'ollama', host: HOST, model: 'qwen3:4b', prompt: 'hi', timeoutMs: 1000, maxOutputTokens: 256 });
    const init = (fetchSpy.mock.calls[0] as unknown as Parameters<typeof fetch>)[1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.options).toEqual({ temperature: 0, num_predict: 256 });
  });
});
