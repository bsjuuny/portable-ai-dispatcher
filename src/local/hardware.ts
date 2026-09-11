import { cpus, freemem, platform, totalmem, arch, availableParallelism } from 'node:os';
import { readFileSync, statfsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { AccelerationBackend, HardwareProfile, HardwareTier, HardwareTierThresholds } from '../models/local.js';

export const DEFAULT_HARDWARE_TIER_THRESHOLDS: HardwareTierThresholds = {
  cpuLiteMaxRamGB: 16,
  cpuStandardMinRamGB: 16,
  cpuPlusMinRamGB: 32,
  gpuStandardMinRamGB: 32,
  gpuStandardMinVramGB: 8,
  workstationMinRamGB: 64,
  workstationMinVramGB: 24,
};

export interface HardwareProbeInput {
  os?: string;
  arch?: string;
  cpuModel?: string;
  cores?: number;
  threads?: number;
  instructionSets?: string[];
  totalMemoryBytes?: number;
  availableMemoryBytes?: number;
  gpu?: HardwareProfile['gpu'];
  integratedGpu?: boolean;
  npu?: HardwareProfile['npu'];
  diskAvailableBytes?: number;
  warnings?: string[];
}

/**
 * Produces a profile from a supplied probe. This pure boundary is what tests and
 * offline installers use; an absent value remains unknown rather than becoming a
 * fabricated zero. In particular an empty ISA list means "not detected", never
 * "AVX unavailable".
 */
export function buildHardwareProfile(input: HardwareProbeInput = {}): HardwareProfile {
  return {
    os: normalizeOs(input.os ?? platform()),
    arch: normalizeArch(input.arch ?? arch()),
    cpu: {
      model: input.cpuModel,
      cores: input.cores,
      threads: input.threads,
      instructionSets: normalizeInstructionSets(input.instructionSets ?? []),
    },
    memory: { totalBytes: input.totalMemoryBytes, availableBytes: input.availableMemoryBytes },
    ...(input.gpu ? { gpu: input.gpu } : {}),
    ...(input.integratedGpu === undefined ? {} : { integratedGpu: input.integratedGpu }),
    ...(input.npu ? { npu: input.npu } : { npu: { available: false } }),
    ...(input.diskAvailableBytes === undefined ? {} : { disk: { availableBytes: input.diskAvailableBytes } }),
    detectedAt: new Date().toISOString(),
    warnings: input.warnings ?? [],
  };
}

/**
 * Best-effort, dependency-free detector. Linux ISA flags are exposed by
 * /proc/cpuinfo. Windows does not expose reliable ISA flags through Node's public
 * APIs, so it deliberately returns an empty set unless a deployment supplies the
 * audited AI_DISPATCHER_CPU_ISA override. Runtime selection then falls back to a
 * generic CPU artifact instead of guessing AVX2 and risking Illegal Instruction.
 */
export function detectHardwareProfile(root = process.cwd()): HardwareProfile {
  const osName = normalizeOs(platform());
  const architecture = normalizeArch(arch());
  const cpuInfo = cpus();
  const warnings: string[] = [];
  const instructionSets = detectInstructionSets(osName, warnings);
  const gpu = detectGpuFromEnvironment()
    ?? detectAppleSiliconGpu(osName, architecture);
  if (!gpu) warnings.push('GPU detection is unavailable without an optional platform probe; CPU remains selected.');
  let diskAvailableBytes: number | undefined;
  try {
    const fs = statfsSync(resolve(root));
    diskAvailableBytes = Number(fs.bavail) * Number(fs.bsize);
  } catch {
    warnings.push('Disk free space could not be detected.');
  }

  return buildHardwareProfile({
    os: osName,
    arch: architecture,
    cpuModel: cpuInfo[0]?.model?.trim() || process.env['PROCESSOR_IDENTIFIER'],
    cores: cpuInfo.length || undefined,
    threads: safeAvailableParallelism(),
    instructionSets,
    totalMemoryBytes: totalmem(),
    availableMemoryBytes: freemem(),
    ...(gpu ? { gpu: gpu.gpu, integratedGpu: gpu.integratedGpu } : {}),
    diskAvailableBytes,
    warnings,
  });
}

export function deriveHardwareTier(
  profile: HardwareProfile,
  thresholds: HardwareTierThresholds = DEFAULT_HARDWARE_TIER_THRESHOLDS,
): HardwareTier {
  const ramGB = bytesToGB(profile.memory.totalBytes);
  // Windows commonly exposes slightly less than installed RAM because firmware
  // reserves a portion (a nominal 32 GB machine can report about 31.3 GiB).
  // Tiers describe installed-memory classes, while model admission still uses
  // the precise total and currently available memory below.
  const tierRamGB = Math.ceil(ramGB);
  const vramGB = bytesToGB(profile.gpu?.memoryBytes);
  const hasDedicatedGpu = Boolean(profile.gpu && !profile.integratedGpu);

  // A large UMA machine can use its shared memory for inference.  A 64 GB
  // desktop with an entry-level dedicated GPU must not be promoted to the
  // workstation pack purely because of system RAM: its 8 GB VRAM is still the
  // limiting resource.
  if ((Boolean(profile.integratedGpu) && tierRamGB >= thresholds.workstationMinRamGB)
    || (hasDedicatedGpu && vramGB >= thresholds.workstationMinVramGB)) {
    return 'AI_WORKSTATION';
  }
  if (hasDedicatedGpu && tierRamGB >= thresholds.gpuStandardMinRamGB && vramGB >= thresholds.gpuStandardMinVramGB) {
    return 'GPU_STANDARD';
  }
  if (tierRamGB >= thresholds.cpuPlusMinRamGB) return 'CPU_PLUS';
  if (tierRamGB >= thresholds.cpuStandardMinRamGB) return 'CPU_STANDARD';
  return 'CPU_LITE';
}

export function hardwareFingerprint(profile: HardwareProfile): string {
  const material = JSON.stringify({
    os: profile.os,
    arch: profile.arch,
    cpu: profile.cpu,
    memory: profile.memory.totalBytes,
    gpu: profile.gpu,
  });
  return createHash('sha256').update(material).digest('hex');
}

export function effectiveCpuThreads(profile: HardwareProfile, policy: { maxThreads: number | 'auto'; reserveCores: number }): number {
  const available = profile.cpu.threads ?? profile.cpu.cores ?? 1;
  const cap = policy.maxThreads === 'auto' ? available : Math.min(available, policy.maxThreads);
  return Math.max(1, cap - Math.max(0, policy.reserveCores));
}

function detectInstructionSets(osName: string, warnings: string[]): string[] {
  const override = process.env['AI_DISPATCHER_CPU_ISA'];
  if (override) return normalizeInstructionSets(override.split(','));
  if (osName === 'darwin' && arch() === 'arm64') return ['NEON'];
  if (osName !== 'linux') {
    warnings.push('CPU ISA could not be determined without a deployment-provided probe; only generic CPU runtimes are safe to select.');
    return [];
  }
  try {
    const flags = readFileSync('/proc/cpuinfo', 'utf8').toLowerCase();
    const found: string[] = [];
    if (flags.includes('avx512')) found.push('AVX512');
    if (flags.includes('avx2')) found.push('AVX2');
    if (/(^|\s)avx(\s|$)/m.test(flags)) found.push('AVX');
    if (flags.includes('sse')) found.push('SSE');
    if (flags.includes(' neon') || flags.includes(' asimd')) found.push('NEON');
    return normalizeInstructionSets(found);
  } catch {
    warnings.push('CPU ISA probe failed; only generic CPU runtimes are safe to select.');
    return [];
  }
}

function detectGpuFromEnvironment(): { gpu: NonNullable<HardwareProfile['gpu']>; integratedGpu: boolean } | undefined {
  // Offline bundles may populate these during installation from an audited native
  // probe. They are optional hints; actual CUDA/Vulkan use still requires a runtime
  // qualification benchmark, so a spoofed value cannot force GPU-only execution.
  const vendor = process.env['AI_DISPATCHER_GPU_VENDOR'];
  const model = process.env['AI_DISPATCHER_GPU_MODEL'];
  const memoryBytes = parsePositiveInteger(process.env['AI_DISPATCHER_GPU_MEMORY_BYTES']);
  const backends = normalizeBackends(process.env['AI_DISPATCHER_GPU_BACKENDS']);
  if (!vendor && !model && !memoryBytes && backends.length === 0) return undefined;
  const normalizedVendor = vendor?.trim();
  return {
    gpu: { vendor: normalizedVendor, model: model?.trim(), memoryBytes, backends },
    integratedGpu: /intel|amd.*integrated|radeon graphics/i.test(`${normalizedVendor ?? ''} ${model ?? ''}`),
  };
}

function detectAppleSiliconGpu(osName: string, architecture: string): { gpu: NonNullable<HardwareProfile['gpu']>; integratedGpu: boolean } | undefined {
  if (osName !== 'darwin' || architecture !== 'arm64') return undefined;
  return {
    gpu: {
      vendor: 'Apple',
      model: cpus()[0]?.model?.trim() || 'Apple Silicon',
      memoryBytes: totalmem(),
      backends: ['metal'],
    },
    integratedGpu: true,
  };
}

function normalizeInstructionSets(values: string[]): string[] {
  const known = ['AVX512', 'AVX2', 'AVX', 'SSE', 'NEON'];
  const set = new Set(values.map((value) => value.trim().toUpperCase()).filter((value) => known.includes(value)));
  return known.filter((value) => set.has(value));
}

function normalizeBackends(raw: string | undefined): AccelerationBackend[] {
  const allowed: AccelerationBackend[] = ['cuda', 'vulkan', 'metal', 'cpu', 'npu'];
  const values = raw?.split(',').map((value) => value.trim().toLowerCase()) ?? [];
  return allowed.filter((value) => values.includes(value));
}

function normalizeOs(value: string): string {
  return value === 'win32' ? 'windows' : value;
}

function normalizeArch(value: string): string {
  if (value === 'x64' || value === 'amd64') return 'x64';
  if (value === 'arm64' || value === 'aarch64') return 'arm64';
  return value;
}

function bytesToGB(bytes: number | undefined): number {
  return bytes ? bytes / 1024 ** 3 : 0;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function safeAvailableParallelism(): number | undefined {
  try {
    return availableParallelism();
  } catch {
    return undefined;
  }
}
