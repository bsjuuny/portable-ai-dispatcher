import type { LocalGenerationRequest, LocalGenerationResult, LocalModelInfo, LocalRuntimeAdapter, LocalRuntimeStatus } from '../../models/local.js';
import { DispatcherError } from '../../models/error.js';
import { localFetch, stripThinking } from './local-http-client.js';
import { isRateLimitStatus, isRateLimitText } from '../rate-limit-detection.js';

/**
 * Live-verified against Ollama 0.32.14 running on 127.0.0.1:11434 (docs/architecture.md).
 * Endpoints used: GET /api/version, GET /api/tags, POST /api/generate.
 */

interface OllamaVersionResponse {
  version?: string;
}

interface OllamaTagsResponse {
  models?: Array<{
    name: string;
    digest?: string;
    size?: number;
    details?: {
      family?: string;
      parameter_size?: string;
      quantization_level?: string;
      context_length?: number;
    };
  }>;
}

interface OllamaGenerateResponse {
  response?: string;
  error?: string;
  done?: boolean;
  done_reason?: string;
}

export class OllamaRuntimeAdapter implements LocalRuntimeAdapter {
  readonly kind = 'ollama' as const;

  async detect(host: string, opts: { timeoutMs?: number } = {}): Promise<LocalRuntimeStatus> {
    const checkedAt = new Date().toISOString();
    const timeoutMs = opts.timeoutMs ?? 5_000;

    try {
      const result = await localFetch(host, '/api/version', { timeoutMs });
      if (!result.ok) {
        return { runtime: 'ollama', host, reachable: false, checkedAt, message: `HTTP ${result.status}` };
      }
      const body = result.json as OllamaVersionResponse | undefined;
      return { runtime: 'ollama', host, reachable: true, version: body?.version, checkedAt };
    } catch (cause) {
      const message = cause instanceof DispatcherError ? cause.message : (cause as Error).message;
      return { runtime: 'ollama', host, reachable: false, checkedAt, message };
    }
  }

  async listModels(host: string, opts: { timeoutMs?: number } = {}): Promise<LocalModelInfo[]> {
    const timeoutMs = opts.timeoutMs ?? 5_000;
    const result = await localFetch(host, '/api/tags', { timeoutMs });
    if (!result.ok) {
      throw new DispatcherError({
        code: 'LOCAL_RUNTIME_UNREACHABLE',
        message: `Ollama /api/tags returned HTTP ${result.status}`,
        retryable: true,
      });
    }
    const body = (result.json as OllamaTagsResponse | undefined) ?? {};
    return (body.models ?? []).map((m) => ({
      runtime: 'ollama' as const,
      name: m.name,
      digest: m.digest,
      family: m.details?.family,
      parameterSize: m.details?.parameter_size,
      quantizationLevel: m.details?.quantization_level,
      contextLength: m.details?.context_length,
      sizeBytes: m.size,
    }));
  }

  async generate(request: LocalGenerationRequest): Promise<LocalGenerationResult> {
    const startedAt = Date.now();
    const result = await localFetch(request.host, '/api/generate', {
      method: 'POST',
      timeoutMs: request.timeoutMs,
      body: {
        model: request.model,
        prompt: request.prompt,
        stream: false,
        think: false,
        ...(request.jsonSchema ? { format: request.jsonSchema } : {}),
        // temperature must not be conditional on maxOutputTokens being set - it
        // previously only applied when maxOutputTokens was truthy, silently falling
        // back to Ollama's own (non-zero) default temperature otherwise.
        options: { temperature: 0, ...(request.maxOutputTokens ? { num_predict: request.maxOutputTokens } : {}) },
      },
    });
    const durationMs = Date.now() - startedAt;

    if (!result.ok) {
      const body = result.json as OllamaGenerateResponse | undefined;
      const message = body?.error ?? `Ollama /api/generate returned HTTP ${result.status}`;
      const rateLimited = isRateLimitStatus(result.status) || isRateLimitText(message);
      throw new DispatcherError({
        code: rateLimited ? 'PROVIDER_RATE_LIMITED' : result.status === 404 ? 'LOCAL_MODEL_NOT_FOUND' : 'LOCAL_GENERATION_FAILED',
        message,
        retryable: rateLimited ? false : result.status !== 404,
      });
    }

    const body = result.json as OllamaGenerateResponse | undefined;
    if (!body || typeof body.response !== 'string') {
      throw new DispatcherError({
        code: 'LOCAL_GENERATION_FAILED',
        message: 'Ollama /api/generate returned no usable "response" field.',
        retryable: true,
      });
    }

    const { text, thinkingStripped } = stripThinking(body.response);
    return { text, raw: body, durationMs, thinkingStripped, truncated: body.done_reason === 'length' };
  }
}
