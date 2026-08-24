import { describe, expect, it } from 'vitest';
import { FanOutAuditSink, InMemoryAuditSink, AuditLogger, type AuditSink } from '../../src/logging/audit.js';
import { isDispatcherError, DispatcherError } from '../../src/models/error.js';

class ThrowingSink implements AuditSink {
  constructor(private readonly error: unknown = new Error('disk full')) {}
  async append(): Promise<void> {
    throw this.error;
  }
}

describe('FanOutAuditSink', () => {
  it('delivers every appended event to all wrapped sinks', async () => {
    const a = new InMemoryAuditSink();
    const b = new InMemoryAuditSink();
    const fanOut = new FanOutAuditSink([a, b]);
    const logger = new AuditLogger(fanOut);

    await logger.record('task-1', 'task.created', { command: 'ask' });

    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(1);
    expect(a.events[0]?.type).toBe('task.created');
    expect(b.events[0]?.type).toBe('task.created');
  });

  it('works with zero sinks (a harmless no-op fan-out)', async () => {
    const fanOut = new FanOutAuditSink([]);
    await expect(fanOut.append({ eventId: 'e1', sequence: 1, taskId: 't1', type: 'task.created', timestamp: new Date().toISOString(), data: {} })).resolves.toBeUndefined();
  });
});

describe('AuditLogger write failure', () => {
  it('wraps a raw sink exception into a typed AUDIT_WRITE_FAILED DispatcherError', async () => {
    const logger = new AuditLogger(new ThrowingSink());
    await expect(logger.record('task-1', 'task.created', {})).rejects.toSatisfy(
      (error: unknown) => isDispatcherError(error) && error.code === 'AUDIT_WRITE_FAILED',
    );
  });

  it('passes an already-typed DispatcherError through unchanged, without re-wrapping it', async () => {
    const original = new DispatcherError({ code: 'HISTORY_WRITE_FAILED', message: 'db locked', retryable: true });
    const logger = new AuditLogger(new ThrowingSink(original));
    await expect(logger.record('task-1', 'task.created', {})).rejects.toBe(original);
  });
});

describe('AuditLogger sanitization', () => {
  it('recursively scrubs nested secrets even when raw content storage is enabled', async () => {
    const sink = new InMemoryAuditSink();
    const logger = new AuditLogger(sink, { storeRawContent: true });
    await logger.record('task-1', 'provider.execution.failed', {
      error: { message: 'Authorization: Bearer secret-token-value' },
      nested: [{ token: 'sk-test-secret-value' }],
    });
    const serialized = JSON.stringify(sink.events[0]?.data);
    expect(serialized).not.toContain('secret-token-value');
    expect(serialized).not.toContain('sk-test-secret-value');
    expect(serialized).toContain('[REDACTED]');
  });

  it('never truncates an error message to "[large text omitted]", even with raw content storage off', async () => {
    const sink = new InMemoryAuditSink();
    const logger = new AuditLogger(sink, { storeRawContent: false });
    const longMessage = `llama.cpp /completion returned HTTP 400: ${'x'.repeat(300)}`;
    await logger.record('task-1', 'provider.execution.failed', { provider: 'local-cpu-32', error: { code: 'LOCAL_GENERATION_FAILED', message: longMessage } });
    const data = sink.events[0]?.data as { error: { message: string } };
    expect(data.error.message).toBe(longMessage);
  });

  it('still truncates unrelated long strings when raw content storage is off', async () => {
    const sink = new InMemoryAuditSink();
    const logger = new AuditLogger(sink, { storeRawContent: false });
    await logger.record('task-1', 'provider.execution.completed', { responseText: 'y'.repeat(300) });
    const data = sink.events[0]?.data as { responseText: string };
    expect(data.responseText).toBe('[large text omitted]');
  });
});
