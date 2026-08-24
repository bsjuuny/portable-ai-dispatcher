import type { AIProvider } from '../providers/types.js';
import type { ProviderHealth, ProviderUsage } from '../models/provider.js';
import type { TaskClassification } from '../models/classification.js';
import type { RoutingScore, RoutingScoreComponents } from '../models/routing.js';

export interface RoutingWeights {
  capability: number;
  usage: number;
  successRate: number;
  latency: number;
  availability: number;
  failurePenalty: number;
}

export const DEFAULT_ROUTING_WEIGHTS: RoutingWeights = {
  capability: 0.35,
  usage: 0.2,
  successRate: 0.2,
  latency: 0.1,
  availability: 0.1,
  failurePenalty: 0.05,
};

export interface ScoreInput {
  provider: AIProvider;
  health: ProviderHealth;
  usage1h: ProviderUsage;
  classification: TaskClassification;
  providerPreferenceScore?: number;
}

const MAX_REASONABLE_REQUESTS_PER_HOUR = 20;
const RECENT_FAILURE_LOOKBACK = 5;

/** Pure function: same inputs always produce the same score, no I/O. */
export function scoreProvider(input: ScoreInput, weights: RoutingWeights = DEFAULT_ROUTING_WEIGHTS): RoutingScore {
  if (!input.health.ready) {
    return {
      provider: input.provider.id,
      total: -Infinity,
      components: zeroComponents(),
      eligible: false,
      ineligibleReason: input.health.message ?? 'Provider is not ready.',
      ineligibleCode: input.health.reasonCode,
    };
  }
  if (input.health.rateLimited) {
    return {
      provider: input.provider.id,
      total: -Infinity,
      components: zeroComponents(),
      eligible: false,
      ineligibleReason: 'Provider is rate limited.',
      ineligibleCode: 'PROVIDER_RATE_LIMITED',
    };
  }

  const providerCapabilities = new Set(input.provider.capabilities());
  const required = input.classification.requiredCapabilities;
  const matched = required.filter((c) => providerCapabilities.has(c)).length;
  const capabilityFit = required.length ? matched / required.length : 0.5;
  if (required.length > 0 && matched === 0 && input.provider.dataResidency === 'local') {
    return {
      provider: input.provider.id,
      total: -Infinity,
      components: zeroComponents(),
      eligible: false,
      ineligibleReason: `Local provider lacks every required capability: ${required.join(', ')}.`,
    };
  }

  const usageCapacity = clamp01(
    1 - input.usage1h.requests / MAX_REASONABLE_REQUESTS_PER_HOUR,
  );

  const totalOutcomes = input.usage1h.successes + input.usage1h.failures + input.usage1h.timeouts;
  const successRate = totalOutcomes > 0 ? input.usage1h.successes / totalOutcomes : 0.7; // no history yet - neutral prior

  const availability = input.health.reachable === false ? 0 : input.health.reachable === true ? 1 : 0.5;

  const recentFailurePenalty = totalOutcomes > 0 && totalOutcomes <= RECENT_FAILURE_LOOKBACK
    ? clamp01((input.usage1h.failures + input.usage1h.timeouts) / totalOutcomes)
    : 0;

  const latencyPenalty = input.usage1h.averageDurationMs
    ? clamp01(input.usage1h.averageDurationMs / 120_000) // 2 minutes = full penalty
    : 0;

  const components: RoutingScoreComponents = {
    capability: capabilityFit * weights.capability,
    availability: availability * weights.availability,
    usageCapacity: usageCapacity * weights.usage,
    successRate: successRate * weights.successRate,
    preference: (input.providerPreferenceScore ?? 0.5) * 0, // reserved for future config-driven preference weight
    currentLoadPenalty: 0,
    recentFailurePenalty: recentFailurePenalty * weights.failurePenalty,
    rateLimitPenalty: 0,
    latencyPenalty: latencyPenalty * weights.latency,
  };

  const total =
    components.capability +
    components.availability +
    components.usageCapacity +
    components.successRate +
    components.preference -
    components.currentLoadPenalty -
    components.recentFailurePenalty -
    components.rateLimitPenalty -
    components.latencyPenalty;

  return {
    provider: input.provider.id,
    total,
    components,
    eligible: true,
  };
}

function zeroComponents(): RoutingScoreComponents {
  return {
    capability: 0,
    availability: 0,
    usageCapacity: 0,
    successRate: 0,
    preference: 0,
    currentLoadPenalty: 0,
    recentFailurePenalty: 0,
    rateLimitPenalty: 0,
    latencyPenalty: 0,
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
