import { describe, expect, it } from 'vitest';
import { UsageTracker } from '../../src/routing/usage-tracker.js';
import { InMemoryUsageStore } from '../../src/routing/usage-store.js';

describe('UsageTracker', () => {
  it('returns zeroed usage for a provider with no recorded activity', async () => {
    const tracker = new UsageTracker(new InMemoryUsageStore());
    const usage = await tracker.usageFor('claude', '1h');
    expect(usage.requests).toBe(0);
    expect(usage.successes).toBe(0);
    expect(usage.averageDurationMs).toBeUndefined();
  });

  it('aggregates successes/failures/timeouts correctly', async () => {
    const store = new InMemoryUsageStore();
    const now = new Date('2026-01-01T12:00:00Z');
    await store.record({ provider: 'claude', taskId: 't1', executionId: 'e1', outcome: 'success', startedAt: now.toISOString(), finishedAt: now.toISOString(), durationMs: 1000 });
    await store.record({ provider: 'claude', taskId: 't2', executionId: 'e2', outcome: 'failure', startedAt: now.toISOString(), finishedAt: now.toISOString(), durationMs: 2000 });
    await store.record({ provider: 'claude', taskId: 't3', executionId: 'e3', outcome: 'timeout', startedAt: now.toISOString(), finishedAt: now.toISOString(), durationMs: 3000 });

    const tracker = new UsageTracker(store);
    const usage = await tracker.usageFor('claude', '1h', now);
    expect(usage.requests).toBe(3);
    expect(usage.successes).toBe(1);
    expect(usage.failures).toBe(1);
    expect(usage.timeouts).toBe(1);
    expect(usage.averageDurationMs).toBe(2000);
  });

  it('excludes entries outside the requested window', async () => {
    const store = new InMemoryUsageStore();
    const now = new Date('2026-01-01T12:00:00Z');
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    await store.record({ provider: 'claude', taskId: 't1', executionId: 'e1', outcome: 'success', startedAt: twoHoursAgo.toISOString(), finishedAt: twoHoursAgo.toISOString(), durationMs: 1000 });

    const tracker = new UsageTracker(store);
    const usage1h = await tracker.usageFor('claude', '1h', now);
    const usage24h = await tracker.usageFor('claude', '24h', now);
    expect(usage1h.requests).toBe(0);
    expect(usage24h.requests).toBe(1);
  });

  it('does not mix usage between different providers', async () => {
    const store = new InMemoryUsageStore();
    const now = new Date();
    await store.record({ provider: 'claude', taskId: 't1', executionId: 'e1', outcome: 'success', startedAt: now.toISOString(), finishedAt: now.toISOString(), durationMs: 1000 });
    await store.record({ provider: 'codex', taskId: 't2', executionId: 'e2', outcome: 'success', startedAt: now.toISOString(), finishedAt: now.toISOString(), durationMs: 1000 });

    const tracker = new UsageTracker(store);
    expect((await tracker.usageFor('claude', '1h', now)).requests).toBe(1);
    expect((await tracker.usageFor('codex', '1h', now)).requests).toBe(1);
  });

  it('sums token/cost fields only from entries that actually reported them', async () => {
    const store = new InMemoryUsageStore();
    const now = new Date();
    await store.record({ provider: 'claude', taskId: 't1', executionId: 'e1', outcome: 'success', startedAt: now.toISOString(), finishedAt: now.toISOString(), durationMs: 1000, inputTokens: 100, costUsd: 0.01 });
    await store.record({ provider: 'claude', taskId: 't2', executionId: 'e2', outcome: 'success', startedAt: now.toISOString(), finishedAt: now.toISOString(), durationMs: 1000 });

    const usage = await new UsageTracker(store).usageFor('claude', '1h', now);
    expect(usage.actualInputTokens).toBe(100);
    expect(usage.estimatedCostUsd).toBeCloseTo(0.01, 5);
  });
});
