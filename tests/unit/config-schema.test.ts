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
    expect(config.execution.adaptiveTimeout.enabled).toBe(true);
    expect(config.execution.adaptiveTimeout.complexMs).toBe(1_800_000);
    expect(config.execution.adaptiveTimeout.idleMs).toBe(300_000);
    expect(config.routing.weights.capability).toBe(0.35);
    expect(config.retry.maxRetries).toBe(1);
    expect(config.circuitBreaker.failureThreshold).toBe(4);
    expect(config.validation.maxFixAttempts).toBe(2);
    expect(config.review.maxReviewCycles).toBe(2);
    expect(config.safety.protectedPaths).toContain('.env');
    // Local LLM Adapter + Hardening increment - additive defaults. autoApply
    // defaults false and workspaceIsolation defaults true so a zero-config repo's
    // fix/implement tasks run in the new isolated-worktree safety-gate path but
    // never silently auto-apply without an explicit opt-in.
    expect(config.local.profiles).toEqual([]);
    expect(config.local.runtimes.ollama.enabled).toBe(true);
    expect(config.local.runtimes.ollama.host).toBe('http://127.0.0.1:11434');
    expect(config.local.runtimes.llamacpp.enabled).toBe(false);
    expect(config.local.runtimes['openai-compatible'].enabled).toBe(false);
    expect(config.local.allowAutoDownload).toBe(false);
    expect(config.local.coding.enabled).toBe(true);
    expect(config.local.coding.maxTurns).toBe(40);
    expect(config.local.coding.maxOutputTokens).toBe(1_024);
    expect(config.safety.workspaceIsolation.enabled).toBe(true);
    expect(config.safety.autoApply.enabled).toBe(false);
    expect(config.safety.autoApply.maxRiskLevel).toBe('MEDIUM');
    expect(config.safety.blastRadius.bugfix).toEqual({ maxFiles: 15, maxChangedLines: 400 });
    expect(config.safety.blastRadius.implementation).toEqual({ maxFiles: 30, maxChangedLines: 1000 });
    expect(config.safety.blastRadius.refactor).toEqual({ maxFiles: 50, maxChangedLines: 2000 });
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
      safety: {
        protectedPaths: [],
        workspaceIsolation: { enabled: false },
        blastRadius: { bugfix: { maxFiles: 1, maxChangedLines: 1 } },
        autoApply: { enabled: true, maxRiskLevel: 'HIGH' },
      },
      local: {
        runtimes: { ollama: { enabled: false, host: 'http://127.0.0.1:1' }, llamacpp: { enabled: true, host: 'http://127.0.0.1:2' } },
        profiles: [{ name: 'fast', runtime: 'ollama', model: 'qwen3:4b', capabilities: ['analysis', 'review'] }],
        allowAutoDownload: true,
      },
    });
    expect(full.providers.claude.enabled).toBe(false);
    expect(full.local.profiles[0]?.name).toBe('fast');
  });

  it('local.profiles[].capabilities rejects a capability that is not a real ProviderCapability', () => {
    expect(() =>
      parseConfig({ local: { profiles: [{ name: 'x', runtime: 'ollama', model: 'm', capabilities: ['not-a-real-capability'] }] } }),
    ).toThrow();
  });

  it('local.runtimes.llamacpp defaults to disabled (unverified adapter - see llamacpp-runtime.ts)', () => {
    const config = parseConfig({});
    expect(config.local.runtimes.llamacpp.enabled).toBe(false);
  });

  it('allows overriding just safety.autoApply.enabled while leaving every other safety field defaulted', () => {
    const config = parseConfig({ safety: { autoApply: { enabled: true } } });
    expect(config.safety.autoApply.enabled).toBe(true);
    expect(config.safety.autoApply.maxRiskLevel).toBe('MEDIUM');
    expect(config.safety.workspaceIsolation.enabled).toBe(true);
    expect(config.safety.protectedPaths).toContain('.env');
  });

  it('rejects two local.profiles[] entries with the same name - they would silently overwrite each other as the same local-<name> provider id', () => {
    expect(() =>
      parseConfig({
        local: {
          profiles: [
            { name: 'fast', runtime: 'ollama', model: 'qwen3:4b' },
            { name: 'fast', runtime: 'ollama', model: 'qwen3:8b' },
          ],
        },
      }),
    ).toThrow();
  });

  it('rejects an empty local.profiles[].name', () => {
    expect(() => parseConfig({ local: { profiles: [{ name: '', runtime: 'ollama', model: 'qwen3:4b' }] } })).toThrow();
  });

  it('allows two profiles with different names on the same runtime', () => {
    const config = parseConfig({
      local: {
        profiles: [
          { name: 'fast', runtime: 'ollama', model: 'qwen3:4b' },
          { name: 'heavy', runtime: 'ollama', model: 'qwen3.5:9b' },
        ],
      },
    });
    expect(config.local.profiles.map((p) => p.name)).toEqual(['fast', 'heavy']);
  });
});
