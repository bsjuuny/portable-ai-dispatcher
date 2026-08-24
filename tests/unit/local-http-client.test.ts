import { describe, expect, it, vi, afterEach } from 'vitest';
import { assertLoopbackHost, localFetch, stripThinking } from '../../src/providers/local/local-http-client.js';
import { isDispatcherError } from '../../src/models/error.js';

describe('assertLoopbackHost', () => {
  it('accepts 127.0.0.1, localhost, and ::1', () => {
    expect(() => assertLoopbackHost('http://127.0.0.1:11434')).not.toThrow();
    expect(() => assertLoopbackHost('http://localhost:11434')).not.toThrow();
    expect(() => assertLoopbackHost('http://[::1]:11434')).not.toThrow();
  });

  it('rejects a non-loopback host', () => {
    try {
      assertLoopbackHost('http://evil.example.com:11434');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isDispatcherError(error)).toBe(true);
      if (isDispatcherError(error)) expect(error.code).toBe('LOCAL_FETCH_TARGET_REJECTED');
    }
  });

  it('rejects a malformed host string', () => {
    try {
      assertLoopbackHost('not a url');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isDispatcherError(error)).toBe(true);
      if (isDispatcherError(error)) expect(error.code).toBe('LOCAL_FETCH_TARGET_REJECTED');
    }
  });
});

describe('localFetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects a non-loopback host before ever calling fetch()', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(localFetch('http://evil.example.com', '/api/tags', { timeoutMs: 1000 })).rejects.toMatchObject({
      code: 'LOCAL_FETCH_TARGET_REJECTED',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('parses a successful JSON response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
    const result = await localFetch('http://127.0.0.1:11434', '/api/version', { timeoutMs: 1000 });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ ok: true });
  });

  it('surfaces a non-JSON body as text with json undefined', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not json', { status: 200 })),
    );
    const result = await localFetch('http://127.0.0.1:11434', '/api/version', { timeoutMs: 1000 });
    expect(result.text).toBe('not json');
    expect(result.json).toBeUndefined();
  });

  it('wraps a network failure as LOCAL_RUNTIME_UNREACHABLE', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    await expect(localFetch('http://127.0.0.1:11434', '/api/version', { timeoutMs: 1000 })).rejects.toMatchObject({
      code: 'LOCAL_RUNTIME_UNREACHABLE',
    });
  });

  it('reports a timeout abort as PROCESS_TIMEOUT, not the generic unreachable code', async () => {
    // Live-verified (docs/architecture.md): AbortSignal.timeout() rejects with
    // `name: 'TimeoutError'` - reproduced here without a real timer.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const err = new Error('The operation was aborted due to timeout');
        err.name = 'TimeoutError';
        throw err;
      }),
    );
    await expect(localFetch('http://127.0.0.1:11434', '/api/generate', { method: 'POST', timeoutMs: 1 })).rejects.toMatchObject({
      code: 'PROCESS_TIMEOUT',
    });
  });

  it('sends a JSON content-type header and body only when a body is provided', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    await localFetch('http://127.0.0.1:11434', '/api/generate', { method: 'POST', timeoutMs: 1000, body: { model: 'x' } });
    const init = (fetchSpy.mock.calls[0] as unknown as Parameters<typeof fetch>)[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ model: 'x' }));
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });
});

describe('stripThinking', () => {
  it('leaves plain text with no thinking markers untouched', () => {
    const result = stripThinking('just the answer');
    expect(result.text).toBe('just the answer');
    expect(result.thinkingStripped).toBe(false);
  });

  it('strips a balanced <think>...</think> block', () => {
    const result = stripThinking('<think>reasoning here</think>\n\nthe real answer');
    expect(result.text).toBe('the real answer');
    expect(result.thinkingStripped).toBe(true);
  });

  it('strips reasoning content up to an orphaned closing </think> tag with no opening tag - the real shape observed live from qwen3:4b via Ollama 0.32.14 even with "think": false', () => {
    const raw = 'Hmm, the user wants OK.\nOkay, response is ready: OK.\n</think>\n\nOK';
    const result = stripThinking(raw);
    expect(result.text).toBe('OK');
    expect(result.thinkingStripped).toBe(true);
  });

  it('handles multiple balanced blocks', () => {
    const result = stripThinking('<think>a</think>keep1<think>b</think>keep2');
    expect(result.text).toBe('keep1keep2');
    expect(result.thinkingStripped).toBe(true);
  });
});
