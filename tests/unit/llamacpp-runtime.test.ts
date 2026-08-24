import { describe, expect, it, vi, afterEach } from 'vitest';
import { LlamaCppRuntimeAdapter } from '../../src/providers/local/llamacpp-runtime.js';

const HOST = 'http://127.0.0.1:8080';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/**
 * These unit tests cover the OpenAI-compatible chat path and native completion
 * fallback. A live llama-server check is covered separately in the portable-kit
 * workflow.
 */
describe('LlamaCppRuntimeAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('detect() reports reachable:true only when /health returns {status:"ok"}', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ status: 'ok' })));
    const adapter = new LlamaCppRuntimeAdapter();
    const status = await adapter.detect(HOST);
    expect(status.reachable).toBe(true);
    expect(status.message).toMatch(/unverified/i);
  });

  it('detect() reports reachable:false for any other health status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ status: 'loading' })));
    const adapter = new LlamaCppRuntimeAdapter();
    const status = await adapter.detect(HOST);
    expect(status.reachable).toBe(false);
  });

  it('detect() reports reachable:false without throwing on a network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    const adapter = new LlamaCppRuntimeAdapter();
    const status = await adapter.detect(HOST);
    expect(status.reachable).toBe(false);
  });

  it('listModels() maps the OpenAI-compatible /v1/models shape onto LocalModelInfo', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ object: 'list', data: [{ id: 'my-model.gguf' }] })));
    const adapter = new LlamaCppRuntimeAdapter();
    const models = await adapter.listModels(HOST);
    expect(models).toEqual([{ runtime: 'llamacpp', name: 'my-model.gguf' }]);
  });

  it('listModels() throws LOCAL_RUNTIME_UNREACHABLE on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
    const adapter = new LlamaCppRuntimeAdapter();
    await expect(adapter.listModels(HOST)).rejects.toMatchObject({ code: 'LOCAL_RUNTIME_UNREACHABLE' });
  });

  it('generate() maps the OpenAI chat response onto LocalGenerationResult and strips thinking markup', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ choices: [{ message: { content: '<think>reasoning</think>the answer' } }] })));
    const adapter = new LlamaCppRuntimeAdapter();
    const result = await adapter.generate({ profileId: 'local-x', runtime: 'llamacpp', host: HOST, model: 'm', prompt: 'hi', timeoutMs: 1000 });
    expect(result.text).toBe('the answer');
    expect(result.thinkingStripped).toBe(true);
  });

  it('generate() reports truncated:true when the chat endpoint stopped on finish_reason:"length"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'cut off mid' }, finish_reason: 'length' }] })));
    const adapter = new LlamaCppRuntimeAdapter();
    const result = await adapter.generate({ profileId: 'local-x', runtime: 'llamacpp', host: HOST, model: 'm', prompt: 'hi', timeoutMs: 1000 });
    expect(result.truncated).toBe(true);
  });

  it('generate() reports truncated:false when the chat endpoint stopped naturally', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] })));
    const adapter = new LlamaCppRuntimeAdapter();
    const result = await adapter.generate({ profileId: 'local-x', runtime: 'llamacpp', host: HOST, model: 'm', prompt: 'hi', timeoutMs: 1000 });
    expect(result.truncated).toBe(false);
  });

  it('generate() reports truncated:true on the /completion path when stop_type is "limit"', async () => {
    // A truncated schema-constrained response can still be syntactically valid
    // JSON (cut right after a closing brace) while the content inside it is an
    // incomplete file - this is what lets local-coding-agent catch that case
    // instead of writing broken content and only discovering it at lint/build.
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ content: '{"action":"finish"}', stop_type: 'limit' })));
    const adapter = new LlamaCppRuntimeAdapter();
    const result = await adapter.generate({ profileId: 'local-x', runtime: 'llamacpp', host: HOST, model: 'm', prompt: 'hi', timeoutMs: 1000, jsonSchema: { type: 'object' } });
    expect(result.truncated).toBe(true);
  });

  it('generate() throws LOCAL_GENERATION_FAILED when the response has no usable "content" field', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'something broke' }, 500)));
    const adapter = new LlamaCppRuntimeAdapter();
    await expect(
      adapter.generate({ profileId: 'local-x', runtime: 'llamacpp', host: HOST, model: 'm', prompt: 'hi', timeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: 'LOCAL_GENERATION_FAILED', message: 'something broke' });
  });

  it('generate() sends json_schema as the raw schema object, not a JSON-encoded string of it', async () => {
    // Live-reproduced against a real llama-server (2026-08-23): sending it as a
    // string produces the exact error `JSON schema conversion failed: Unrecognized
    // schema: "{...}"` because llama-server expects a nested object, not a string.
    const schema = { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] };
    const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
      const sentBody = JSON.parse(init.body as string);
      expect(sentBody.json_schema).toEqual(schema);
      return jsonResponse({ content: '{"action":"finish"}' });
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new LlamaCppRuntimeAdapter();
    await adapter.generate({ profileId: 'local-x', runtime: 'llamacpp', host: HOST, model: 'm', prompt: 'hi', timeoutMs: 1000, jsonSchema: schema });
    expect(fetchMock).toHaveBeenCalled();
  });

  it('generate() sends temperature:0 on the /completion (schema) path, not just /v1/chat/completions', async () => {
    // Live-reproduced (2026-08-23): this path had no sampling params at all, so
    // llama-server fell back to its own default temperature (0.8) - every local-
    // coding-agent tool-call action goes through this exact path (it always sets
    // jsonSchema), and that non-zero temperature made the same prompt sometimes
    // produce working code and sometimes produce a lint-failing variant.
    const fetchSpy = vi.fn(async () => jsonResponse({ content: '{"action":"finish"}' }));
    vi.stubGlobal('fetch', fetchSpy);
    const adapter = new LlamaCppRuntimeAdapter();
    await adapter.generate({ profileId: 'local-x', runtime: 'llamacpp', host: HOST, model: 'm', prompt: 'hi', timeoutMs: 1000, jsonSchema: { type: 'object' } });
    const init = (fetchSpy.mock.calls[0] as unknown as Parameters<typeof fetch>)[1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.temperature).toBe(0);
  });

  it('generate() maps HTTP 429 onto PROVIDER_RATE_LIMITED, non-retryable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'rate limited' }, 429)));
    const adapter = new LlamaCppRuntimeAdapter();
    await expect(
      adapter.generate({ profileId: 'local-x', runtime: 'llamacpp', host: HOST, model: 'm', prompt: 'hi', timeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMITED', retryable: false });
  });
});
