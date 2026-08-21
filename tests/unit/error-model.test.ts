import { describe, expect, it } from 'vitest';
import { DispatcherError, isDispatcherError, wrapUnknownError } from '../../src/models/error.js';

describe('DispatcherError', () => {
  it('captures all provided fields', () => {
    const error = new DispatcherError({
      code: 'PROCESS_TIMEOUT',
      message: 'timed out',
      taskId: 't1',
      executionId: 'e1',
      provider: 'claude',
      retryable: true,
      severity: 'warning',
    });
    expect(error.code).toBe('PROCESS_TIMEOUT');
    expect(error.taskId).toBe('t1');
    expect(error.retryable).toBe(true);
    expect(error.severity).toBe('warning');
    expect(error instanceof Error).toBe(true);
  });

  it('defaults severity to "error" when not specified', () => {
    const error = new DispatcherError({ code: 'INTERNAL_LOGIC_ERROR', message: 'x', retryable: false });
    expect(error.severity).toBe('error');
  });

  it('toJSON() produces a stable, serializable shape', () => {
    const error = new DispatcherError({ code: 'CONFIG_INVALID', message: 'bad config', retryable: false });
    const json = error.toJSON();
    expect(json['code']).toBe('CONFIG_INVALID');
    expect(json['message']).toBe('bad config');
    expect(() => JSON.stringify(json)).not.toThrow();
  });
});

describe('isDispatcherError', () => {
  it('returns true for a DispatcherError instance', () => {
    expect(isDispatcherError(new DispatcherError({ code: 'INTERNAL_LOGIC_ERROR', message: 'x', retryable: false }))).toBe(true);
  });

  it('returns false for a plain Error or arbitrary value', () => {
    expect(isDispatcherError(new Error('plain'))).toBe(false);
    expect(isDispatcherError('a string')).toBe(false);
    expect(isDispatcherError(undefined)).toBe(false);
    expect(isDispatcherError(null)).toBe(false);
  });
});

describe('wrapUnknownError', () => {
  it('passes an existing DispatcherError through unchanged', () => {
    const original = new DispatcherError({ code: 'PROCESS_TIMEOUT', message: 'x', retryable: true });
    expect(wrapUnknownError(original)).toBe(original);
  });

  it('wraps a plain Error as non-retryable INTERNAL_LOGIC_ERROR by default', () => {
    const wrapped = wrapUnknownError(new Error('boom'), { taskId: 't1' });
    expect(wrapped.code).toBe('INTERNAL_LOGIC_ERROR');
    expect(wrapped.retryable).toBe(false);
    expect(wrapped.message).toBe('boom');
    expect(wrapped.taskId).toBe('t1');
  });

  it('wraps a non-Error thrown value (e.g. a string or object) without crashing', () => {
    const wrapped = wrapUnknownError('just a string');
    expect(wrapped.message).toBe('just a string');
    expect(wrapped.code).toBe('INTERNAL_LOGIC_ERROR');
  });
});
