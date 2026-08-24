import { describe, expect, it } from 'vitest';
import { computeBackoffMs, isRetryable, shouldRetry } from '../../src/routing/retry-policy.js';
import { CircuitBreaker } from '../../src/routing/circuit-breaker.js';
import { nextFallbackProvider, assertProvidersNotExhausted } from '../../src/routing/fallback.js';
import { DispatcherError, isDispatcherError } from '../../src/models/error.js';
import type { RoutingDecision } from '../../src/models/routing.js';

describe('retry policy', () => {
  it('isRetryable reflects the error.retryable flag', () => {
    expect(isRetryable(new DispatcherError({ code: 'PROCESS_TIMEOUT', message: 'x', retryable: true }))).toBe(true);
    expect(isRetryable(new DispatcherError({ code: 'INVALID_TASK', message: 'x', retryable: false }))).toBe(false);
    expect(isRetryable(new Error('plain error'))).toBe(false);
  });

  it('shouldRetry respects maxRetries', () => {
    const retryableError = new DispatcherError({ code: 'PROCESS_TIMEOUT', message: 'x', retryable: true });
    const config = { maxRetries: 1, baseDelayMs: 10, maxDelayMs: 100 };
    expect(shouldRetry(0, retryableError, config)).toBe(true);
    expect(shouldRetry(1, retryableError, config)).toBe(false);
  });

  it('shouldRetry never retries a non-retryable error regardless of attempt count', () => {
    const nonRetryable = new DispatcherError({ code: 'INVALID_TASK', message: 'x', retryable: false });
    expect(shouldRetry(0, nonRetryable, { maxRetries: 5, baseDelayMs: 10, maxDelayMs: 100 })).toBe(false);
  });

  it('computeBackoffMs grows exponentially and stays within jitter bounds', () => {
    const config = { maxRetries: 5, baseDelayMs: 1000, maxDelayMs: 60_000 };
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const delay = computeBackoffMs(attempt, config);
      const expected = Math.min(1000 * 2 ** attempt, config.maxDelayMs);
      expect(delay).toBeGreaterThanOrEqual(expected * 0.7);
      expect(delay).toBeLessThanOrEqual(expected * 1.3);
    }
  });

  it('computeBackoffMs is capped at maxDelayMs', () => {
    const delay = computeBackoffMs(20, { maxRetries: 5, baseDelayMs: 1000, maxDelayMs: 5000 });
    expect(delay).toBeLessThanOrEqual(5000 * 1.3);
  });
});

