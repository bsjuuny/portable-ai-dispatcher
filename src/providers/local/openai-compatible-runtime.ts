import type {
  LocalGenerationRequest,
  LocalGenerationResult,
  LocalModelInfo,
  LocalRuntimeAdapter,
  LocalRuntimeStatus,
} from '../../models/local.js';
import { DispatcherError } from '../../models/error.js';
import { localFetch, stripThinking } from './local-http-client.js';
import { isRateLimitStatus, isRateLimitText } from '../rate-limit-detection.js';

interface ModelsResponse {
  data?: Array<{ id?: string }>;
}

interface CompletionResponse {
  choices?: Array<{
    message?: { content?: string };
    text?: string;
    finish_reason?: string;
  }>;
  error?: { message?: string } | string;
}

/**
 * Generic adapter for local servers exposing the de-facto OpenAI API, including
 * LM Studio, vLLM, LocalAI, text-generation-webui and compatible gateways.
 * Only loopback hosts pass localFetch(), so "compatible" never widens egress.
 */
export class OpenAICompatibleRuntimeAdapter implements LocalRuntimeAdapter {
  readonly kind = 'openai-compatible' as const;

  async detect(host: string, opts: { timeoutMs?: number } = {}): Promise<LocalRuntimeStatus> {
    const checkedAt = new Date().toISOString();
    try {
      const result = await localFetch(host, '/v1/models', { timeoutMs: opts.timeoutMs ?? 5_000 });
      const models = parseModels(result.json);
      return result.ok
        ? { runtime: this.kind, host, reachable: true, checkedAt, version: `OpenAI-compatible (${models.length} model(s))` }
        : { runtime: this.kind, host, reachable: false, checkedAt, message: `HTTP ${result.status}` };
    } catch (cause) {
      return {
        runtime: this.kind,
        host,
        reachable: false,
        checkedAt,
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }
  }

  async listModels(host: string, opts: { timeoutMs?: number } = {}): Promise<LocalModelInfo[]> {
    const result = await localFetch(host, '/v1/models', { timeoutMs: opts.timeoutMs ?? 5_000 });
    if (!result.ok) {
      throw new DispatcherError({
        code: 'LOCAL_RUNTIME_UNREACHABLE',
        message: `OpenAI-compatible /v1/models returned HTTP ${result.status}`,
        retryable: true,
      });
    }
    return parseModels(result.json).map((name) => ({ runtime: this.kind, name }));
  }

  async generate(request: LocalGenerationRequest): Promise<LocalGenerationResult> {
    const startedAt = Date.now();
    const chat = await localFetch(request.host, '/v1/chat/completions', {
      method: 'POST',
      timeoutMs: request.timeoutMs,
      body: {
        model: request.model,
        messages: [{ role: 'user', content: request.prompt }],
        temperature: 0,
        ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
        ...(request.jsonSchema ? { response_format: { type: 'json_object' } } : {}),
        stream: false,
      },
    });

    let result = chat;
    let body = chat.json as CompletionResponse | undefined;
    let text = body?.choices?.[0]?.message?.content;

    // Some older compatible servers expose only /v1/completions. Fall back only
    // for an unsupported chat endpoint, not for model/auth/server errors.
    if (chat.status === 404 || chat.status === 405) {
      result = await localFetch(request.host, '/v1/completions', {
        method: 'POST',
        timeoutMs: request.timeoutMs,
        body: {
          model: request.model,
          prompt: request.prompt,
          temperature: 0,
          stream: false,
          ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
          ...(request.jsonSchema ? { response_format: { type: 'json_object' } } : {}),
        },
      });
      body = result.json as CompletionResponse | undefined;
      text = body?.choices?.[0]?.text;
    }

    if (!result.ok || typeof text !== 'string') {
      const error = typeof body?.error === 'string' ? body.error : body?.error?.message;
      const message = error ?? `OpenAI-compatible completion returned HTTP ${result.status}`;
      const rateLimited = isRateLimitStatus(result.status) || isRateLimitText(message);
      throw new DispatcherError({
        code: rateLimited ? 'PROVIDER_RATE_LIMITED' : result.status === 404 ? 'LOCAL_MODEL_NOT_FOUND' : 'LOCAL_GENERATION_FAILED',
        message,
        retryable: rateLimited ? false : result.status !== 404,
      });
    }

    const stripped = stripThinking(text);
    return {
      text: stripped.text,
      raw: body,
      durationMs: Date.now() - startedAt,
      thinkingStripped: stripped.thinkingStripped,
      truncated: body?.choices?.[0]?.finish_reason === 'length',
    };
  }
}

function parseModels(value: unknown): string[] {
  const body = value as ModelsResponse | undefined;
  return (body?.data ?? [])
    .map((model) => model.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}
