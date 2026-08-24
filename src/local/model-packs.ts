import { createHash } from 'node:crypto';
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type {
  HardwareProfile,
  HardwareTier,
  ModelPackManifest,
  ModelPackModel,
  ModelUsability,
  RuntimeArtifactManifest,
} from '../models/local.js';

const HardwareTierSchema = z.enum(['CPU_LITE', 'CPU_STANDARD', 'CPU_PLUS', 'GPU_STANDARD', 'AI_WORKSTATION']);
const ModelPackManifestSchema = z.object({
  schemaVersion: z.literal('1'),
  packId: z.string().min(1),
  packVersion: z.string().min(1).optional(),
  minimumDispatcherVersion: z.string().min(1).optional(),
  guaranteedBaseline: z.boolean().optional(),
  models: z.array(z.object({
    id: z.string().min(1),
    file: z.string().min(1),
    roles: z.array(z.string().min(1)).min(1),
    minimumRamGB: z.number().positive(),
    recommendedRamGB: z.number().positive(),
    gpuRequired: z.boolean(),
    minimumVramGB: z.number().positive().optional(),
    sha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
    maxContextTokens: z.number().int().positive().optional(),
    recommendedContext: z.record(HardwareTierSchema, z.number().int().positive()).optional(),
    license: z.string().min(1).optional(),
    licenseFile: z.string().min(1).optional(),
    source: z.string().min(1).optional(),
    commercialUseMetadata: z.string().min(1).optional(),
    redistributionMetadata: z.string().min(1).optional(),
  })).min(1),
});

const RuntimeArtifactManifestSchema = z.object({
  schemaVersion: z.literal('1'),
  runtimeId: z.string().min(1),
  acceleration: z.enum(['cpu', 'vulkan', 'cuda', 'npu']),
  os: z.string().min(1),
  arch: z.string().min(1),
  executable: z.string().min(1),
  requiredInstructionSets: z.array(z.enum(['AVX512', 'AVX2', 'AVX', 'SSE', 'NEON'])).optional(),
  version: z.string().min(1).optional(),
  sha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
});

export interface DiscoveredModelPack {
  directory: string;
  manifest?: ModelPackManifest;
  error?: string;
}

export interface ModelAssessment {
  packId: string;
  model: ModelPackModel;
  status: ModelUsability;
  reason: string;
  recommendedContextTokens?: number;
  installed: boolean;
  licenseMetadataPresent: boolean;
}

export interface RuntimeSelection {
  selected?: RuntimeArtifactManifest;
  fallbackChain: Array<'cuda' | 'vulkan' | 'cpu'>;
  reason: string;
  code?: 'CPU_RUNTIME_UNSUPPORTED' | 'CPU_INSTRUCTION_SET_UNSUPPORTED';
}

export interface ImportedModelPack {
  packId: string;
  destination: string;
  verifiedModels: string[];
}

export function discoverModelPacks(root: string): DiscoveredModelPack[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const directory = join(root, entry.name);
      try {
        return { directory, manifest: parseModelPackManifest(readJson(join(directory, 'model-pack.json'))) };
      } catch (cause) {
        return { directory, error: (cause as Error).message };
      }
    });
}

export function parseModelPackManifest(raw: unknown): ModelPackManifest {
  return ModelPackManifestSchema.parse(raw);
}

export function parseRuntimeArtifactManifest(raw: unknown): RuntimeArtifactManifest {
  return RuntimeArtifactManifestSchema.parse(raw);
}

export function discoverRuntimeArtifacts(root: string): Array<{ directory: string; manifest?: RuntimeArtifactManifest; error?: string }> {
  if (!existsSync(root)) return [];
  const manifests = findFiles(root, 'runtime-manifest.json');
  return manifests.map((path) => {
    try {
      return { directory: resolve(path, '..'), manifest: parseRuntimeArtifactManifest(readJson(path)) };
    } catch (cause) {
      return { directory: resolve(path, '..'), error: (cause as Error).message };
    }
  });
}

