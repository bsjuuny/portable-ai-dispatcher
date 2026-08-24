import { describe, expect, it } from 'vitest';
import { scoreProvider, DEFAULT_ROUTING_WEIGHTS } from '../../src/routing/scorer.js';
import type { AIProvider } from '../../src/providers/types.js';
import type { ProviderHealth, ProviderUsage } from '../../src/models/provider.js';
import type { TaskClassification } from '../../src/models/classification.js';

function fakeProvider(id: 'claude' | 'codex', capabilities: string[]): AIProvider {
  return {
    id,
    capabilities: () => capabilities as never,
    checkHealth: async () => ({ provider: id, checkedAt: '', installed: true, authenticated: true, reachable: true, rateLimited: false, ready: true }),
    buildCommand: () => ({ file: id, args: [], cwd: '.', timeoutMs: 1000 }),
    parseOutcome: () => ({ taskId: 't', executionId: 'e', provider: id, status: 'success', durationMs: 0 }),
  };
}

function health(overrides: Partial<ProviderHealth> = {}): ProviderHealth {
  return { provider: 'claude', checkedAt: '', installed: true, authenticated: true, reachable: true, rateLimited: false, ready: true, ...overrides };
}

function usage(overrides: Partial<ProviderUsage> = {}): ProviderUsage {
  return { provider: 'claude', windowStart: '', windowEnd: '', requests: 0, successes: 0, failures: 0, timeouts: 0, ...overrides };
}

function classification(caps: string[]): TaskClassification {
  return { type: 'bugfix', confidence: 0.8, requiredCapabilities: caps as never, riskLevel: 'medium', estimatedComplexity: 'normal', signals: [] };
}

describe('scoreProvider', () => {
  it('marks a provider not ready as ineligible with -Infinity score', () => {
    const result = scoreProvider({
      provider: fakeProvider('claude', ['bugfix']),
      health: health({ ready: false, message: 'not authenticated' }),
      usage1h: usage(),
      classification: classification(['bugfix']),
    });
    expect(result.eligible).toBe(false);
    expect(result.total).toBe(-Infinity);
    expect(result.ineligibleReason).toBe('not authenticated');
  });

  it('marks a rate-limited provider as ineligible', () => {
    const result = scoreProvider({
      provider: fakeProvider('claude', ['bugfix']),
      health: health({ rateLimited: true }),
      usage1h: usage(),
      classification: classification(['bugfix']),
    });
    expect(result.eligible).toBe(false);
    expect(result.ineligibleReason).toBe('Provider is rate limited.');
    expect(result.ineligibleCode).toBe('PROVIDER_RATE_LIMITED');
  });

  it('propagates the health check\'s reasonCode as ineligibleCode when not ready', () => {
    const result = scoreProvider({
      provider: fakeProvider('claude', ['bugfix']),
      health: health({ ready: false, message: 'claude CLI not found on PATH.', reasonCode: 'PROVIDER_NOT_INSTALLED' }),
      usage1h: usage(),
      classification: classification(['bugfix']),
    });
    expect(result.ineligibleCode).toBe('PROVIDER_NOT_INSTALLED');
  });

  it('gives full capability score when all required capabilities are matched', () => {
    const result = scoreProvider({
      provider: fakeProvider('codex', ['bugfix', 'implementation']),
      health: health(),
      usage1h: usage(),
      classification: classification(['bugfix']),
    });
    expect(result.components.capability).toBeCloseTo(DEFAULT_ROUTING_WEIGHTS.capability, 5);
  });

  it('gives zero capability score when none of the required capabilities are matched', () => {
    const result = scoreProvider({
      provider: fakeProvider('claude', ['documentation']),
      health: health(),
      usage1h: usage(),
      classification: classification(['bugfix', 'implementation']),
    });
    expect(result.components.capability).toBe(0);
    expect(result.eligible).toBe(true);
  });

  it('makes a local analysis-only provider ineligible for an implementation task', () => {
    const provider = {
      ...fakeProvider('claude', ['analysis', 'review']),
      id: 'local-fast' as const,
      dataResidency: 'local' as const,
    };
    const result = scoreProvider({
      provider,
      health: { ...health(), provider: 'local-fast' },
      usage1h: { ...usage(), provider: 'local-fast' },
      classification: classification(['bugfix', 'implementation']),
    });
    expect(result.eligible).toBe(false);
    expect(result.total).toBe(-Infinity);
  });

  it('penalizes recent failures within the small-sample lookback window', () => {
    const healthyRun = scoreProvider({
      provider: fakeProvider('claude', ['bugfix']),
      health: health(),
      usage1h: usage({ requests: 3, successes: 3, failures: 0 }),
      classification: classification(['bugfix']),
    });
    const failingRun = scoreProvider({
      provider: fakeProvider('claude', ['bugfix']),
      health: health(),
      usage1h: usage({ requests: 3, successes: 0, failures: 3 }),
      classification: classification(['bugfix']),
    });
    expect(failingRun.total).toBeLessThan(healthyRun.total);
  });

  it('a provider used up to capacity scores lower than an idle one', () => {
    const idle = scoreProvider({
      provider: fakeProvider('claude', ['bugfix']),
      health: health(),
      usage1h: usage({ requests: 0 }),
      classification: classification(['bugfix']),
    });
    const busy = scoreProvider({
      provider: fakeProvider('claude', ['bugfix']),
      health: health(),
      usage1h: usage({ requests: 25 }),
      classification: classification(['bugfix']),
    });
    expect(busy.total).toBeLessThan(idle.total);
  });

  it('is a pure function: identical inputs always produce identical scores', () => {
    const input = {
      provider: fakeProvider('claude', ['bugfix']),
      health: health(),
      usage1h: usage({ requests: 5, successes: 4, failures: 1 }),
      classification: classification(['bugfix']),
    };
    const a = scoreProvider(input);
    const b = scoreProvider(input);
    expect(a).toEqual(b);
  });
});
