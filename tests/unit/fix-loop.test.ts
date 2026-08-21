import { describe, expect, it, vi } from 'vitest';
import { runFixLoop, assertNotExhausted } from '../../src/validation/fix-loop.js';
import { isDispatcherError } from '../../src/models/error.js';
import type { ValidationResult } from '../../src/models/validation.js';

function result(passed: boolean, overrides: Partial<ValidationResult> = {}): ValidationResult {
  return {
    taskId: 't1',
    passed,
    stages: [],
    failedStage: passed ? undefined : 'test',
    fixLoopIterations: 0,
    fixLoopExhausted: false,
    durationMs: 0,
    ...overrides,
  };
}

describe('runFixLoop', () => {
  it('returns immediately if the initial result already passed (no fix attempted)', async () => {
    const requestFix = vi.fn();
    const runValidation = vi.fn();
    const outcome = await runFixLoop(result(true), runValidation, requestFix, { maxIterations: 2 });
    expect(outcome.passed).toBe(true);
    expect(outcome.fixLoopIterations).toBe(0);
    expect(requestFix).not.toHaveBeenCalled();
  });

  it('succeeds after one fix attempt', async () => {
    const requestFix = vi.fn().mockResolvedValue(undefined);
    const runValidation = vi.fn().mockResolvedValue(result(true));
    const outcome = await runFixLoop(result(false), runValidation, requestFix, { maxIterations: 2 });
    expect(outcome.passed).toBe(true);
    expect(outcome.fixLoopIterations).toBe(1);
    expect(outcome.fixLoopExhausted).toBe(false);
    expect(requestFix).toHaveBeenCalledTimes(1);
  });

  it('never loops more than maxIterations times, even if it keeps failing (no infinite loop)', async () => {
    const requestFix = vi.fn().mockResolvedValue(undefined);
    const runValidation = vi.fn().mockResolvedValue(result(false));
    const outcome = await runFixLoop(result(false), runValidation, requestFix, { maxIterations: 2 });

    expect(outcome.passed).toBe(false);
    expect(outcome.fixLoopIterations).toBe(2);
    expect(outcome.fixLoopExhausted).toBe(true);
    expect(requestFix).toHaveBeenCalledTimes(2);
  });

  it('reports exhaustion (not a thrown error) when the fix attempt itself fails to run', async () => {
    const requestFix = vi.fn().mockRejectedValue(new Error('provider crashed'));
    const runValidation = vi.fn();
    const outcome = await runFixLoop(result(false), runValidation, requestFix, { maxIterations: 2 });

    expect(outcome.fixLoopExhausted).toBe(true);
    expect(outcome.fixLoopIterations).toBe(1);
    expect(runValidation).not.toHaveBeenCalled(); // never re-validated after the fix attempt itself errored
  });

  it('maxIterations: 0 never attempts a fix at all', async () => {
    const requestFix = vi.fn();
    const outcome = await runFixLoop(result(false), vi.fn(), requestFix, { maxIterations: 0 });
    expect(requestFix).not.toHaveBeenCalled();
    expect(outcome.fixLoopExhausted).toBe(true);
  });
});

describe('assertNotExhausted', () => {
  it('does not throw for a passing result', () => {
    expect(() => assertNotExhausted(result(true))).not.toThrow();
  });

  it('throws VALIDATION_FAILED for an exhausted fix loop', () => {
    try {
      assertNotExhausted(result(false, { fixLoopExhausted: true, fixLoopIterations: 2 }));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isDispatcherError(error) && error.code === 'VALIDATION_FAILED').toBe(true);
    }
  });
});
