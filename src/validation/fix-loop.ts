import type { ValidationResult } from '../models/validation.js';
import { DispatcherError } from '../models/error.js';

export interface FixLoopOptions {
  maxIterations: number;
}

export const DEFAULT_FIX_LOOP_OPTIONS: FixLoopOptions = { maxIterations: 2 };

/**
 * Bounded fix loop: on a validation failure, calls `requestFix` (which the caller
 * wires to re-dispatch a follow-up task to a provider, with the failed stage's
 * output attached as context) and then re-runs `runValidation`. Decoupled from the
 * orchestrator/provider layer via callbacks so it stays independently testable -
 * tests can inject a fake requestFix that "fixes" or "doesn't fix" deterministically.
 *
 * Never loops unboundedly (spec section 50: 무한 반복 금지) - after maxIterations
 * failed attempts, returns the last result with fixLoopExhausted: true rather than
 * throwing, so the caller can decide what to report.
 */
export async function runFixLoop(
  initialResult: ValidationResult,
  runValidation: () => Promise<ValidationResult>,
  requestFix: (failedResult: ValidationResult, iteration: number) => Promise<void>,
  options: FixLoopOptions = DEFAULT_FIX_LOOP_OPTIONS,
): Promise<ValidationResult> {
  let result = initialResult;
  let iteration = 0;

  while (!result.passed && iteration < options.maxIterations) {
    iteration += 1;
    try {
      await requestFix(result, iteration);
    } catch {
      // A fix attempt itself failing to even run is reported as exhaustion, not a
      // silently-swallowed error - see spec section 77 (Silent Failure 금지).
      return { ...result, fixLoopIterations: iteration, fixLoopExhausted: true };
    }
    result = await runValidation();
  }

  return {
    ...result,
    fixLoopIterations: iteration,
    fixLoopExhausted: !result.passed && iteration >= options.maxIterations,
  };
}

export function assertNotExhausted(result: ValidationResult): void {
  if (result.fixLoopExhausted) {
    throw new DispatcherError({
      code: 'VALIDATION_FAILED',
      message: `Validation still failing after ${result.fixLoopIterations} fix attempt(s) at stage "${result.failedStage}".`,
      taskId: result.taskId,
      retryable: false,
    });
  }
}
