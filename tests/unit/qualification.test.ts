import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findQualification, qualifyLocalModel } from '../../src/local/qualification.js';
import type { LocalRuntimeAdapter } from '../../src/models/local.js';

const roots: string[] = [];

const adapter: LocalRuntimeAdapter = {
  kind: 'llamacpp',
  async detect(host) { return { runtime: 'llamacpp', host, reachable: true, checkedAt: new Date().toISOString() }; },
  async listModels() { return []; },
  async generate() { return { text: 'LOCAL_AI_OK', raw: {}, durationMs: 100, thinkingStripped: false }; },
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('local qualification cache', () => {
  it('stores observed endpoint throughput under a hardware fingerprint', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-dispatcher-qualification-'));
    roots.push(root);
    const qualification = await qualifyLocalModel({
      root,
      adapter,
      request: { profileId: 'local-test', runtime: 'llamacpp', host: 'http://127.0.0.1:8080', model: 'tiny.gguf', prompt: '', timeoutMs: 1000 },
      hardwareFingerprint: 'hardware-a',
    });
    expect(qualification.generationTokensPerSecond).toBe(10);
    expect(findQualification(root, { hardwareFingerprint: 'hardware-a', modelId: 'tiny.gguf', runtimeId: 'llamacpp' })).toMatchObject({ stale: false, qualification: { modelId: 'tiny.gguf' } });
  });
});
