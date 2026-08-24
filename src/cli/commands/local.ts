import type { AppContext } from '../bootstrap.js';
import type { LocalRuntimeAdapter, LocalRuntimeKind } from '../../models/local.js';
import { resolve } from 'node:path';
import { detectHardwareProfile, hardwareFingerprint } from '../../local/hardware.js';
import { importModelPack } from '../../local/model-packs.js';
import { qualifyLocalModel } from '../../local/qualification.js';
import { portableAssetRoot } from '../../local/preflight.js';
import {
  OllamaRuntimeAdapter,
  LlamaCppRuntimeAdapter,
  OpenAICompatibleRuntimeAdapter,
} from '../../providers/local/index.js';

export const ADAPTERS: Record<LocalRuntimeKind, LocalRuntimeAdapter> = {
  ollama: new OllamaRuntimeAdapter(),
  llamacpp: new LlamaCppRuntimeAdapter(),
  'openai-compatible': new OpenAICompatibleRuntimeAdapter(),
};

/** Runtime detection independent of whether any `local.profiles[]` entry
 * references it - lets an operator check `ollama`/`llama.cpp` reachability
 * before configuring a profile at all. */
export async function runLocalRuntimesCommand(ctx: AppContext, json: boolean): Promise<number> {
  const runtimes = ctx.config.local.runtimes;
  const results = await Promise.all(
    (Object.keys(runtimes) as LocalRuntimeKind[]).map(async (kind) => {
      const runtimeConfig = runtimes[kind];
      if (!runtimeConfig.enabled) {
        return { runtime: kind, host: runtimeConfig.host, enabled: false, reachable: false, checkedAt: new Date().toISOString(), message: 'disabled in config' };
      }
      const status = await ADAPTERS[kind].detect(runtimeConfig.host);
      return { ...status, enabled: true };
    }),
  );

  if (json) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  } else {
    for (const r of results) {
      process.stdout.write(`${r.runtime}: enabled=${r.enabled} reachable=${r.reachable} host=${r.host}${r.version ? ` version=${r.version}` : ''}${r.message ? ` (${r.message})` : ''}\n`);
    }
  }
  return results.every((r) => !r.enabled || r.reachable) ? 0 : 1;
}

/** Benchmarks a configured profile through the exact adapter Dispatcher uses and
 * saves a hardware-specific qualification record. */
export async function runLocalBenchmarkCommand(ctx: AppContext, profileName: string | undefined, json: boolean): Promise<number> {
  const profile = profileName
    ? ctx.config.local.profiles.find((candidate) => candidate.name === profileName)
    : ctx.config.local.profiles[0];
  if (!profile) {
    const message = 'No local profile is configured. Add local.profiles[] before benchmarking.';
    if (json) process.stdout.write(`${JSON.stringify({ error: message })}\n`);
    else process.stderr.write(`${message}\n`);
    return 1;
  }
  const runtimeConfig = ctx.config.local.runtimes[profile.runtime];
  if (!runtimeConfig.enabled) {
    const message = `Runtime '${profile.runtime}' is disabled in configuration.`;
    if (json) process.stdout.write(`${JSON.stringify({ error: message })}\n`);
    else process.stderr.write(`${message}\n`);
    return 1;
  }
  try {
    const detected = await ADAPTERS[profile.runtime].detect(runtimeConfig.host);
    const hardware = detectHardwareProfile(ctx.cwd);
    const qualification = await qualifyLocalModel({
      root: ctx.cwd,
      adapter: ADAPTERS[profile.runtime],
      request: {
        profileId: `local-${profile.name}`,
        runtime: profile.runtime,
        host: runtimeConfig.host,
        model: profile.model,
        timeoutMs: 60_000,
        prompt: '',
        maxOutputTokens: 32,
      },
      hardwareFingerprint: hardwareFingerprint(hardware),
      ...(detected.version ? { runtimeVersion: detected.version } : {}),
    });
    const result = { profile: profile.name, host: runtimeConfig.host, qualification };
    if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stdout.write(`${profile.name}: ${qualification.generationTokensPerSecond} tokens/s, ${qualification.totalDurationMs} ms (saved to .dispatcher/local/qualification.json)\n`);
    return 0;
  } catch (cause) {
    const message = (cause as Error).message;
    if (json) process.stdout.write(`${JSON.stringify({ profile: profile.name, error: message })}\n`);
    else process.stderr.write(`Benchmark failed: ${message}\n`);
    return 1;
  }
}

