import { describe, expect, it } from 'vitest';
import { ProviderRegistry } from '../../src/providers/types.js';
import type { AIProvider } from '../../src/providers/types.js';
import { isDispatcherError } from '../../src/models/error.js';

function fakeProvider(id: AIProvider['id']): AIProvider {
  return {
    id,
    capabilities: () => [],
    checkHealth: async () => ({
      provider: id, checkedAt: new Date().toISOString(), installed: true, authenticated: true,
      reachable: true, rateLimited: false, ready: true,
    }),
    buildCommand: () => ({ file: 'x', args: [], cwd: '.', timeoutMs: 1000 }),
    parseOutcome: () => {
      throw new Error('unused');
    },
  };
}

describe('ProviderRegistry.get', () => {
  it('returns a registered provider', () => {
    const registry = new ProviderRegistry();
    registry.register(fakeProvider('claude'));
    expect(registry.get('claude').id).toBe('claude');
  });

  it('throws NO_AVAILABLE_PROVIDER for an unregistered cloud provider id', () => {
    const registry = new ProviderRegistry();
    expect(() => registry.get('codex')).toThrow();
    try {
      registry.get('codex');
    } catch (error) {
      expect(isDispatcherError(error) && error.code === 'NO_AVAILABLE_PROVIDER').toBe(true);
    }
  });

  it('throws the more specific LOCAL_RUNTIME_NOT_CONFIGURED for an unregistered local-* provider id', () => {
    const registry = new ProviderRegistry();
    try {
      registry.get('local-fast');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isDispatcherError(error) && error.code === 'LOCAL_RUNTIME_NOT_CONFIGURED').toBe(true);
    }
  });
});
