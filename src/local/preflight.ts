import { existsSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import type { DispatcherConfig } from '../config/schema.js';
import type { HardwareTier, ModelUsability } from '../models/local.js';
import { verifyPortableKit } from './kit-integrity.js';
import { detectHardwareProfile, deriveHardwareTier, effectiveCpuThreads } from './hardware.js';
import {
  assessModel,
  discoverModelPacks,
  discoverRuntimeArtifacts,
  recommendedPackIds,
  selectRecommendedPack,
  selectRuntimeArtifact,
  verifyDeclaredSha256,
} from './model-packs.js';

export interface PreflightReport {
  hardware: ReturnType<typeof detectHardwareProfile>;
  tier: HardwareTier;
  cpuThreads: number;
  selectedRuntime: ReturnType<typeof selectRuntimeArtifact>;
  cpuBaselineRuntime: ReturnType<typeof selectRuntimeArtifact>;
  runtimeHash?: { verified: boolean; reason?: string };
  selectedRuntimeHash?: { verified: boolean; reason?: string };
  git: { available: boolean; source?: 'bundled' | 'path' };
  integrity?: { verified: boolean; reason?: string; fileCount?: number };
  modelPacks: Array<{ packId?: string; directory: string; error?: string }>;
  selectedPack?: string;
  models: Array<{ id: string; status: ModelUsability; reason: string; recommendedContextTokens?: number; hash?: { verified: boolean; reason?: string } }>;
  launchPlan?: {
    runtimeId: string;
    runtimePath: string;
    profileId: `local-${string}`;
    modelId: string;
    modelPath: string;
    contextTokens: number;
    cpuThreads: number;
    gpuLayers: number;
    host: string;
    port: number;
  };
  overall: { ready: boolean; mode: 'READY' | 'LIMITED' | 'NOT_READY'; reasons: string[] };
}

export function runOfflinePreflight(root: string, config: DispatcherConfig): PreflightReport {
  const hardware = detectHardwareProfile(root);
  const tier = deriveHardwareTier(hardware, config.local.hardware.tiers);
  const assetRoot = portableAssetRoot(root);
  const integrity = existsSync(join(assetRoot, 'portable-kit.json')) ? verifyPortableKit(assetRoot) : undefined;
  const runtimeRoot = resolve(assetRoot, config.local.bundle.runtimeDirectory);
  const packRoot = resolve(assetRoot, config.local.bundle.modelPacksDirectory);
  const runtimeEntries = discoverRuntimeArtifacts(runtimeRoot);
  const runtimeArtifacts = runtimeEntries
    .flatMap((entry) => entry.manifest ? [{ manifest: entry.manifest, directory: entry.directory }] : [])
    .filter((entry) => existsSync(join(entry.directory, entry.manifest.executable)));
  const artifacts = runtimeArtifacts.map((entry) => entry.manifest);
  const selectedRuntime = selectRuntimeArtifact(hardware, artifacts);
  const selectedRuntimeEntry = selectedRuntime.selected
    ? runtimeArtifacts.find((entry) => entry.manifest.runtimeId === selectedRuntime.selected!.runtimeId)
    : undefined;
  // Apple Silicon's Metal runtime is also its safe baseline: llama.cpp can use the
  // same executable with GPU layers disabled, and its GPU shares system memory.
  // Discarding that integrated adapter here would incorrectly make a complete Mac
  // kit NOT_READY just because it does not carry a second CPU-only binary.
  const baselineHardware = hardware.integratedGpu && hardware.gpu?.backends.includes('metal')
    ? hardware
    : { ...hardware, gpu: undefined, integratedGpu: false };
  const cpuBaselineRuntime = selectRuntimeArtifact(baselineHardware, artifacts);
  const cpuBaselineEntry = cpuBaselineRuntime.selected
    ? runtimeArtifacts.find((entry) => entry.manifest.runtimeId === cpuBaselineRuntime.selected!.runtimeId)
    : undefined;
  const runtimeHash = cpuBaselineEntry?.manifest.sha256
    ? verifyDeclaredSha256(join(cpuBaselineEntry.directory, cpuBaselineEntry.manifest.executable), cpuBaselineEntry.manifest.sha256)
    : undefined;
  const selectedRuntimeIsBaseline = selectedRuntimeEntry !== undefined
    && selectedRuntimeEntry.directory === cpuBaselineEntry?.directory
    && selectedRuntimeEntry.manifest.executable === cpuBaselineEntry.manifest.executable;
  const selectedRuntimeHash = selectedRuntimeIsBaseline
    ? runtimeHash
    : selectedRuntimeEntry?.manifest.sha256
      ? verifyDeclaredSha256(join(selectedRuntimeEntry.directory, selectedRuntimeEntry.manifest.executable), selectedRuntimeEntry.manifest.sha256)
      : undefined;
  const git = detectGitAvailability(runtimeRoot);
  const configuredHost = config.local.runtimes.llamacpp.host;
  const parsedHost = safeHttpUrl(configuredHost);
  const modelPacks = discoverModelPacks(packRoot);
  let selectedPack = selectRecommendedPack(tier, modelPacks);
  const assessPack = (pack: typeof selectedPack) => {
    if (!pack?.manifest) return [];
    const manifest = pack.manifest;
    return manifest.models.map((model) => {
      const assessed = assessModel(pack.directory, manifest, model, hardware, tier, {
        requireLicenseMetadata: config.local.bundle.requireModelLicenseMetadata,
      });
      const hash = model.sha256 ? verifyDeclaredSha256(join(pack.directory, model.file), model.sha256) : undefined;
      return {
        id: model.id,
        status: assessed.status,
        reason: hash && !hash.verified ? `${assessed.reason} ${hash.reason}` : assessed.reason,
        recommendedContextTokens: assessed.recommendedContextTokens,
        ...(hash ? { hash: { verified: hash.verified, ...(hash.reason ? { reason: hash.reason } : {}) } } : {}),
      };
    });
  };
  let models = assessPack(selectedPack);
  const usableStatus = (status: ModelUsability) => status === 'READY_FAST' || status === 'READY' || status === 'READY_SLOW';
  if (!models.some((model) => usableStatus(model.status))) {
    for (const packId of recommendedPackIds(tier)) {
      const candidate = modelPacks.find((pack) => pack.manifest?.packId === packId);
      if (!candidate?.manifest || candidate === selectedPack) continue;
      const candidateModels = assessPack(candidate);
      if (candidateModels.some((model) => usableStatus(model.status))) {
        selectedPack = candidate;
        models = candidateModels;
        break;
      }
    }
  }
  const usableModelReport = models.find((model) => usableStatus(model.status));
  const usable = Boolean(usableModelReport);
  const usableModel = usableModelReport && selectedPack?.manifest
    ? selectedPack.manifest.models.find((model) => model.id === usableModelReport.id)
    : undefined;
  const configuredProfile = usableModel
    ? config.local.profiles.find((profile) => profile.runtime === 'llamacpp' && profile.model === usableModel.id)
    : undefined;

  const reasons = [...hardware.warnings];
  if (!cpuBaselineRuntime.selected) reasons.push(cpuBaselineRuntime.reason);
  if (runtimeHash && !runtimeHash.verified) reasons.push(`Selected CPU runtime failed integrity verification: ${runtimeHash.reason ?? 'unknown error'}`);
  if (selectedRuntimeHash && !selectedRuntimeHash.verified) reasons.push(`Selected accelerated runtime failed integrity verification: ${selectedRuntimeHash.reason ?? 'unknown error'}`);
  if (!git.available) reasons.push('git was not found (checked runtime/git and system PATH); it is required to isolate every task in a worktree before dispatch.');
  if (integrity && !integrity.verified) reasons.push(`Portable kit integrity verification failed: ${integrity.reason ?? 'unknown error'}`);
  if (!parsedHost) reasons.push(`llama.cpp host must be an HTTP loopback URL with a valid port, not '${configuredHost}'.`);
  if (!selectedPack?.manifest) reasons.push('No compatible local model pack was found; automatic downloads are disabled.');
  if (!usable && selectedPack?.manifest) reasons.push('Selected model pack has no model that fits current memory and accelerator constraints.');
  if (usableModel && !configuredProfile) reasons.push(`Selected model '${usableModel.id}' has no matching enabled llama.cpp profile, so no launch plan can be created.`);
  if (!selectedRuntimeEntry) reasons.push('No executable runtime was selected for the launch plan.');
  const runtimeIntegrityReady = config.local.bundle.offlineKitRequired
    ? runtimeHash?.verified === true && selectedRuntimeHash?.verified === true
    : (!runtimeHash || runtimeHash.verified) && (!selectedRuntimeHash || selectedRuntimeHash.verified);
  const modelIntegrityReady = config.local.bundle.offlineKitRequired ? usableModelReport?.hash?.verified === true : true;
  if (config.local.bundle.offlineKitRequired && !runtimeIntegrityReady) reasons.push('Offline kit runtime must declare and pass SHA-256 verification.');
  if (config.local.bundle.offlineKitRequired && usable && !modelIntegrityReady) reasons.push('Offline kit selected model must declare and pass SHA-256 verification.');
  const mandatoryReady = Boolean(cpuBaselineRuntime.selected)
    && runtimeIntegrityReady
    && modelIntegrityReady
    && (!integrity || integrity.verified)
    && git.available
    && usable
    && Boolean(configuredProfile)
    && Boolean(selectedRuntimeEntry)
    && Boolean(parsedHost);
  // A report must never claim READY/LIMITED for an installed model that local
  // start cannot actually launch. Non-offline setups may legitimately have no
  // pack at all (for example, an already-running Ollama server), but once a pack
  // is selected its launch prerequisites are the source of truth in every mode.
  const launchReady = usable
    && Boolean(configuredProfile)
    && Boolean(selectedRuntimeEntry)
    && Boolean(parsedHost)
    && runtimeIntegrityReady;
  const ready = config.local.bundle.offlineKitRequired
    ? mandatoryReady
    : selectedPack?.manifest
      ? launchReady
      : true;
  const mode = ready ? (mandatoryReady ? 'READY' : 'LIMITED') : 'NOT_READY';
  const cpuThreads = effectiveCpuThreads(hardware, config.local.cpu);
  const launchPlan = ready && usableModel && usableModelReport && configuredProfile && selectedPack && selectedRuntimeEntry && parsedHost
    ? {
      runtimeId: selectedRuntimeEntry.manifest.runtimeId,
      runtimePath: join(selectedRuntimeEntry.directory, selectedRuntimeEntry.manifest.executable),
      profileId: `local-${configuredProfile.name}` as const,
      modelId: usableModel.id,
      modelPath: join(selectedPack.directory, usableModel.file),
      contextTokens: Math.min(
        usableModelReport.recommendedContextTokens ?? configuredContextBudget(tier, config),
        usableModel.maxContextTokens ?? Number.MAX_SAFE_INTEGER,
      ),
      cpuThreads,
      gpuLayers: selectedRuntimeEntry.manifest.acceleration === 'cpu' ? 0 : 99,
      host: parsedHost.hostname === '[::1]' ? '::1' : parsedHost.hostname,
      port: parsedHost.port ? Number(parsedHost.port) : 8080,
    }
    : undefined;

  return {
    hardware,
    tier,
    cpuThreads,
    selectedRuntime,
    cpuBaselineRuntime,
    ...(runtimeHash ? { runtimeHash: { verified: runtimeHash.verified, ...(runtimeHash.reason ? { reason: runtimeHash.reason } : {}) } } : {}),
    ...(selectedRuntimeHash ? { selectedRuntimeHash: { verified: selectedRuntimeHash.verified, ...(selectedRuntimeHash.reason ? { reason: selectedRuntimeHash.reason } : {}) } } : {}),
    git,
    ...(integrity ? { integrity } : {}),
    modelPacks: modelPacks.map((pack) => ({ packId: pack.manifest?.packId, directory: pack.directory, ...(pack.error ? { error: pack.error } : {}) })),
    ...(selectedPack?.manifest ? { selectedPack: selectedPack.manifest.packId } : {}),
    models,
    ...(launchPlan ? { launchPlan } : {}),
    overall: { ready, mode, reasons },
  };
}

function safeHttpUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
    const port = Number(url.port || '8080');
    const plainOrigin = !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
    return url.protocol === 'http:' && loopback && plainOrigin
      && Number.isInteger(port) && port >= 1 && port <= 65_535
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every dispatch isolates the task in a git worktree before executing it (see
 * safety/workspace.ts), so git is a hard requirement, not an optional nicety - an
 * air-gapped machine has no other way to get it than the kit's own runtime/git.
 * `%PATH%` is checked directly (rather than spawning `git --version`) because the
 * portable launcher already prepends runtime/git/cmd to PATH when present, so a
 * single synchronous scan covers both the bundled copy and a pre-existing system
 * install without adding an async process spawn to a currently-sync report.
 */
function detectGitAvailability(runtimeRoot: string): PreflightReport['git'] {
  const bundled = process.platform === 'win32'
    ? join(runtimeRoot, 'git', 'cmd', 'git.exe')
    : join(runtimeRoot, 'git', 'bin', 'git');
  if (existsSync(bundled)) return { available: true, source: 'bundled' };

  const exeNames = process.platform === 'win32' ? ['git.exe', 'git.cmd'] : ['git'];
  const pathDirs = (process.env['PATH'] ?? '').split(delimiter).filter(Boolean);
  const onPath = pathDirs.some((dir) => exeNames.some((exe) => existsSync(join(dir, exe))));
  return onPath ? { available: true, source: 'path' } : { available: false };
}

/** Portable launchers point this at the USB kit. Project working directories
 * still own history and task files, while large models/runtimes stay on USB. */
export function portableAssetRoot(projectRoot: string): string {
  return resolve(process.env['AI_DISPATCHER_PORTABLE_ROOT'] || projectRoot);
}

/** Kept here for callers that need a task-sized CPU context instead of a model maximum. */
export function configuredContextBudget(tier: HardwareTier, config: DispatcherConfig): number {
  const budget = config.local.contextBudget;
  switch (tier) {
    case 'CPU_LITE': return budget.cpuLite;
    case 'CPU_STANDARD': return budget.cpuStandard;
    case 'CPU_PLUS': return budget.cpuPlus;
    case 'GPU_STANDARD': return budget.gpuStandard;
    case 'AI_WORKSTATION': return budget.workstation;
  }
}
