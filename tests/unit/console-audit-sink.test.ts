import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { ConsoleAuditSink } from '../../src/cli/console-audit-sink.js';
import type { AuditEvent } from '../../src/logging/audit.js';

function event(type: AuditEvent['type'], data: Record<string, unknown> = {}): AuditEvent {
  return { eventId: 'e1', sequence: 1, taskId: 't1', type, timestamp: new Date().toISOString(), data };
}

function captureStderr() {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
  return { lines, spy };
}

describe('ConsoleAuditSink', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints a human-readable line for provider selection and execution lifecycle events', async () => {
    const { lines } = captureStderr();
    const sink = new ConsoleAuditSink();

    await sink.append(event('provider.selected', { provider: 'codex', reasons: [] }));
    await sink.append(event('provider.execution.started', { provider: 'codex', attempt: 0 }));
    await sink.append(event('provider.execution.completed', { provider: 'codex', status: 'success' }));

    expect(lines.join('')).toContain('Selected provider: codex');
    expect(lines.join('')).toContain('Execution [codex]: running...');
    expect(lines.join('')).toContain('Execution [codex]: success');
  });

  it('includes the real error message for a failed or timed-out execution, not just the status', async () => {
    const { lines } = captureStderr();
    const sink = new ConsoleAuditSink();

    await sink.append(
      event('provider.execution.failed', {
        provider: 'codex',
        error: { code: 'PROVIDER_TASK_FAILED', message: "The 'gpt-5.6-sol' model requires a newer version of Codex." },
      }),
    );

    expect(lines.join('')).toContain('Execution [codex]: failed');
    expect(lines.join('')).toContain("The 'gpt-5.6-sol' model requires a newer version of Codex.");
  });

  it('silently ignores event types it has no message for, rather than printing something confusing', async () => {
    const { lines } = captureStderr();
    const sink = new ConsoleAuditSink();

    await sink.append(event('project.context.loaded', { language: 'TypeScript' }));

    expect(lines).toHaveLength(0);
  });

  describe('heartbeat', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('prints a periodic "still waiting" line while an execution is in flight, and stops once it completes', async () => {
      const { lines } = captureStderr();
      const sink = new ConsoleAuditSink(1000);

      await sink.append(event('provider.execution.started', { provider: 'codex', attempt: 0 }));
      lines.length = 0; // only care about heartbeat lines from here

      await vi.advanceTimersByTimeAsync(3500);
      const heartbeats = lines.filter((l) => l.includes('still waiting'));
      expect(heartbeats.length).toBe(3); // fires at 1000, 2000, 3000ms

      await sink.append(event('provider.execution.completed', { provider: 'codex', status: 'success' }));
      lines.length = 0;
      await vi.advanceTimersByTimeAsync(5000);
      expect(lines.filter((l) => l.includes('still waiting'))).toHaveLength(0); // no more ticks after completion
    });

    it('stop() halts a heartbeat that was still ticking (e.g. the task threw before a completion event)', async () => {
      const { lines } = captureStderr();
      const sink = new ConsoleAuditSink(1000);

      await sink.append(event('provider.execution.started', { provider: 'codex', attempt: 0 }));
      sink.stop();
      lines.length = 0;

      await vi.advanceTimersByTimeAsync(5000);
      expect(lines.filter((l) => l.includes('still waiting'))).toHaveLength(0);
    });

    it('a second execution.started resets the heartbeat instead of stacking two timers', async () => {
      const { lines } = captureStderr();
      const sink = new ConsoleAuditSink(1000);

      await sink.append(event('provider.execution.started', { provider: 'codex', attempt: 0 }));
      await sink.append(event('provider.execution.started', { provider: 'claude', attempt: 0 })); // fallback
      lines.length = 0;

      await vi.advanceTimersByTimeAsync(1000);
      const heartbeats = lines.filter((l) => l.includes('still waiting'));
      expect(heartbeats).toHaveLength(1);
      expect(heartbeats[0]).toContain('claude');
    });
  });
});
