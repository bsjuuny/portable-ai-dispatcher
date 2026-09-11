import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskClassification } from '../../src/models/classification.js';
import { isDispatcherError } from '../../src/models/error.js';
import { parseConfig } from '../../src/config/schema.js';
import { createDefaultProviderRegistry, ProviderRegistry } from '../../src/providers/index.js';
import { selectProvider } from '../../src/routing/router.js';
import { InMemoryUsageStore } from '../../src/routing/usage-store.js';
import { UsageTracker } from '../../src/routing/usage-tracker.js';

const analysisTask: TaskClassification = {
  type: 'analysis',
  confidence: 1,
  requiredCapabilities: ['analysis'],
  riskLevel: 'low',
  estimatedComplexity: 'normal',
  scope: 'repository',
  signals: ['closed-environment test'],
};

const remediationTask: TaskClassification = {
  type: 'repository-remediation',
  confidence: 1,
  requiredCapabilities: ['repository-analysis', 'bugfix', 'implementation'],
  riskLevel: 'high',
  estimatedComplexity: 'complex',
  scope: 'repository',
  signals: ['closed-environment test'],
};

function closedEnvironmentConfig() {
  return parseConfig({
    providers: {
      claude: { enabled: false },
      codex: { enabled: false },
    },
    local: {
      runtimes: {
        ollama: { enabled: true, host: 'http://127.0.0.1:11434' },
        llamacpp: { enabled: false },
      },
      profiles: [{ name: 'airgap', runtime: 'ollama', model: 'local-model' }],
      allowAutoDownload: false,
    },
  });
}

function healthyLoopbackFetch() {
  return vi.fn(async (input: string | URL | Request) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(String(input));
    expect(['127.0.0.1', 'localhost', '[::1]']).toContain(url.hostname);
    const body = url.pathname === '/api/tags'
      ? { models: [{ name: 'local-model' }] }
      : { version: 'airgap-test' };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

describe('closed environment deployment', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('registers only the configured local provider and routes analysis without cloud access', async () => {
    const fetchMock = healthyLoopbackFetch();
    vi.stubGlobal('fetch', fetchMock);
    const registry = createDefaultProviderRegistry(closedEnvironmentConfig());

    expect(registry.list().map((provider) => provider.id)).toEqual(['local-airgap']);
    expect(registry.list()[0]?.dataResidency).toBe('local');

    const routing = await selectProvider(registry, new UsageTracker(new InMemoryUsageStore()), {
      taskId: 'closed-analysis',
      classification: analysisTask,
    });

    expect(routing.selected).toBe('local-airgap');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the only local runtime is unreachable instead of trying a cloud fallback', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('connect ECONNREFUSED');
    });
    vi.stubGlobal('fetch', fetchMock);
    const registry = createDefaultProviderRegistry(closedEnvironmentConfig());

    let caught: unknown;
    try {
      await selectProvider(registry, new UsageTracker(new InMemoryUsageStore()), {
        taskId: 'closed-unreachable',
        classification: analysisTask,
      });
    } catch (error) {
      caught = error;
    }

    expect(isDispatcherError(caught)).toBe(true);
    if (isDispatcherError(caught)) {
      expect(caught.code).toBe('NO_AVAILABLE_PROVIDER');
      expect(caught.message).toContain('local-airgap');
      expect(caught.message).not.toContain('claude:');
      expect(caught.message).not.toContain('codex:');
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('routes repository remediation to the autonomous local coding provider', async () => {
    vi.stubGlobal('fetch', healthyLoopbackFetch());
    const registry = createDefaultProviderRegistry(closedEnvironmentConfig());

    const routing = await selectProvider(registry, new UsageTracker(new InMemoryUsageStore()), {
      taskId: 'closed-remediation',
      classification: remediationTask,
    });
    expect(routing.selected).toBe('local-airgap');
  });

  it('cannot force a disabled cloud provider back into the closed environment', async () => {
    const registry = createDefaultProviderRegistry(closedEnvironmentConfig());

    await expect(
      selectProvider(registry, new UsageTracker(new InMemoryUsageStore()), {
        taskId: 'closed-forced-cloud',
        classification: analysisTask,
        forcedProvider: 'codex',
      }),
    ).rejects.toMatchObject({
      code: 'NO_AVAILABLE_PROVIDER',
      message: 'Provider "codex" is not registered.',
    });
  });

  it('gives an actionable error when cloud providers are disabled without a local profile', async () => {
    const registry = new ProviderRegistry();

    await expect(
      selectProvider(registry, new UsageTracker(new InMemoryUsageStore()), {
        taskId: 'closed-empty',
        classification: analysisTask,
      }),
    ).rejects.toMatchObject({
      code: 'NO_AVAILABLE_PROVIDER',
      message: expect.stringContaining('configure a local profile'),
    });
  });
});
