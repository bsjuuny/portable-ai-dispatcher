import { describe, expect, it } from 'vitest';
import { buildHardwareProfile, deriveHardwareTier, effectiveCpuThreads } from '../../src/local/hardware.js';

const GB = 1024 ** 3;

function profile(ramGB: number, options: Parameters<typeof buildHardwareProfile>[0] = {}) {
  return buildHardwareProfile({ totalMemoryBytes: ramGB * GB, availableMemoryBytes: ramGB * GB, cores: 8, threads: 16, ...options });
}

describe('hardware tiers', () => {
  it.each([
    [8, 'CPU_LITE'],
    [16, 'CPU_STANDARD'],
    [32, 'CPU_PLUS'],
  ] as const)('classifies CPU-only %s GB as %s', (ramGB, expected) => {
    expect(deriveHardwareTier(profile(ramGB))).toBe(expected);
  });

  it('keeps a 64 GB machine with an 8 GB discrete GPU in GPU_STANDARD', () => {
    expect(deriveHardwareTier(profile(64, {
      gpu: { vendor: 'NVIDIA', model: 'RTX 5060', memoryBytes: 8 * GB, backends: ['cuda', 'vulkan'] },
      integratedGpu: false,
    }))).toBe('GPU_STANDARD');
  });

  it('classifies a 128 GB UMA system as AI_WORKSTATION', () => {
    expect(deriveHardwareTier(profile(128, {
      gpu: { vendor: 'AMD', model: 'UMA', memoryBytes: 128 * GB, backends: ['vulkan'] },
      integratedGpu: true,
    }))).toBe('AI_WORKSTATION');
  });

  it('keeps CPU ISA unknown rather than pretending an instruction set is absent', () => {
    expect(profile(16).cpu.instructionSets).toEqual([]);
  });

  it('reserves IDE/build capacity from a CPU inference thread budget', () => {
    expect(effectiveCpuThreads(profile(16), { maxThreads: 'auto', reserveCores: 2 })).toBe(14);
    expect(effectiveCpuThreads(profile(16), { maxThreads: 4, reserveCores: 8 })).toBe(1);
  });
});
