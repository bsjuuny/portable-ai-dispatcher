import { ProviderRegistry } from './types.js';
import { ClaudeProvider } from './claude/claude-provider.js';
import { CodexProvider } from './codex/codex-provider.js';

/**
 * The only module (besides tests) allowed to import both concrete provider classes -
 * this is the composition root. Everything downstream consumes providers only
 * through the AIProvider interface via ProviderRegistry.
 */
export function createDefaultProviderRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register(new ClaudeProvider());
  registry.register(new CodexProvider());
  return registry;
}

export { ProviderRegistry } from './types.js';
export type { AIProvider, ProviderCommandPlan, ProviderRunOptions } from './types.js';