/** Copies a pre-downloaded pack after manifest, path, licence-policy, and
 * declared SHA-256 checks. It never contacts a registry or downloads models. */
export function runLocalImportPackCommand(ctx: AppContext, source: string, json: boolean): number {
  try {
    const result = importModelPack(resolve(ctx.cwd, source), resolve(portableAssetRoot(ctx.cwd), ctx.config.local.bundle.modelPacksDirectory), {
      requireLicenseMetadata: ctx.config.local.bundle.requireModelLicenseMetadata,
    });
    if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stdout.write(`Imported ${result.packId} to ${result.destination}${result.verifiedModels.length ? `; verified: ${result.verifiedModels.join(', ')}` : ''}\n`);
    return 0;
  } catch (cause) {
    const message = (cause as Error).message;
    if (json) process.stdout.write(`${JSON.stringify({ error: message })}\n`);
    else process.stderr.write(`Import failed: ${message}\n`);
    return 1;
  }
}

/** Real model inventory per reachable runtime - independent of `local.profiles[]`,
 * so an operator can see what's actually installed before writing a profile. */
export async function runLocalModelsCommand(ctx: AppContext, json: boolean): Promise<number> {
  const runtimes = ctx.config.local.runtimes;
  const enabledKinds = (Object.keys(runtimes) as LocalRuntimeKind[]).filter((kind) => runtimes[kind].enabled);

  const results = await Promise.all(
    enabledKinds.map(async (kind) => {
      const runtimeConfig = runtimes[kind];
      try {
        const models = await ADAPTERS[kind].listModels(runtimeConfig.host);
        return { runtime: kind, host: runtimeConfig.host, models };
      } catch (cause) {
        return { runtime: kind, host: runtimeConfig.host, models: [], error: (cause as Error).message };
      }
    }),
  );

  if (json) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  } else {
    for (const r of results) {
      if (r.error) {
        process.stdout.write(`${r.runtime} (${r.host}): unreachable - ${r.error}\n`);
        continue;
      }
      if (r.models.length === 0) {
        process.stdout.write(`${r.runtime} (${r.host}): no models found\n`);
        continue;
      }
      for (const m of r.models) {
        process.stdout.write(`${r.runtime}: ${m.name}${m.parameterSize ? ` (${m.parameterSize}, ${m.quantizationLevel ?? 'unknown quant'})` : ''}\n`);
      }
    }
  }
  return 0;
}

/** Combines runtime reachability with the health of every configured
 * `local-<profile>` provider actually registered in ctx.providers, so this is the
 * one command that reflects what `--provider local-x` will really route to. */
export async function runLocalStatusCommand(ctx: AppContext, json: boolean): Promise<number> {
  const runtimeResultsPromise = runtimeSummary(ctx);
  const localProviders = ctx.providers.list().filter((p) => p.dataResidency === 'local');
  const profileResults = await Promise.all(
    localProviders.map(async (p) => ({ provider: p.id, capabilities: p.capabilities(), health: await p.checkHealth() })),
  );
  const runtimes = await runtimeResultsPromise;

  if (json) {
    process.stdout.write(`${JSON.stringify({ runtimes, profiles: profileResults }, null, 2)}\n`);
  } else {
    process.stdout.write('Runtimes:\n');
    for (const r of runtimes) {
      process.stdout.write(`  ${r.runtime}: enabled=${r.enabled} reachable=${r.reachable} host=${r.host}${r.version ? ` version=${r.version}` : ''}\n`);
    }
    process.stdout.write(profileResults.length ? 'Profiles:\n' : 'Profiles: (none configured - see local.profiles in .ai-dispatcher.yml)\n');
    for (const p of profileResults) {
      process.stdout.write(`  ${p.provider}: ready=${p.health.ready} capabilities=${p.capabilities.join(',')}\n`);
    }
  }

  return profileResults.every((p) => p.health.ready) ? 0 : profileResults.length === 0 ? 0 : 1;
}

async function runtimeSummary(ctx: AppContext) {
  const runtimes = ctx.config.local.runtimes;
  return Promise.all(
    (Object.keys(runtimes) as LocalRuntimeKind[]).map(async (kind) => {
      const runtimeConfig = runtimes[kind];
      if (!runtimeConfig.enabled) {
        return { runtime: kind, host: runtimeConfig.host, enabled: false, reachable: false };
      }
      const status = await ADAPTERS[kind].detect(runtimeConfig.host);
      return { runtime: kind, host: runtimeConfig.host, enabled: true, reachable: status.reachable, version: status.version };
    }),
  );
}
