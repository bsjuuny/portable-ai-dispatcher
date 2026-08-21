import { describe, expect, it } from 'vitest';
import { parseConfig, DispatcherConfigSchema } from '../../src/config/schema.js';

describe('config schema', () => {
  it('fills in complete defaults for an empty config', () => {
    const config = parseConfig({});
    expect(config.providers.claude.enabled).toBe(true);
    expect(config.providers.codex.enabled).toBe(true);
    expect(config.execution.timeoutMs).toBe(300_000);
    expect(config.execution.sandbox).toBe('workspace-write');
    expect(config.execution.approval).toBe('never');
    expect(config.routing.weights.capability).toBe(0.35);
    expect(config.retry.maxRetries).toBe(1);
    expect(config.circuitBreaker.failureThreshold).toBe(4);
    expect(config.validation.maxFixAttempts).toBe(2);
    expect(config.review.maxReviewCycles).toBe(2);
    expect(config.safety.protectedPaths).toContain('.env');
  });

  it('merges a partial override with defaults for everything else', () => {
    const config = parseConfig({ execution: { timeoutMs: 60_000 } });
    expect(config.execution.timeoutMs).toBe(60_000);
    expect(config.execution.sandbox).toBe('workspace-write'); // still defaulted
    expect(config.retry.maxRetries).toBe(1); // untouched section still defaulted
  });

  it('rejects an invalid sandbox enum value', () => {
    expect(() => parseConfig({ execution: { sandbox: 'full-access-please' } })).toThrow();
  });

  it('rejects a negative timeoutMs', () => {
    expect(() => parseConfig({ execution: { timeoutMs: -1 } })).toThrow();
  });

  it('treats null/undefined the same as an empty object', () => {
    expect(parseConfig(undefined)).toEqual(parseConfig({}));
    expect(parseConfig(null)).toEqual(parseConfig({}));
  });

  it('allows overriding routing weights independently', () => {
    const config = parseConfig({ routing: { weights: { capability: 0.5 } } });
    expect(config.routing.weights.capability).toBe(0.5);
    expect(config.routing.weights.usage).toBe(0.2); // sibling still defaulted
  });

  it('the exported schema type-checks a fully-specified config object (compile-time smoke check)', () => {
    const full = DispatcherConfigSchema.parse({
      providers: { claude: { enabled: false }, codex: { enabled: true } },
      execution: { timeoutMs: 1000, sandbox: 'read-only', approval: 'untrusted' },
      routing: { weights: { capability: 1, usage: 0, successRate: 0, latency: 0, availability: 0, failurePenalty: 0 } },
      retry: { maxRetries: 0 },
      fallback: { enabled: false },
      circuitBreaker: { failureThreshold: 1, sampleSize: 1, cooldownMs: 1000 },
      validation: { commands: { test: ['echo', 'ok'] }, maxFixAttempts: 0 },
      review: { enabled: false, maxReviewCycles: 0, preferIndependentReviewer: false },
      diagnostics: { saveFailureArtifacts: false, logPrompts: true },
      safety: { protectedPaths: [] },
    });
    expect(full.providers.claude.enabled).toBe(false);
  });
});