export function selectRuntimeArtifact(
  profile: HardwareProfile,
  artifacts: RuntimeArtifactManifest[],
): RuntimeSelection {
  const candidates = artifacts.filter((artifact) => artifact.os === profile.os && artifact.arch === profile.arch);
  const order: Array<'cuda' | 'vulkan' | 'cpu'> = ['cuda', 'vulkan', 'cpu'];
  for (const acceleration of order) {
    const matching = candidates.filter((artifact) => artifact.acceleration === acceleration && runtimeCompatible(profile, artifact));
    const selected = matching.sort(compareRuntimeSpecificity)[0];
    if (selected) {
      return { selected, fallbackChain: order, reason: `${acceleration.toUpperCase()} artifact is compatible with this hardware profile.` };
    }
  }
  const cpuArtifacts = candidates.filter((artifact) => artifact.acceleration === 'cpu');
  if (cpuArtifacts.length > 0) {
    return {
      fallbackChain: order,
      reason: 'CPU artifacts exist but all require instruction sets that could not be proven available.',
      code: 'CPU_INSTRUCTION_SET_UNSUPPORTED',
    };
  }
  return {
    fallbackChain: order,
    reason: 'No compatible CPU runtime artifact is present in the offline bundle.',
    code: 'CPU_RUNTIME_UNSUPPORTED',
  };
}

export function assessModel(
  packDirectory: string,
  pack: ModelPackManifest,
  model: ModelPackModel,
  profile: HardwareProfile,
  tier: HardwareTier,
  options: { requireLicenseMetadata?: boolean; slowRamMultiplier?: number } = {},
): ModelAssessment {
  const totalRamGB = bytesToGB(profile.memory.totalBytes);
  const availableRamGB = bytesToGB(profile.memory.availableBytes);
  const vramGB = bytesToGB(profile.gpu?.memoryBytes);
  const installed = isContainedFile(packDirectory, model.file) && existsSync(resolve(packDirectory, model.file));
  const licenseMetadataPresent = Boolean(model.license || model.licenseFile || model.source);
  const slowMultiplier = options.slowRamMultiplier ?? 0.8;

  if (!installed) return assessment(pack, model, 'UNSUPPORTED', 'Model file is not present in this offline model pack.', undefined, installed, licenseMetadataPresent);
  if (options.requireLicenseMetadata && !licenseMetadataPresent) {
    return assessment(pack, model, 'SUPPORTED_BUT_NOT_RECOMMENDED', 'Model has no license/source metadata required by local policy.', undefined, installed, licenseMetadataPresent);
  }
  if (model.gpuRequired && (!profile.gpu || vramGB < (model.minimumVramGB ?? 1))) {
    return assessment(pack, model, 'UNSUPPORTED', 'Model requires GPU memory unavailable on this machine.', undefined, installed, licenseMetadataPresent);
  }
  if (totalRamGB < model.minimumRamGB || availableRamGB < Math.min(model.minimumRamGB, totalRamGB * 0.35)) {
    return assessment(pack, model, 'UNSUPPORTED', 'Insufficient total or available RAM for safe model loading.', undefined, installed, licenseMetadataPresent);
  }

  const context = model.recommendedContext?.[tier] ?? model.maxContextTokens;
  if (totalRamGB >= model.recommendedRamGB) {
    const fast = !model.gpuRequired && tier === 'CPU_LITE' && model.recommendedRamGB <= 16
      ? 'READY_FAST'
      : totalRamGB >= model.recommendedRamGB * 1.35 ? 'READY_FAST' : 'READY';
    return assessment(pack, model, fast, 'Memory fit is within the model pack recommendation.', context, installed, licenseMetadataPresent);
  }
  if (totalRamGB >= model.minimumRamGB / slowMultiplier) {
    return assessment(pack, model, 'READY_SLOW', 'Model can run but is below its recommended RAM; CPU latency may be high.', context, installed, licenseMetadataPresent);
  }
  return assessment(pack, model, 'SUPPORTED_BUT_NOT_RECOMMENDED', 'Model is installable but expected to contend with IDE/build resources.', context, installed, licenseMetadataPresent);
}

export function selectRecommendedPack(tier: HardwareTier, packs: DiscoveredModelPack[]): DiscoveredModelPack | undefined {
  const available = packs.filter((pack): pack is DiscoveredModelPack & { manifest: ModelPackManifest } => Boolean(pack.manifest));
  for (const packId of recommendedPackIds(tier)) {
    const selected = available.find((pack) => pack.manifest.packId === packId);
    if (selected) return selected;
  }
  return available.find((pack) => pack.manifest.guaranteedBaseline) ?? available[0];
}

/** Pack order is shared by preflight so it can safely fall back to a smaller
 * installed CPU pack when the preferred one cannot fit currently free RAM. */
