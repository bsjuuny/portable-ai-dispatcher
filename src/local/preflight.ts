import { existsSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import type { DispatcherConfig } from '../config/schema.js';
import type { HardwareTier, ModelUsability } from '../models/local.js';
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
  git: { available: boolean; source?: 'bundled' | 'path' };
  modelPacks: Array<{ packId?: string; directory: string; error?: string }>;
  selectedPack?: string;
  models: Array<{ id: string; status: ModelUsability; reason: string; recommendedContextTokens?: number; hash?: { verified: boolean; reason?: string } }>;
  overall: { ready: boolean; mode: 'READY' | 'LIMITED' | 'NOT_READY'; reasons: string[] };
}

export function runOfflinePreflight(root: string, config: DispatcherConfig): PreflightReport {
  const hardware = detectHardwareProfile(root);
  const tier = deriveHardwareTier(hardware, config.local.hardware.tiers);
  const assetRoot = portableAssetRoot(root);
  const runtimeRoot = resolve(assetRoot, config.local.bundle.runtimeDirectory);
  const packRoot = resolve(assetRoot, config.local.bundle.modelPacksDirectory);
  const runtimeEntries = discoverRuntimeArtifacts(runtimeRoot);
  const runtimeArtifacts = runtimeEntries
    .flatMap((entry) => entry.manifest ? [{ manifest: entry.manifest, directory: entry.directory }] : [])
    .filter((entry) => existsSync(join(entry.directory, entry.manifest.executable)));
  const artifacts = runtimeArtifacts.map((entry) => entry.manifest);
  const selectedRuntime = selectRuntimeArtifact(hardware, artifacts);
  const cpuBaselineRuntime = selectRuntimeArtifact({ ...hardware, gpu: undefined, integratedGpu: false }, artifacts);
  const cpuBaselineEntry = cpuBaselineRuntime.selected
    ? runtimeArtifacts.find((entry) => entry.manifest.runtimeId === cpuBaselineRuntime.selected!.runtimeId)
    : undefined;
  const runtimeHash = cpuBaselineEntry?.manifest.sha256
    ? verifyDeclaredSha256(join(cpuBaselineEntry.directory, cpuBaselineEntry.manifest.executable), cpuBaselineEntry.manifest.sha256)
    : undefined;
  const git = detectGitAvailability(runtimeRoot);
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

  const reasons = [...hardware.warnings];
  if (!cpuBaselineRuntime.selected) reasons.push(cpuBaselineRuntime.reason);
  if (runtimeHash && !runtimeHash.verified) reasons.push(`Selected CPU runtime failed integrity verification: ${runtimeHash.reason ?? 'unknown error'}`);
  if (!git.available) reasons.push('git was not found (checked runtime/git and system PATH); it is required to isolate every task in a worktree before dispatch.');
  if (!selectedPack?.manifest) reasons.push('No compatible local model pack was found; automatic downloads are disabled.');
  const usable = models.some((model) => usableStatus(model.status));
  if (!usable && selectedPack?.manifest) reasons.push('Selected model pack has no model that fits current memory and accelerator constraints.');
  const mandatoryReady = Boolean(cpuBaselineRuntime.selected) && (!runtimeHash || runtimeHash.verified) && git.available && usable;
  const ready = config.local.bundle.offlineKitRequired ? mandatoryReady : usable || !selectedPack?.manifest;
  const mode = ready ? (mandatoryReady ? 'READY' : 'LIMITED') : 'NOT_READY';

  return {
    hardware,
    tier,
    cpuThreads: effectiveCpuThreads(hardware, config.local.cpu),
    selectedRuntime,
    cpuBaselineRuntime,
    ...(runtimeHash ? { runtimeHash: { verified: runtimeHash.verified, ...(runtimeHash.reason ? { reason: runtimeHash.reason } : {}) } } : {}),
    git,
    modelPacks: modelPacks.map((pack) => ({ packId: pack.manifest?.packId, directory: pack.directory, ...(pack.error ? { error: pack.error } : {}) })),
    ...(selectedPack?.manifest ? { selectedPack: selectedPack.manifest.packId } : {}),
    models,
    overall: { ready, mode, reasons },
  };
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
