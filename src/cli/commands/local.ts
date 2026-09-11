import type { AppContext } from '../bootstrap.js';
import type { LocalRuntimeAdapter, LocalRuntimeKind } from '../../models/local.js';
import { createServer } from 'node:net';
import { delimiter, dirname, resolve } from 'node:path';
import { detectHardwareProfile, hardwareFingerprint } from '../../local/hardware.js';
import { importModelPack } from '../../local/model-packs.js';
import { qualifyLocalModel } from '../../local/qualification.js';
import { portableAssetRoot, runOfflinePreflight } from '../../local/preflight.js';
import { startManagedProcess } from '../../process/process-runner.js';
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

/** Starts the exact runtime/model/context selected by preflight. Keeping process
 * construction here prevents shell launchers from drifting away from manifests. */
export async function runLocalStartCommand(ctx: AppContext): Promise<number> {
  const report = runOfflinePreflight(ctx.cwd, ctx.config);
  const plan = report.launchPlan;
  if (!report.overall.ready || !plan) {
    process.stderr.write(`Local model cannot start: ${report.overall.reasons.join('; ') || 'preflight produced no launch plan.'}\n`);
    return 1;
  }

  if (!(await canBind(plan.host, plan.port))) {
    const message = `Refusing to start because ${plan.host}:${plan.port} is already in use. Stop the existing service or configure another loopback port.`;
    process.stderr.write(`${message}\n`);
    return 1;
  }

  process.stdout.write(`Starting ${plan.modelId} with ${plan.runtimeId} at http://${plan.host}:${plan.port} (context=${plan.contextTokens}, threads=${plan.cpuThreads}, gpu-layers=${plan.gpuLayers})...\n`);

  const libraryDirectory = resolve(dirname(plan.runtimePath), '..', 'lib');
  const child = startManagedProcess({
    file: plan.runtimePath,
    args: [
      '-m', plan.modelPath,
      '--alias', plan.modelId,
      '-c', String(plan.contextTokens),
      '-t', String(plan.cpuThreads),
      '-ngl', String(plan.gpuLayers),
      '-ctk', 'q8_0',
      '-ctv', 'q8_0',
      '--host', plan.host,
      '--port', String(plan.port),
    ],
    cwd: portableAssetRoot(ctx.cwd),
    env: {
      ...process.env,
      DYLD_LIBRARY_PATH: [libraryDirectory, process.env['DYLD_LIBRARY_PATH']].filter(Boolean).join(delimiter),
      PATH: [dirname(plan.runtimePath), process.env['PATH']].filter(Boolean).join(delimiter),
    },
  });
  let receivedSignal: NodeJS.Signals | undefined;
  const stopForSignal = (signal: NodeJS.Signals): void => {
    if (receivedSignal) return;
    receivedSignal = signal;
    void child.stop().catch(() => undefined);
  };
  const onSigint = () => stopForSignal('SIGINT');
  const onSigterm = () => stopForSignal('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  try {
    const configuredTimeout = Number(process.env['AI_DISPATCHER_MODEL_START_TIMEOUT_MS'] ?? 180_000);
    const timeoutMs = Number.isSafeInteger(configuredTimeout) && configuredTimeout >= 10_000
      ? Math.min(configuredTimeout, 1_800_000)
      : 180_000;
    await waitForLlamaReady(`http://${plan.host}:${plan.port}`, plan.modelId, timeoutMs, () => child.hasExited());
  } catch (cause) {
    await child.stop();
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    if (receivedSignal) return receivedSignal === 'SIGINT' ? 130 : 143;
    const message = `Local model qualification failed: ${(cause as Error).message}`;
    process.stderr.write(`${message}\n`);
    return 1;
  }

  process.stdout.write(`READY: ${plan.modelId} passed health, model identity, and deterministic generation checks.\n`);
  try {
    const result = await child.completion;
    return receivedSignal ? (receivedSignal === 'SIGINT' ? 130 : 143) : result.exitCode ?? 1;
  } finally {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  }
}

async function waitForLlamaReady(host: string, modelId: string, timeoutMs: number, hasExited: () => boolean): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'server has not responded yet';
  let generationFailures = 0;
  while (Date.now() < deadline) {
    let attemptedGeneration = false;
    if (hasExited()) throw new Error(`llama-server exited before becoming ready (${lastError}).`);
    try {
      const status = await ADAPTERS.llamacpp.detect(host, { timeoutMs: 2_000 });
      if (status.reachable) {
        const models = await ADAPTERS.llamacpp.listModels(host, { timeoutMs: 2_000 });
        const expected = normalizeModelName(modelId);
        if (!models.some((model) => normalizeModelName(model.name) === expected)) {
          lastError = `expected model '${modelId}' is not present in /v1/models`;
        } else {
          attemptedGeneration = true;
          const result = await ADAPTERS.llamacpp.generate({
            profileId: 'local-startup-qualification',
            runtime: 'llamacpp',
            host,
            model: modelId,
            prompt: 'Reply with OK.',
            timeoutMs: Math.min(30_000, Math.max(2_000, deadline - Date.now())),
            maxOutputTokens: 16,
          });
          if (!result.text.trim()) throw new Error('deterministic generation returned an empty response');
          return;
        }
      } else {
        lastError = status.message ?? 'health endpoint is not ready';
      }
    } catch (cause) {
      lastError = (cause as Error).message;
      if (attemptedGeneration) generationFailures += 1;
    }
    if (generationFailures >= 3) throw new Error(`model loaded but startup generation failed 3 times (${lastError}).`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error(`timed out after ${timeoutMs} ms (${lastError}).`);
}

function normalizeModelName(value: string): string {
  return value.trim().toLowerCase().replace(/:latest$/, '');
}

function canBind(host: string, port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolvePromise(false));
    server.listen({ host, port, exclusive: true }, () => server.close(() => resolvePromise(true)));
  });
}

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
