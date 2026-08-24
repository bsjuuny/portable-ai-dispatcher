import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/schema.js';
import type { TaskClassification } from '../../src/models/classification.js';
import type { DispatcherTask } from '../../src/models/task.js';
import { createDefaultProviderRegistry } from '../../src/providers/index.js';
import { OllamaRuntimeAdapter } from '../../src/providers/local/ollama-runtime.js';
import { selectProvider } from '../../src/routing/router.js';
import { InMemoryUsageStore } from '../../src/routing/usage-store.js';
import { UsageTracker } from '../../src/routing/usage-tracker.js';

const host = 'http://127.0.0.1:11434';
const runtime = new OllamaRuntimeAdapter();
const liveRequested = process.env['AI_DISPATCHER_LIVE_LOCAL_GENERATION'] === '1';
const detected = liveRequested ? await runtime.detect(host, { timeoutMs: 5_000 }).catch(() => null) : null;
const models = detected?.reachable ? await runtime.listModels(host, { timeoutMs: 5_000 }).catch(() => []) : [];
const model = models[0]?.name;
const localReady = liveRequested && detected?.reachable === true && model !== undefined;

const classification: TaskClassification = {
  type: 'analysis',
  confidence: 1,
  requiredCapabilities: ['analysis'],
  riskLevel: 'low',
  estimatedComplexity: 'simple',
  scope: 'targeted',
  signals: ['live closed-environment contract'],
};

describe('closed environment (live loopback contract)', () => {
  it.skipIf(!localReady)('routes and executes with only a real loopback Ollama provider registered', async () => {
    const config = parseConfig({
      providers: { claude: { enabled: false }, codex: { enabled: false } },
      local: {
        runtimes: { ollama: { enabled: true, host }, llamacpp: { enabled: false } },
        profiles: [{ name: 'airgap-live', runtime: 'ollama', model }],
        allowAutoDownload: false,
      },
    });
    const registry = createDefaultProviderRegistry(config);
    expect(registry.list().map((provider) => provider.id)).toEqual(['local-airgap-live']);

    const routing = await selectProvider(registry, new UsageTracker(new InMemoryUsageStore()), {
      taskId: 'closed-live',
      classification,
    });
    expect(routing.selected).toBe('local-airgap-live');

    const task: DispatcherTask = {
      id: 'closed-live',
      command: 'ask',
      specification: {
        rawDescription: 'Reply briefly that local closed-network execution is available.',
        attachments: [],
        sourcePaths: [],
      },
      workingDirectory: process.cwd(),
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      classification,
    };
    const provider = registry.get(routing.selected);
    expect(provider.dataResidency).toBe('local');
    expect(provider.executeDirect).toBeDefined();

    const result = await provider.executeDirect!(
      task,
      {},
      { sandbox: 'read-only', approval: 'never', timeoutMs: 60_000 },
      'closed-live-execution',
    );

    expect(result.status).toBe('success');
    expect(result.text?.length).toBeGreaterThan(0);
    expect(result.provider).toBe('local-airgap-live');
  }, 90_000);

  if (!localReady) {
    it('reports that the opt-in live generation contract was skipped', () => {
      expect(localReady).toBe(false);
    });
  }
});
