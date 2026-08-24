import { describe, expect, it } from 'vitest';
import { createLocalProviders } from '../../src/providers/local/index.js';
import { LocalProvider } from '../../src/providers/local/local-provider.js';
import { parseConfig } from '../../src/config/schema.js';

describe('createLocalProviders', () => {
  it('returns an empty array when no profiles are configured', () => {
    expect(createLocalProviders(parseConfig({}))).toEqual([]);
  });

  it('creates one LocalProvider per profile, with id local-<name>', () => {
    const config = parseConfig({
      local: { profiles: [{ name: 'fast', runtime: 'ollama', model: 'qwen3:4b' }] },
    });
    const providers = createLocalProviders(config);
    expect(providers).toHaveLength(1);
    expect(providers[0]).toBeInstanceOf(LocalProvider);
    expect(providers[0]!.id).toBe('local-fast');
  });

  it('skips a profile whose runtime is disabled in config.local.runtimes', () => {
    const config = parseConfig({
      local: {
        runtimes: { llamacpp: { enabled: false } },
        profiles: [{ name: 'unverified', runtime: 'llamacpp', model: 'm' }],
      },
    });
    expect(createLocalProviders(config)).toEqual([]);
  });

  it('creates providers for multiple profiles across different runtimes', () => {
    const config = parseConfig({
      local: {
        runtimes: { llamacpp: { enabled: true } },
        profiles: [
          { name: 'fast', runtime: 'ollama', model: 'qwen3:4b' },
          { name: 'cpp', runtime: 'llamacpp', model: 'm.gguf' },
        ],
      },
    });
    const providers = createLocalProviders(config);
    expect(providers.map((p) => p.id).sort()).toEqual(['local-cpp', 'local-fast']);
  });

  it('creates a provider for an OpenAI-compatible local server', () => {
    const config = parseConfig({
      local: {
        runtimes: { 'openai-compatible': { enabled: true, host: 'http://127.0.0.1:1234' } },
        profiles: [{ name: 'lm-studio', runtime: 'openai-compatible', model: 'local-coder' }],
      },
    });
    expect(createLocalProviders(config).map((provider) => provider.id)).toEqual(['local-lm-studio']);
  });
});
