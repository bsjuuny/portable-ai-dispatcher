import type { LocalGenerationRequest, LocalGenerationResult, LocalModelInfo, LocalRuntimeAdapter, LocalRuntimeStatus } from '../../models/local.js';
import { DispatcherError } from '../../models/error.js';
import { localFetch, stripThinking } from './local-http-client.js';
import { isRateLimitStatus, isRateLimitText } from '../rate-limit-detection.js';

/**
 * UNVERIFIED - llama.cpp's `llama-server` is not installed on the machine this
 * increment was built on (`where llama-server`/`llama-cli` both failed - see
 * docs/architecture.md). This adapter is written from llama.cpp's published
 * `server` README (GET /health, GET /v1/models, POST /completion returning
 * `{content: string, ...}`) and has never been exercised against a real process.
 * `config.local.runtimes.llamacpp.enabled` therefore defaults to `false` - an
 * operator must explicitly opt in after confirming it actually works against
 * their own llama-server build.
 */

interface LlamaCppHealthResponse {
  status?: string;
}

interface LlamaCppModelsResponse {
  data?: Array<{ id: string }>;
}

interface LlamaCppCompletionResponse {
  content?: string;
  error?: { message?: string } | string;
  /** "limit" when generation was cut off by n_predict/max_tokens rather than
   * finishing naturally - live-verified against a real llama-server. A schema-
   * constrained action response cut off mid-JSON is not valid JSON. */
  stop_type?: string;
}

interface LlamaCppChatResponse {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  error?: { message?: string } | string;
}

export class LlamaCppRuntimeAdapter implements LocalRuntimeAdapter {
  readonly kind = 'llamacpp' as const;

  async detect(host: string, opts: { timeoutMs?: number } = {}): Promise<LocalRuntimeStatus> {
    const checkedAt = new Date().toISOString();
    const timeoutMs = opts.timeoutMs ?? 5_000;

    try {
      const result = await localFetch(host, '/health', { timeoutMs });
      if (!result.ok) {
        return { runtime: 'llamacpp', host, reachable: false, checkedAt, message: `HTTP ${result.status} (unverified adapter)` };
      }
      const body = result.json as LlamaCppHealthResponse | undefined;
      return { runtime: 'llamacpp', host, reachable: body?.status === 'ok', checkedAt, message: 'unverified adapter - no real llama.cpp server tested during implementation' };
    } catch (cause) {
      const message = cause instanceof DispatcherError ? cause.message : (cause as Error).message;
      return { runtime: 'llamacpp', host, reachable: false, checkedAt, message };
    }
  }

  async listModels(host: string, opts: { timeoutMs?: number } = {}): Promise<LocalModelInfo[]> {
    const timeoutMs = opts.timeoutMs ?? 5_000;
    const result = await localFetch(host, '/v1/models', { timeoutMs });
    if (!result.ok) {
      throw new DispatcherError({
        code: 'LOCAL_RUNTIME_UNREACHABLE',
        message: `llama.cpp /v1/models returned HTTP ${result.status} (unverified adapter)`,
        retryable: true,
      });
    }
    const body = (result.json as LlamaCppModelsResponse | undefined) ?? {};
    return (body.data ?? []).map((m) => ({ runtime: 'llamacpp' as const, name: m.id }));
  }

  async generate(request: LocalGenerationRequest): Promise<LocalGenerationResult> {
    const startedAt = Date.now();
    // Qwen GGUF models carry a chat template. Using llama-server's OpenAI chat
    // endpoint lets the server apply it; raw /completion would merely continue
    // our numbered prompt instead of answering it.
    if (!request.jsonSchema) {
      const chat = await localFetch(request.host, '/v1/chat/completions', {
        method: 'POST',
        timeoutMs: request.timeoutMs,
        body: {
          model: request.model,
          messages: [{ role: 'user', content: request.prompt }],
          temperature: 0,
          max_tokens: request.maxOutputTokens ?? 256,
          stream: false,
        },
      });
      const chatBody = chat.json as LlamaCppChatResponse | undefined;
      const chatText = chatBody?.choices?.[0]?.message?.content;
      if (chat.ok && typeof chatText === 'string') {
        const stripped = stripThinking(chatText);
        return {
          text: stripped.text,
          raw: chatBody,
          durationMs: Date.now() - startedAt,
          thinkingStripped: stripped.thinkingStripped,
          truncated: chatBody?.choices?.[0]?.finish_reason === 'length',
        };
      }
      if (chat.status !== 404 && chat.status !== 405) {
        const message = typeof chatBody?.error === 'string' ? chatBody.error : chatBody?.error?.message ?? `llama.cpp chat completion returned HTTP ${chat.status}`;
        const rateLimited = isRateLimitStatus(chat.status) || isRateLimitText(message);
        throw new DispatcherError({
          code: rateLimited ? 'PROVIDER_RATE_LIMITED' : 'LOCAL_GENERATION_FAILED',
          message,
          retryable: !rateLimited,
        });
      }
    }

    const result = await localFetch(request.host, '/completion', {
      method: 'POST',
      timeoutMs: request.timeoutMs,
      body: {
        prompt: request.prompt,
        // Unlike the chat/completions branch above, this path (used for every
        // schema-constrained call, i.e. every local-coding-agent turn) had no
        // sampling params at all, so llama-server fell back to its own default
        // temperature (0.8 - confirmed live against a real server). At that
        // temperature the same tool-call prompt produces working code on one
        // attempt and a lint-failing variant on the next; deterministic decoding
        // is what this structured, single-best-answer JSON action actually wants.
        temperature: 0,
        ...(request.maxOutputTokens ? { n_predict: request.maxOutputTokens } : {}),
        // json_schema must be the raw schema object, not a JSON-encoded string of it -
        // localFetch already serializes this whole body once. Stringifying it here
        // double-encodes it, so llama-server receives a plain string where it expects
        // an object and fails with "JSON schema conversion failed: Unrecognized
        // schema". Live-reproduced and fixed (2026-08-23) against a real llama-server.
        ...(request.jsonSchema ? { json_schema: request.jsonSchema } : {}),
      },
    });
    const durationMs = Date.now() - startedAt;

    const body = result.json as LlamaCppCompletionResponse | undefined;
    if (!result.ok || !body || typeof body.content !== 'string') {
      const message = typeof body?.error === 'string' ? body.error : body?.error?.message ?? `llama.cpp /completion returned HTTP ${result.status} (unverified adapter)`;
      const rateLimited = isRateLimitStatus(result.status) || isRateLimitText(message);
      throw new DispatcherError({
        code: rateLimited ? 'PROVIDER_RATE_LIMITED' : 'LOCAL_GENERATION_FAILED',
        message,
        retryable: !rateLimited,
      });
    }

    const { text, thinkingStripped } = stripThinking(body.content);
    return { text, raw: body, durationMs, thinkingStripped, truncated: body.stop_type === 'limit' };
  }
}