export function recommendedPackIds(tier: HardwareTier): string[] {
  const preference: Record<HardwareTier, string[]> = {
    CPU_LITE: ['cpu-lite'],
    CPU_STANDARD: ['cpu-standard', 'cpu-lite'],
    CPU_PLUS: ['cpu-plus', 'cpu-standard', 'cpu-lite'],
    GPU_STANDARD: ['gpu-standard', 'cpu-plus', 'cpu-standard', 'cpu-lite'],
    AI_WORKSTATION: ['workstation', 'gpu-standard', 'cpu-plus', 'cpu-standard', 'cpu-lite'],
  };
  return preference[tier];
}

export function verifyDeclaredSha256(path: string, expected: string | undefined): { verified: boolean; actual?: string; reason?: string } {
  if (!expected) return { verified: false, reason: 'No SHA-256 declared in manifest.' };
  if (!existsSync(path)) return { verified: false, reason: 'Declared file is missing.' };
  const hash = createHash('sha256');
  const descriptor = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    closeSync(descriptor);
  }
  const actual = hash.digest('hex');
  return actual.toLowerCase() === expected.toLowerCase()
    ? { verified: true, actual }
    : { verified: false, actual, reason: 'SHA-256 does not match manifest.' };
}

/**
 * Imports an already-downloaded model pack.  This intentionally has no network
 * path: an operator supplies the source directory, manifests are parsed before
 * copying, and every model that declares a digest is verified first.
 */
export function importModelPack(
  sourceDirectory: string,
  modelsRoot: string,
  options: { requireLicenseMetadata?: boolean } = {},
): ImportedModelPack {
  const source = resolve(sourceDirectory);
  const manifest = parseModelPackManifest(readJson(join(source, 'model-pack.json')));
  const verifiedModels: string[] = [];
  for (const model of manifest.models) {
    if (!isContainedFile(source, model.file) || !existsSync(resolve(source, model.file))) {
      throw new Error(`Model '${model.id}' references a missing or unsafe file path.`);
    }
    const licenseMetadataPresent = Boolean(model.license || model.licenseFile || model.source);
    if (options.requireLicenseMetadata && !licenseMetadataPresent) {
      throw new Error(`Model '${model.id}' is missing license/source metadata required by local policy.`);
    }
    if (model.sha256) {
      const result = verifyDeclaredSha256(resolve(source, model.file), model.sha256);
      if (!result.verified) throw new Error(`Model '${model.id}' failed SHA-256 verification: ${result.reason ?? 'unknown error'}`);
      verifiedModels.push(model.id);
    }
  }
  const destination = resolve(modelsRoot, manifest.packId);
  if (!isContainedFile(modelsRoot, manifest.packId)) throw new Error('Model pack id resolves outside the configured model directory.');
  if (existsSync(destination)) throw new Error(`Destination already exists: ${destination}`);
  mkdirSync(resolve(modelsRoot), { recursive: true });
  cpSync(source, destination, { recursive: true, errorOnExist: true });
  return { packId: manifest.packId, destination, verifiedModels };
}

function runtimeCompatible(profile: HardwareProfile, artifact: RuntimeArtifactManifest): boolean {
  if (artifact.acceleration === 'cuda' && !profile.gpu?.backends.includes('cuda')) return false;
  if (artifact.acceleration === 'vulkan' && !profile.gpu?.backends.includes('vulkan')) return false;
  const required = artifact.requiredInstructionSets ?? [];
  if (required.length === 0) return true;
  return required.every((instructionSet) => profile.cpu.instructionSets.includes(instructionSet));
}

function compareRuntimeSpecificity(a: RuntimeArtifactManifest, b: RuntimeArtifactManifest): number {
  return (b.requiredInstructionSets?.length ?? 0) - (a.requiredInstructionSets?.length ?? 0);
}

function assessment(
  pack: ModelPackManifest,
  model: ModelPackModel,
  status: ModelUsability,
  reason: string,
  recommendedContextTokens: number | undefined,
  installed: boolean,
  licenseMetadataPresent: boolean,
): ModelAssessment {
  return { packId: pack.packId, model, status, reason, recommendedContextTokens, installed, licenseMetadataPresent };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function findFiles(root: string, filename: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...findFiles(path, filename));
    else if (entry.isFile() && entry.name === filename) result.push(path);
  }
  return result;
}

function isContainedFile(root: string, file: string): boolean {
  const target = resolve(root, file);
  const rel = relative(resolve(root), target);
  return !rel.startsWith(`..${sep}`) && rel !== '..' && !rel.includes(`..${sep}`);
}

function bytesToGB(bytes: number | undefined): number {
  return bytes ? bytes / 1024 ** 3 : 0;
}
