import { DispatcherError } from '../../models/error.js';

/**
 * The ONLY file in this codebase allowed to call the global `fetch()` (enforced by
 * tests/security/local-fetch-single-chokepoint.test.ts, the same static-scan
 * technique as tests/security/dist-static-scan.test.ts uses for process spawning).
 * Every local-runtime HTTP call (Ollama, llama.cpp) reaches the network exclusively
 * through this function.
 *
 * `assertLoopbackHost` rejects anything that isn't 127.0.0.1/localhost/::1 - a local
 * runtime host is only ever operator-configured (config/schema.ts), never task input,
 * but this closes the class of bug where a future change threads a runtime host
 * through from somewhere less trusted.
 */

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function assertLoopbackHost(host: string): URL {
  let url: URL;
  try {
    url = new URL(host);
  } catch (cause) {
    throw new DispatcherError({
      code: 'LOCAL_FETCH_TARGET_REJECTED',
      message: `Local runtime host is not a valid URL: "${host}"`,
      cause,
      retryable: false,
    });
  }
  if (!LOOPBACK_HOSTNAMES.has(url.hostname)) {
    throw new DispatcherError({
      code: 'LOCAL_FETCH_TARGET_REJECTED',
      message: `Local runtime host "${url.hostname}" is not loopback. Only 127.0.0.1/localhost/::1 are allowed.`,
      retryable: false,
    });
  }
  return url;
}

export interface LocalFetchOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  timeoutMs: number;
}

export interface LocalFetchResult {
  status: number;
  ok: boolean;
  text: string;
  json: unknown;
}

/** Parses the body as JSON when possible; `json` is `undefined` for non-JSON bodies (never throws on parse failure - callers decide what a bad shape means). */
export async function localFetch(host: string, path: string, opts: LocalFetchOptions): Promise<LocalFetchResult> {
  const base = assertLoopbackHost(host);
  const url = new URL(path, base);

  let response: Response;
  try {
    response = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: opts.body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (cause) {
    // Verified live (node -e against AbortSignal.timeout(1)): a timeout abort
    // rejects with `name: 'TimeoutError'`, distinct from a connection failure -
    // worth reporting under the existing PROCESS_TIMEOUT code rather than the
    // generic LOCAL_RUNTIME_UNREACHABLE, matching how a spawned-process timeout
    // is reported elsewhere.
    const isTimeout = cause instanceof Error && cause.name === 'TimeoutError';
    throw new DispatcherError({
      code: isTimeout ? 'PROCESS_TIMEOUT' : 'LOCAL_RUNTIME_UNREACHABLE',
      message: `Local runtime request failed: ${url.origin} - ${(cause as Error).message}`,
      cause,
      retryable: true,
    });
  }

  const text = await response.text();
  let json: unknown;
  try {
    json = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }

  return { status: response.status, ok: response.ok, text, json };
}

/**
 * Strips reasoning/"thinking" content from a raw model response before it is
 * returned to callers. Live-verified against the installed qwen3:4b (Ollama
 * 0.32.14): even with `"think": false` in the request, the response text still
 * contains a full reasoning preamble - but NOT wrapped in a matching `<think>...
 * </think>` pair as the model card implies. The actual observed shape has no
 * opening `<think>` tag at all, only an orphaned closing `</think>` right before
 * the real answer. Both shapes are handled here: a real closing tag, wherever it
 * appears, is not a formatting quirk to guess around - text after its LAST
 * occurrence is treated as the answer.
 */
export function stripThinking(raw: string): { text: string; thinkingStripped: boolean } {
  const openTag = '<think>';
  const closeTag = '</think>';

  if (raw.includes(openTag) && raw.includes(closeTag)) {
    const stripped = raw.replace(/<think>[\s\S]*?<\/think>/g, '');
    return { text: stripped.trim(), thinkingStripped: stripped.trim() !== raw.trim() };
  }

  const lastClose = raw.lastIndexOf(closeTag);
  if (lastClose !== -1) {
    return { text: raw.slice(lastClose + closeTag.length).trim(), thinkingStripped: true };
  }

  return { text: raw.trim(), thinkingStripped: false };
}
