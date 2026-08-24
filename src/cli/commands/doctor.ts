import type { AppContext } from '../bootstrap.js';
import type { LocalRuntimeAdapter, LocalRuntimeKind } from '../../models/local.js';
import {
  OllamaRuntimeAdapter,
  LlamaCppRuntimeAdapter,
  OpenAICompatibleRuntimeAdapter,
} from '../../providers/local/index.js';
import { runOfflinePreflight } from '../../local/preflight.js';

const LOCAL_ADAPTERS: Record<LocalRuntimeKind, LocalRuntimeAdapter> = {
  ollama: new OllamaRuntimeAdapter(),
  llamacpp: new LlamaCppRuntimeAdapter(),
  'openai-compatible': new OpenAICompatibleRuntimeAdapter(),
};

export async function runDoctorCommand(ctx: AppContext, json: boolean): Promise<number> {
  const results = await Promise.all(
    ctx.providers.list().map(async (provider) => ({ provider: provider.id, health: await provider.checkHealth() })),
  );

  // Local runtimes are reported even with zero configured local.profiles[] - an
  // operator running `doctor` should see that Ollama is reachable before writing
  // a profile, not only after one exists and gets health-checked as a provider.
  const runtimes = ctx.config.local.runtimes;
  const localRuntimeResults = await Promise.all(
    (Object.keys(runtimes) as LocalRuntimeKind[]).map(async (kind) => {
      const runtimeConfig = runtimes[kind];
      if (!runtimeConfig.enabled) return { runtime: kind, host: runtimeConfig.host, enabled: false, reachable: false };
      const status = await LOCAL_ADAPTERS[kind].detect(runtimeConfig.host);
      return { runtime: kind, host: runtimeConfig.host, enabled: true, reachable: status.reachable, version: status.version, message: status.message };
    }),
  );

  const allReady = results.every((r) => r.health.ready);
  const preflight = runOfflinePreflight(ctx.cwd, ctx.config);

  if (json) {
    process.stdout.write(`${JSON.stringify({ ready: allReady, providers: results, localRuntimes: localRuntimeResults, localAi: preflight }, null, 2)}\n`);
  } else {
    for (const { provider, health } of results) {
      process.stdout.write(
        `${provider}: installed=${health.installed} authenticated=${String(health.authenticated)} ready=${health.ready}${health.version ? ` version=${health.version}` : ''}${health.message ? ` (${health.message})` : ''}\n`,
      );
    }
    for (const r of localRuntimeResults) {
      process.stdout.write(
        `local runtime [${r.runtime}]: enabled=${r.enabled} reachable=${r.reachable} host=${r.host}${r.version ? ` version=${r.version}` : ''}${r.message ? ` (${r.message})` : ''}\n`,
      );
    }
    process.stdout.write(`local hardware: tier=${preflight.tier} cpu=${preflight.hardware.cpu.model ?? 'unknown'} isa=${preflight.hardware.cpu.instructionSets.join(',') || 'unknown'} acceleration=${preflight.selectedRuntime.selected?.acceleration ?? 'cpu'} cpuBaseline=${preflight.cpuBaselineRuntime.selected?.runtimeId ?? 'unavailable'} git=${preflight.git.available ? preflight.git.source : 'not found'}\n`);
    if (preflight.models.length) {
      for (const model of preflight.models) process.stdout.write(`local model [${model.id}]: ${model.status}\n`);
    }
    process.stdout.write(allReady ? 'All providers ready.\n' : 'One or more providers are not ready.\n');
  }

  return allReady ? 0 : 1;
}
