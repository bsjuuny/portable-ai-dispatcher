import { ProviderRegistry } from './types.js';
import { ClaudeProvider } from './claude/claude-provider.js';
import { CodexProvider } from './codex/codex-provider.js';
import { createLocalProviders } from './local/index.js';
import type { DispatcherConfig } from '../config/schema.js';

/**
 * The only module (besides tests) allowed to import both concrete provider classes -
 * this is the composition root. Everything downstream consumes providers only
 * through the AIProvider interface via ProviderRegistry.
 *
 * `config` is optional and additive: with no config, this registers exactly what
 * v1.0 always registered (Claude + Codex), unchanged. When a config is passed,
 * any `local.profiles[]` entries are also registered - routing/scorer.ts and
 * everywhere else downstream already operate generically over
 * `ProviderRegistry.list()`, so no other file needs to know local providers exist.
 */
export function createDefaultProviderRegistry(config?: DispatcherConfig): ProviderRegistry {
  const registry = new ProviderRegistry();
  if (config?.providers.claude.enabled ?? true) registry.register(new ClaudeProvider());
  if (config?.providers.codex.enabled ?? true) registry.register(new CodexProvider());
  if (config) {
    for (const provider of createLocalProviders(config)) {
      registry.register(provider);
    }
  }
  return registry;
}

export { ProviderRegistry } from './types.js';
export type { AIProvider, ProviderCommandPlan, ProviderRunOptions } from './types.js';
export {
  LocalProvider,
  OllamaRuntimeAdapter,
  LlamaCppRuntimeAdapter,
  OpenAICompatibleRuntimeAdapter,
} from './local/index.js';
