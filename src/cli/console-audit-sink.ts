import type { AuditEvent, AuditSink } from '../logging/audit.js';

/**
 * Prints live status to stderr as audit events happen, instead of the CLI staying
 * completely silent from the moment a dispatch command starts until the whole task
 * (which can take many minutes across retries/fallback/fix loops/review cycles)
 * finishes. Found live (2026-08-22): a `fix` run sat with zero terminal output for
 * 11+ minutes during a genuine hang, and there was no way to tell "still working" from
 * "stuck" without external investigation. Written to stderr (never stdout) so `--json`
 * mode's machine-readable stdout output is never touched by this.
 *
 * A separate concern from the audit trail itself (history/repository.ts) - this sink
 * is fanned out alongside it (see logging/audit.ts's FanOutAuditSink) rather than
 * replacing it, so persisted audit data is unaffected either way.
 */
export class ConsoleAuditSink implements AuditSink {
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private heartbeatStartedAt = 0;
  private heartbeatProvider = '';
  private lastActivityAt = 0;

  constructor(private readonly heartbeatIntervalMs = 30_000) {}

  async append(event: AuditEvent): Promise<void> {
    const line = this.describe(event);
    if (line !== undefined) this.write(line);
  }

  /** Call when the whole dispatch is done, so a heartbeat timer never outlives it. */
  stop(): void {
    this.stopHeartbeat();
  }

  private describe(event: AuditEvent): string | undefined {
    const data = event.data;
    switch (event.type) {
      case 'provider.selected':
        return `Selected provider: ${String(data['provider'])}`;
      case 'provider.execution.started':
        this.startHeartbeat(String(data['provider']));
        return `Execution [${String(data['provider'])}]: running...`;
      case 'provider.execution.activity':
        this.lastActivityAt = Date.now();
        return undefined;
      case 'task.plan.created': {
        const units = Array.isArray(data['workUnits']) ? data['workUnits'].length : 0;
        const budget = data['budget'] as { hardTimeoutMs?: unknown; idleTimeoutMs?: unknown } | undefined;
        return `Plan: ${String(data['scope'])} scope, ${units} work unit(s), hard limit ${formatDuration(budget?.hardTimeoutMs)}`;
      }
      case 'checkpoint.saved':
        return 'Progress checkpoint recorded; the next attempt will continue from the current workspace.';
      case 'provider.execution.completed':
        this.stopHeartbeat();
        return `Execution [${String(data['provider'])}]: ${String(data['status'])}`;
      case 'provider.execution.failed':
      case 'provider.execution.timeout': {
        this.stopHeartbeat();
        const label = event.type === 'provider.execution.timeout' ? 'timeout' : 'failed';
        return `Execution [${String(data['provider'])}]: ${label}${describeError(data['error'])}`;
      }
      case 'retry.started':
        return `Retrying ${String(data['provider'])} (attempt ${String(data['attempt'])})...`;
      case 'fallback.started':
        return `Falling back from ${String(data['from'])}...`;
      case 'fallback.completed':
        return `Falling back to ${String(data['to'])}`;
      case 'validation.started':
        return 'Validating...';
      case 'validation.passed':
        return 'Validation: PASSED';
      case 'validation.failed':
        return `Validation: FAILED at ${String(data['failedStage'] ?? 'unknown stage')}`;
      case 'fix.started':
        return `Attempting a fix (validation failed at ${String(data['failedStage'] ?? 'unknown stage')})...`;
      case 'review.started':
        return 'Requesting review...';
      case 'review.completed':
        return `Review: ${String(data['verdict'])}`;
      case 'review.failed':
        return `Review: ${String(data['reason'] ?? 'failed')}`;
      case 'repository.lock.blocked':
        return `Repository is locked by another task: ${String(data['error'])}`;
      case 'workspace.acquired':
        return 'Isolated workspace acquired.';
      case 'auto_apply.decided':
        return `Auto-apply decision: ${String(data['decision'])}`;
      default:
        return undefined;
    }
  }

  private startHeartbeat(provider: string): void {
    this.stopHeartbeat();
    this.heartbeatProvider = provider;
    this.heartbeatStartedAt = Date.now();
    this.lastActivityAt = this.heartbeatStartedAt;
    this.heartbeatTimer = setInterval(() => {
      const elapsedSeconds = Math.round((Date.now() - this.heartbeatStartedAt) / 1000);
      const idleSeconds = Math.round((Date.now() - this.lastActivityAt) / 1000);
      this.write(`  ...still waiting on ${this.heartbeatProvider} (${elapsedSeconds}s elapsed, last output ${idleSeconds}s ago)`);
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private write(line: string): void {
    process.stderr.write(`${line}\n`);
  }
}

function describeError(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof (error as { message: unknown }).message === 'string') {
    return ` - ${(error as { message: string }).message}`;
  }
  return '';
}

function formatDuration(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'unknown';
  if (value < 60_000) return `${Math.round(value / 1000)}s`;
  return `${Math.round(value / 60_000)}m`;
}
