import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/schema.js';
import { sealPortableKit } from '../../src/local/kit-integrity.js';
import { parseModelPackManifest, parseRuntimeArtifactManifest } from '../../src/local/model-packs.js';
import { runOfflinePreflight } from '../../src/local/preflight.js';

const roots: string[] = [];
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('preflight launch plan', () => {
  it('uses the selected manifests for runtime, model, context and alias identity', () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-dispatcher-plan-'));
    roots.push(root);
    const runtimeDirectory = join(root, 'runtime', 'llamacpp');
    const gitDirectory = process.platform === 'win32' ? join(root, 'runtime', 'git', 'cmd') : join(root, 'runtime', 'git', 'bin');
    const modelDirectory = join(root, 'models', 'cpu-lite');
    mkdirSync(runtimeDirectory, { recursive: true });
    mkdirSync(gitDirectory, { recursive: true });
    mkdirSync(modelDirectory, { recursive: true });
    writeFileSync(join(root, 'portable-kit.json'), JSON.stringify({ target: `${process.platform}-${process.arch}` }));
    writeFileSync(join(gitDirectory, process.platform === 'win32' ? 'git.exe' : 'git'), 'git');
    writeFileSync(join(runtimeDirectory, 'llama-server'), 'runtime');
    writeFileSync(join(runtimeDirectory, 'runtime-manifest.json'), JSON.stringify({
      schemaVersion: '1', runtimeId: 'fixture-cpu', acceleration: 'cpu', os: process.platform === 'win32' ? 'windows' : process.platform,
      arch: process.arch, executable: 'llama-server', sha256: sha256('runtime'),
    }));
    writeFileSync(join(modelDirectory, 'coder.gguf'), 'model');
    writeFileSync(join(modelDirectory, 'model-pack.json'), JSON.stringify({
      schemaVersion: '1', packId: 'cpu-lite', guaranteedBaseline: true,
      models: [{
        id: 'fixture-coder', file: 'coder.gguf', roles: ['coding'], minimumRamGB: 0.01,
        recommendedRamGB: 0.01, gpuRequired: false, sha256: sha256('model'), maxContextTokens: 4096,
        recommendedContext: { CPU_LITE: 2048, CPU_STANDARD: 3072, CPU_PLUS: 4096, GPU_STANDARD: 4096, AI_WORKSTATION: 4096 },
        license: 'test', source: 'test', commercialUseMetadata: 'test', redistributionMetadata: 'test',
      }],
    }));
    sealPortableKit(root);

    const config = parseConfig({
      local: {
        runtimes: { llamacpp: { enabled: true, host: 'http://127.0.0.1:18080' } },
        profiles: [{ name: 'fixture', runtime: 'llamacpp', model: 'fixture-coder' }],
        bundle: { offlineKitRequired: true, requireModelLicenseMetadata: true },
      },
    });
    const report = runOfflinePreflight(root, config);

    expect(report.overall.ready).toBe(true);
    expect(report.integrity).toMatchObject({ verified: true });
    expect(report.launchPlan).toMatchObject({
      runtimeId: 'fixture-cpu', profileId: 'local-fixture', modelId: 'fixture-coder', contextTokens: expect.any(Number),
      gpuLayers: 0, host: '127.0.0.1', port: 18080,
    });
    expect(report.launchPlan?.runtimePath).toBe(join(runtimeDirectory, 'llama-server'));
    expect(report.launchPlan?.modelPath).toBe(join(modelDirectory, 'coder.gguf'));
    expect(report.launchPlan?.contextTokens).toBeLessThanOrEqual(4096);

    const missingProfile = runOfflinePreflight(root, parseConfig({
      local: {
        runtimes: { llamacpp: { enabled: true, host: 'http://127.0.0.1:18080' } },
        bundle: { offlineKitRequired: true, requireModelLicenseMetadata: true },
      },
    }));
    expect(missingProfile.overall.ready).toBe(false);
    expect(missingProfile.launchPlan).toBeUndefined();
    expect(missingProfile.overall.reasons).toContain("Selected model 'fixture-coder' has no matching enabled llama.cpp profile, so no launch plan can be created.");

    const missingOnlineProfile = runOfflinePreflight(root, parseConfig({
      local: {
        runtimes: { llamacpp: { enabled: true, host: 'http://127.0.0.1:18080' } },
        bundle: { offlineKitRequired: false },
      },
    }));
    expect(missingOnlineProfile.overall.ready).toBe(false);
    expect(missingOnlineProfile.launchPlan).toBeUndefined();

    const unsafeHost = runOfflinePreflight(root, parseConfig({
      local: {
        runtimes: { llamacpp: { enabled: true, host: 'http://example.com:18080/path' } },
        profiles: [{ name: 'fixture', runtime: 'llamacpp', model: 'fixture-coder' }],
        bundle: { offlineKitRequired: false },
      },
    }));
    expect(unsafeHost.overall.ready).toBe(false);
    expect(unsafeHost.launchPlan).toBeUndefined();
    expect(unsafeHost.overall.reasons).toContain("llama.cpp host must be an HTTP loopback URL with a valid port, not 'http://example.com:18080/path'.");
  });

  it('rejects manifest paths that escape their asset directory', () => {
    const config = parseConfig({});
    expect(() => config).not.toThrow();
    expect(() => parseModelPackManifest({
      schemaVersion: '1', packId: 'bad', models: [{
        id: 'bad', file: '../escape.gguf', roles: ['coding'], minimumRamGB: 1,
        recommendedRamGB: 1, gpuRequired: false,
      }],
    })).toThrow(/relative/i);
    expect(() => parseRuntimeArtifactManifest({
      schemaVersion: '1', runtimeId: 'bad', acceleration: 'cpu', os: 'darwin', arch: 'arm64', executable: '../escape',
    })).toThrow(/relative/i);
  });
});
