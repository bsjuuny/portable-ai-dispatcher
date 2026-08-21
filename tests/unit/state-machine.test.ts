import { describe, expect, it } from 'vitest';
import { canTransition, isTerminal, transition } from '../../src/core/state-machine.js';
import { isDispatcherError } from '../../src/models/error.js';

describe('state machine', () => {
  it('allows the full happy-path sequence', () => {
    const path = [
      'created', 'classifying', 'loading_context', 'selecting_provider', 'running',
      'validating', 'reviewing', 'completed',
    ] as const;
    for (let i = 0; i < path.length - 1; i += 1) {
      expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
    }
  });

  it('allows the fix loop (validating <-> fixing)', () => {
    expect(canTransition('validating', 'fixing')).toBe(true);
    expect(canTransition('fixing', 'validating')).toBe(true);
  });

  it('allows the review feedback loop (reviewing -> fixing)', () => {
    expect(canTransition('reviewing', 'fixing')).toBe(true);
  });

  it('allows cancellation from any non-terminal state', () => {
    const nonTerminal = ['created', 'classifying', 'loading_context', 'selecting_provider', 'running', 'validating', 'fixing', 'reviewing'] as const;
    for (const state of nonTerminal) {
      expect(canTransition(state, 'cancelled')).toBe(true);
    }
  });

  it('rejects skipping states (created -> running)', () => {
    expect(canTransition('created', 'running')).toBe(false);
  });

  it('rejects transitions out of terminal states', () => {
    for (const terminal of ['completed', 'failed', 'timed_out', 'cancelled'] as const) {
      expect(isTerminal(terminal)).toBe(true);
      expect(canTransition(terminal, 'running')).toBe(false);
    }
  });

  it('transition() throws INVALID_STATE_TRANSITION for an illegal edge', () => {
    try {
      transition('created', 'completed', { taskId: 't1' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isDispatcherError(error)).toBe(true);
      if (isDispatcherError(error)) {
        expect(error.code).toBe('INVALID_STATE_TRANSITION');
        expect(error.taskId).toBe('t1');
        expect(error.retryable).toBe(false);
      }
    }
  });

  it('transition() returns the target state for a legal edge', () => {
    expect(transition('created', 'classifying')).toBe('classifying');
  });
});
