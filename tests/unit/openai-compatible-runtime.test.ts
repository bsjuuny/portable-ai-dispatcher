import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleRuntimeAdapter } from '../../src/providers/local/openai-compatible-runtime.js';

const host = 'http://127.0.0.1:1234';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('OpenAICompatibleRuntimeAdapter', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('detects and lists models through /v1/models', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ data: [{ id: 'local-coder' }] })));
    const adapter = new OpenAICompatibleRuntimeAdapter();

    await expect(adapter.detect(host)).resolves.toMatchObject({ reachable: true, runtime: 'openai-compatible' });
    await expect(adapter.listModels(host)).resolves.toEqual([{ runtime: 'openai-compatible', name: 'local-coder' }]);
  });

  it('generates through chat completions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ choices: [{ message: { content: '<think>x</think>{"action":"finish"}' } }] })));
    const adapter = new OpenAICompatibleRuntimeAdapter();
    const result = await adapter.generate({
      profileId: 'local-compatible',
      runtime: 'openai-compatible',
      host,
      model: 'local-coder',
      prompt: 'act',
      timeoutMs: 1_000,
    });
    expect(result.text).toBe('{"action":"finish"}');
  });

  it('reports truncated:true when finish_reason is "length"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ choices: [{ message: { content: 'cut off mid' }, finish_reason: 'length' }] })));
    const adapter = new OpenAICompatibleRuntimeAdapter();
    const result = await adapter.generate({
      profileId: 'local-compatible',
      runtime: 'openai-compatible',
      host,
      model: 'local-coder',
      prompt: 'act',
      timeoutMs: 1_000,
    });
    expect(result.truncated).toBe(true);
  });

  it('falls back to legacy completions when chat completions is unsupported', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({}, 404))
      .mockResolvedValueOnce(response({ choices: [{ text: 'legacy result' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new OpenAICompatibleRuntimeAdapter();
    const result = await adapter.generate({
      profileId: 'local-compatible',
      runtime: 'openai-compatible',
      host,
      model: 'local-coder',
      prompt: 'act',
      timeoutMs: 1_000,
    });
    expect(result.text).toBe('legacy result');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('generate() maps HTTP 429 onto PROVIDER_RATE_LIMITED, non-retryable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ error: { message: 'rate limit exceeded' } }, 429)));
    const adapter = new OpenAICompatibleRuntimeAdapter();
    await expect(
      adapter.generate({ profileId: 'local-compatible', runtime: 'openai-compatible', host, model: 'local-coder', prompt: 'act', timeoutMs: 1_000 }),
    ).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMITED', retryable: false });
  });
});
