import type { RoutingDecision } from '../models/routing.js';
import type { ProviderId } from '../models/provider.js';
import { DispatcherError } from '../models/error.js';
import type { CircuitBreaker } from './circuit-breaker.js';

/**
 * Picks the next-best eligible provider from an already-computed RoutingDecision,
 * skipping providers already attempted and any whose circuit is currently open.
 * Does not re-score - the original decision's ranking still holds; fallback is about
 * "who's next in that ranking," not "recompute everything."
 */
export function nextFallbackProvider(
  decision: RoutingDecision,
  attemptedProviders: ProviderId[],
  circuitBreaker: CircuitBreaker,
): ProviderId | undefined {
  const ranked = [...decision.scores]
    .filter((s) => s.eligible)
    .sort((a, b) => b.total - a.total);

  for (const score of ranked) {
    if (attemptedProviders.includes(score.provider)) continue;
    if (!circuitBreaker.canAttempt(score.provider)) continue;
    return score.provider;
  }
  return undefined;
}

export function assertProvidersNotExhausted(
  decision: RoutingDecision,
  attemptedProviders: ProviderId[],
  taskId: string,
): void {
  const eligibleCount = decision.scores.filter((s) => s.eligible).length;
  if (attemptedProviders.length >= eligibleCount) {
    throw new DispatcherError({
      code: 'NO_AVAILABLE_PROVIDER',
      message: `All ${eligibleCount} eligible provider(s) exhausted after ${attemptedProviders.length} attempt(s): ${attemptedProviders.join(', ')}`,
      taskId,
      retryable: false,
    });
  }
}
