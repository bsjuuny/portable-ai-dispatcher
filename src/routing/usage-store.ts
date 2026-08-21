import type { ProviderId } from '../models/provider.js';

export interface UsageRecord {
  provider: ProviderId;
  taskId: string;
  executionId: string;
  outcome: 'success' | 'failure' | 'timeout';
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

/**
 * Small port the routing layer depends on, so it never needs to know whether usage
 * history lives in SQLite (src/history/repository.ts, wired in at composition root)
 * or in memory (tests, and the default until history is wired up).
 */
export interface UsageStore {
  record(entry: UsageRecord): Promise<void>;
  recentFor(provider: ProviderId, windowMs: number, now?: Date): Promise<UsageRecord[]>;
}

export class InMemoryUsageStore implements UsageStore {
  private readonly entries: UsageRecord[] = [];

  async record(entry: UsageRecord): Promise<void> {
    this.entries.push(entry);
  }

  async recentFor(provider: ProviderId, windowMs: number, now: Date = new Date()): Promise<UsageRecord[]> {
    const cutoff = now.getTime() - windowMs;
    return this.entries.filter(
      (e) => e.provider === provider && new Date(e.finishedAt).getTime() >= cutoff,
    );
  }
}
