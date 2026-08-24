import { describe, expect, it } from 'vitest';
import { routeLocalModel } from '../../src/local/model-router.js';

describe('CPU-first local model router', () => {
  it('prefers a qualified warm CPU-capable model and caps context to its recommendation', () => {
    const route = routeLocalModel([
      { id: 'slow', roles: ['coding'], status: 'READY_SLOW' as const, recommendedContextTokens: 4096 },
      { id: 'warm', roles: ['coding'], status: 'READY' as const, warm: true, recommendedContextTokens: 8192, qualification: { hardwareFingerprint: 'x', modelId: 'warm', runtimeId: 'llamacpp', qualifiedAt: new Date().toISOString(), generationTokensPerSecond: 12 } },
    ], 'coding', 'CPU_STANDARD', 16_384);
    expect(route.selected?.id).toBe('warm');
    expect(route.contextBudget).toBe(8192);
  });

  it('does not route an unsupported model or try to download one', () => {
    const route = routeLocalModel([{ id: 'missing', roles: ['coding'], status: 'UNSUPPORTED' }], 'coding', 'CPU_LITE', 4096);
    expect(route.selected).toBeUndefined();
    expect(route.reason).toMatch(/automatic download is disabled/i);
  });
});
