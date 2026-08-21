import type { ProviderId, ProviderUsage } from '../models/provider.js';
import type { UsageStore } from './usage-store.js';

export const USAGE_WINDOWS_MS = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
} as const;

export type UsageWindowName = keyof typeof USAGE_WINDOWS_MS | 'all';

export class UsageTracker {
  constructor(private readonly store: UsageStore) {}

  async usageFor(provider: ProviderId, window: UsageWindowName, now: Date = new Date()): Promise<ProviderUsage> {
    const windowMs = window === 'all' ? Number.POSITIVE_INFINITY : USAGE_WINDOWS_MS[window];
    const records = await this.store.recentFor(provider, windowMs, now);

    const successes = records.filter((r) => r.outcome === 'success').length;
    const failures = records.filter((r) => r.outcome === 'failure').length;
    const timeouts = records.filter((r) => r.outcome === 'timeout').length;
    const totalDuration = records.reduce((sum, r) => sum + r.durationMs, 0);
    const inputTokens = sumDefined(records.map((r) => r.inputTokens));
    const outputTokens = sumDefined(records.map((r) => r.outputTokens));
    const costUsd = sumDefined(records.map((r) => r.costUsd));
    const last = records.at(-1);

    const windowStart =
      window === 'all'
        ? (records[0]?.startedAt ?? now.toISOString())
        : new Date(now.getTime() - windowMs).toISOString();

    return {
      provider,
      windowStart,
      windowEnd: now.toISOString(),
      requests: records.length,
      successes,
      failures,
      timeouts,
      actualInputTokens: inputTokens,
      actualOutputTokens: outputTokens,
      estimatedCostUsd: costUsd,
      averageDurationMs: records.length ? totalDuration / records.length : undefined,
      lastUsedAt: last?.finishedAt,
    };
  }
}

function sumDefined(values: Array<number | undefined>): number | undefined {
  const present = values.filter((v): v is number => v !== undefined);
  return present.length ? present.reduce((a, b) => a + b, 0) : undefined;
}
