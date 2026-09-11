import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { buildHardwareProfile } from '../../src/local/hardware.js';
import {
  assessModel,
  discoverModelPacks,
  importModelPack,
  parseModelPackManifest,
  selectRuntimeArtifact,
} from '../../src/local/model-packs.js';

const GB = 1024 ** 3;
const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ai-dispatcher-model-pack-'));
  roots.push(root);
  return root;
}

function hardware(ramGB = 16, instructionSets: string[] = []) {
  return buildHardwareProfile({ os: 'windows', arch: 'x64', totalMemoryBytes: ramGB * GB, availableMemoryBytes: ramGB * GB, instructionSets });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('offline model packs', () => {
  it('assesses a manifest-declared CPU model as READY without a GPU', () => {
    const root = tempRoot();
    const packDirectory = join(root, 'cpu-standard');
    mkdirSync(packDirectory, { recursive: true });
    const file = join(packDirectory, 'small.gguf');
    writeFileSync(file, 'test-model');
    const hash = createHash('sha256').update('test-model').digest('hex');
    const pack = parseModelPackManifest({
      schemaVersion: '1', packId: 'cpu-standard', guaranteedBaseline: true,
      models: [{ id: 'small', file: 'small.gguf', roles: ['coding'], minimumRamGB: 8, recommendedRamGB: 16, gpuRequired: false, sha256: hash, license: 'Apache-2.0' }],
    });
    expect(assessModel(packDirectory, pack, pack.models[0]!, hardware(), 'CPU_STANDARD')).toMatchObject({ status: 'READY', installed: true });
  });

  it('never selects an AVX runtime when ISA is unknown, but selects generic CPU', () => {
    const artifacts = [
      { schemaVersion: '1' as const, runtimeId: 'cpu-avx2', acceleration: 'cpu' as const, os: 'windows', arch: 'x64', executable: 'server.exe', requiredInstructionSets: ['AVX2'] },
      { schemaVersion: '1' as const, runtimeId: 'cpu-generic', acceleration: 'cpu' as const, os: 'windows', arch: 'x64', executable: 'server.exe' },
    ];
    expect(selectRuntimeArtifact(hardware(), artifacts).selected?.runtimeId).toBe('cpu-generic');
    expect(selectRuntimeArtifact(hardware(16, ['AVX2']), artifacts).selected?.runtimeId).toBe('cpu-avx2');
  });

  it('reports CPU_INSTRUCTION_SET_UNSUPPORTED if only unsafe CPU artifacts exist', () => {
    const result = selectRuntimeArtifact(hardware(), [{
      schemaVersion: '1', runtimeId: 'cpu-avx2', acceleration: 'cpu', os: 'windows', arch: 'x64', executable: 'server.exe', requiredInstructionSets: ['AVX2'],
    }]);
    expect(result.code).toBe('CPU_INSTRUCTION_SET_UNSUPPORTED');
  });

  it('prefers a Metal artifact on Apple Silicon and rejects it without a Metal backend', () => {
    const artifact = {
      schemaVersion: '1' as const,
      runtimeId: 'llamacpp-metal-macos-arm64',
      acceleration: 'metal' as const,
      os: 'darwin',
      arch: 'arm64',
      executable: 'bin/llama-server',
    };
    const apple = buildHardwareProfile({
      os: 'darwin', arch: 'arm64', totalMemoryBytes: 32 * GB, availableMemoryBytes: 24 * GB,
      gpu: { vendor: 'Apple', model: 'Apple M-series', memoryBytes: 32 * GB, backends: ['metal'] }, integratedGpu: true,
    });
    const cpuOnly = buildHardwareProfile({ os: 'darwin', arch: 'arm64', totalMemoryBytes: 32 * GB, availableMemoryBytes: 24 * GB });

    expect(selectRuntimeArtifact(apple, [artifact]).selected?.runtimeId).toBe('llamacpp-metal-macos-arm64');
    expect(selectRuntimeArtifact(cpuOnly, [artifact]).selected).toBeUndefined();
  });

  it('imports a pre-downloaded pack only after digest verification, with no downloader', () => {
    const root = tempRoot();
    const source = join(root, 'source');
    const destination = join(root, 'models');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'tiny.gguf'), 'offline-only');
    const hash = createHash('sha256').update('offline-only').digest('hex');
    writeFileSync(join(source, 'model-pack.json'), JSON.stringify({
      schemaVersion: '1', packId: 'cpu-lite', models: [{ id: 'tiny', file: 'tiny.gguf', roles: ['coding'], minimumRamGB: 4, recommendedRamGB: 8, gpuRequired: false, sha256: hash, license: 'MIT' }],
    }));
    expect(importModelPack(source, destination, { requireLicenseMetadata: true })).toMatchObject({ packId: 'cpu-lite', verifiedModels: ['tiny'] });
    expect(discoverModelPacks(destination)[0]?.manifest?.packId).toBe('cpu-lite');
  });
});
