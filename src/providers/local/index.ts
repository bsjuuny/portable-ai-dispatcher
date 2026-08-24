import type { DispatcherConfig } from '../../config/schema.js';
import type { AIProvider } from '../types.js';
import type { LocalRuntimeAdapter, LocalRuntimeKind } from '../../models/local.js';
import { LocalProvider } from './local-provider.js';
import { OllamaRuntimeAdapter } from './ollama-runtime.js';
import { LlamaCppRuntimeAdapter } from './llamacpp-runtime.js';
import { OpenAICompatibleRuntimeAdapter } from './openai-compatible-runtime.js';

/**
 * Builds one LocalProvider per `config.local.profiles[]` entry, wired to the
 * matching runtime adapter and host. A profile referencing a runtime that is
 * disabled in `config.local.runtimes` (llamacpp defaults to disabled - it is
 * unverified, see llamacpp-runtime.ts) is skipped rather than registered
 * un-health-checkable; `dispatcher local status` still reports it by name so the
 * gap is visible instead of silent.
 */
export function createLocalProviders(config: DispatcherConfig): AIProvider[] {
  const adapters: Record<LocalRuntimeKind, LocalRuntimeAdapter> = {
    ollama: new OllamaRuntimeAdapter(),
    llamacpp: new LlamaCppRuntimeAdapter(),
    'openai-compatible': new OpenAICompatibleRuntimeAdapter(),
  };

  const providers: AIProvider[] = [];
  for (const profile of config.local.profiles) {
    const runtimeConfig = config.local.runtimes[profile.runtime];
    if (!runtimeConfig.enabled) continue;
    providers.push(new LocalProvider(profile, adapters[profile.runtime], runtimeConfig.host, config.local.coding));
  }
  return providers;
}

export { OllamaRuntimeAdapter } from './ollama-runtime.js';
export { LlamaCppRuntimeAdapter } from './llamacpp-runtime.js';
export { LocalProvider } from './local-provider.js';
export { OpenAICompatibleRuntimeAdapter } from './openai-compatible-runtime.js';
