import { isDispatcherError } from '../models/error.js';

export interface RetryPolicyConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicyConfig = {
  maxRetries: 1,
  baseDelayMs: 1000,
  maxDelayMs: 15_000,
};

export function isRetryable(error: unknown): boolean {
  return isDispatcherError(error) && error.retryable;
}

/** Exponential backoff with +/-25% jitter, so repeated retries don't stampede in lockstep. */
export function computeBackoffMs(attempt: number, config: RetryPolicyConfig = DEFAULT_RETRY_POLICY): number {
  const exponential = config.baseDelayMs * 2 ** attempt;
  const capped = Math.min(exponential, config.maxDelayMs);
  const jitterFactor = 0.75 + Math.random() * 0.5;
  return Math.round(capped * jitterFactor);
}

export function shouldRetry(attempt: number, error: unknown, config: RetryPolicyConfig = DEFAULT_RETRY_POLICY): boolean {
  return attempt < config.maxRetries && isRetryable(error);
}