describe('CircuitBreaker', () => {
  it('starts closed and allows attempts', () => {
    const cb = new CircuitBreaker();
    expect(cb.stateOf('claude')).toBe('closed');
    expect(cb.canAttempt('claude')).toBe(true);
  });

  it('does not evaluate opening until sampleSize calls have actually been made, even with 100% failures so far', () => {
    // With sampleSize:5, a 3rd failure out of only 3 total calls is not yet a full
    // window - resilience4j-style circuit breakers require a minimum sample before
    // judging, to avoid tripping on a tiny unrepresentative burst.
    const cb = new CircuitBreaker({ failureThreshold: 3, sampleSize: 5, cooldownMs: 60_000 });
    cb.recordFailure('claude');
    cb.recordFailure('claude');
    cb.recordFailure('claude');
    expect(cb.stateOf('claude')).toBe('closed');
  });

  it('opens once a full sampleSize window contains at least failureThreshold failures', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, sampleSize: 5, cooldownMs: 60_000 });
    cb.recordFailure('claude');
    cb.recordFailure('claude');
    cb.recordFailure('claude');
    cb.recordSuccess('claude');
    expect(cb.stateOf('claude')).toBe('closed'); // 4 calls made, window not full yet
    cb.recordFailure('claude');
    expect(cb.stateOf('claude')).toBe('open'); // 5 calls made, 4 of 5 failed >= threshold 3
    expect(cb.canAttempt('claude')).toBe(false);
  });

  it('stays closed when failures within a full window are below the threshold', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, sampleSize: 5, cooldownMs: 60_000 });
    cb.recordFailure('claude');
    cb.recordSuccess('claude');
    cb.recordFailure('claude');
    cb.recordSuccess('claude');
    cb.recordSuccess('claude');
    expect(cb.stateOf('claude')).toBe('closed'); // 5 calls made, only 2 failures - under threshold 3
  });

  it('transitions open -> half_open after cooldown, then closed on a successful trial', () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, sampleSize: 1, cooldownMs: 1000 });
    cb.recordFailure('codex');
    expect(cb.stateOf('codex')).toBe('open');

    const past = Date.now() - 2000;
    expect(cb.canAttempt('codex', past + 5000)).toBe(true); // cooldown elapsed relative to "now"
    cb.recordSuccess('codex');
    expect(cb.stateOf('codex')).toBe('closed');
  });

  it('a failed half_open trial re-opens the circuit', () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, sampleSize: 1, cooldownMs: 1000 });
    cb.recordFailure('codex');
    cb.canAttempt('codex', Date.now() + 5000); // force half_open
    cb.recordFailure('codex');
    expect(cb.stateOf('codex')).toBe('open');
  });

  it('tracks providers independently', () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, sampleSize: 1, cooldownMs: 60_000 });
    cb.recordFailure('claude');
    expect(cb.stateOf('claude')).toBe('open');
    expect(cb.stateOf('codex')).toBe('closed');
  });

  it('tripOpen forces the circuit open on a single call, bypassing the sliding-window threshold', () => {
    // A confirmed rate-limit response is 100% certain the provider is unusable
    // right now - unlike recordFailure, this must not wait for sampleSize calls.
    const cb = new CircuitBreaker({ failureThreshold: 4, sampleSize: 5, cooldownMs: 60_000 });
    expect(cb.stateOf('codex')).toBe('closed');
    cb.tripOpen('codex');
    expect(cb.stateOf('codex')).toBe('open');
    expect(cb.canAttempt('codex')).toBe(false);
  });

  it('tripOpen respects the same cooldown as a threshold-triggered open', () => {
    const cb = new CircuitBreaker({ failureThreshold: 4, sampleSize: 5, cooldownMs: 1000 });
    cb.tripOpen('codex', Date.now() - 2000);
    expect(cb.canAttempt('codex')).toBe(true); // cooldown elapsed -> half_open trial allowed
  });
});

function fakeDecision(): RoutingDecision {
  return {
    taskId: 't1',
    selected: 'claude',
    decidedAt: '',
    reasons: [],
    scores: [
      { provider: 'claude', total: 0.9, eligible: true, components: zeroComponents() },
      { provider: 'codex', total: 0.7, eligible: true, components: zeroComponents() },
    ],
  };
}
function zeroComponents() {
  return { capability: 0, availability: 0, usageCapacity: 0, successRate: 0, preference: 0, currentLoadPenalty: 0, recentFailurePenalty: 0, rateLimitPenalty: 0, latencyPenalty: 0 };
}

describe('fallback', () => {
  it('picks the next-highest-ranked eligible provider not yet attempted', () => {
    const decision = fakeDecision();
    const cb = new CircuitBreaker();
    const next = nextFallbackProvider(decision, ['claude'], cb);
    expect(next).toBe('codex');
  });

  it('skips a provider whose circuit is open', () => {
    const decision = fakeDecision();
    const cb = new CircuitBreaker({ failureThreshold: 1, sampleSize: 1, cooldownMs: 60_000 });
    cb.recordFailure('codex');
    const next = nextFallbackProvider(decision, ['claude'], cb);
    expect(next).toBeUndefined();
  });

  it('returns undefined when every eligible provider has been attempted', () => {
    const decision = fakeDecision();
    const cb = new CircuitBreaker();
    const next = nextFallbackProvider(decision, ['claude', 'codex'], cb);
    expect(next).toBeUndefined();
  });

  it('assertProvidersNotExhausted throws once every eligible provider has been tried', () => {
    const decision = fakeDecision();
    expect(() => assertProvidersNotExhausted(decision, ['claude'], 't1')).not.toThrow();
    try {
      assertProvidersNotExhausted(decision, ['claude', 'codex'], 't1');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isDispatcherError(error) && error.code === 'NO_AVAILABLE_PROVIDER').toBe(true);
    }
  });
});
