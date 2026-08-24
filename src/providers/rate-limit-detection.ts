/**
 * Shared across every provider (claude, codex, and every local runtime adapter) so
 * a usage-limit/rate-limit failure is tagged the same way (`PROVIDER_RATE_LIMITED`)
 * regardless of which CLI or API produced it - previously each provider only ever
 * reported these as a generic failure (`PROVIDER_TASK_FAILED`/`PROCESS_EXIT_ERROR`/
 * `LOCAL_GENERATION_FAILED`), indistinguishable from a real bug, so the orchestrator
 * had no way to react differently (see circuit-breaker.ts's `tripOpen`).
 */

const RATE_LIMIT_TEXT_PATTERNS: RegExp[] = [
  /rate.?limit/i,
  /too many requests/i,
  /usage limit/i,
  /usage_limit/i,
  /quota exceeded/i,
  /resource_exhausted/i,
  /overloaded_error/i, // Anthropic API's error type for capacity/rate pressure
  /\b429\b/,
];

/** True when free-form provider error/output text carries a recognizable
 * rate-limit / usage-quota signal, across the different phrasing each CLI/API uses. */
export function isRateLimitText(...texts: Array<string | number | null | undefined>): boolean {
  const combined = texts.filter((t) => t !== null && t !== undefined).join(' ');
  if (!combined) return false;
  return RATE_LIMIT_TEXT_PATTERNS.some((re) => re.test(combined));
}

/** True when an HTTP status code is the standard rate-limit signal (429). */
export function isRateLimitStatus(status: number | string | null | undefined): boolean {
  return status === 429 || status === '429';
}
