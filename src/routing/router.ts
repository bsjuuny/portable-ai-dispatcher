import type { ProviderRegistry } from '../providers/types.js';
import type { UsageTracker } from './usage-tracker.js';
import type { TaskClassification } from '../models/classification.js';
import type { RoutingDecision, RoutingScore } from '../models/routing.js';
import type { ProviderId } from '../models/provider.js';
import { DispatcherError } from '../models/error.js';
import { DEFAULT_ROUTING_WEIGHTS, scoreProvider, type RoutingWeights } from './scorer.js';

export interface RouteOptions {
  taskId: string;
  classification: TaskClassification;
  forcedProvider?: ProviderId;
  weights?: RoutingWeights;
}

export async function selectProvider(
  registry: ProviderRegistry,
  usageTracker: UsageTracker,
  options: RouteOptions,
): Promise<RoutingDecision> {
  const providers = options.forcedProvider
    ? [registry.get(options.forcedProvider)]
    : registry.list();

  const scores = await Promise.all(
    providers.map(async (provider) => {
      const [health, usage1h] = await Promise.all([
        provider.checkHealth(),
        usageTracker.usageFor(provider.id, '1h'),
      ]);
      return scoreProvider(
        { provider, health, usage1h, classification: options.classification },
        options.weights ?? DEFAULT_ROUTING_WEIGHTS,
      );
    }),
  );

  const eligible = scores.filter((s) => s.eligible);
  if (eligible.length === 0) {
    throw new DispatcherError({
      code: 'NO_AVAILABLE_PROVIDER',
      message: `No eligible provider for task. Reasons: ${scores
        .map((s) => `${s.provider}: ${s.ineligibleReason ?? 'unknown'}`)
        .join('; ')}`,
      taskId: options.taskId,
      retryable: false,
    });
  }

  const selected = eligible.sort((a, b) => b.total - a.total)[0];
  if (!selected) {
    throw new DispatcherError({
      code: 'NO_AVAILABLE_PROVIDER',
      message: 'No eligible provider for task.',
      taskId: options.taskId,
      retryable: false,
    });
  }

  return {
    taskId: options.taskId,
    scores,
    selected: selected.provider,
    reasons: buildReasons(selected),
    decidedAt: new Date().toISOString(),
  };
}

function buildReasons(score: RoutingScore): string[] {
  const c = score.components;
  return [
    `capability fit: +${c.capability.toFixed(3)}`,
    `availability: +${c.availability.toFixed(3)}`,
    `usage capacity: +${c.usageCapacity.toFixed(3)}`,
    `success rate: +${c.successRate.toFixed(3)}`,
    `latency penalty: -${c.latencyPenalty.toFixed(3)}`,
    `recent failure penalty: -${c.recentFailurePenalty.toFixed(3)}`,
    `total: ${score.total.toFixed(3)}`,
  ];
}
