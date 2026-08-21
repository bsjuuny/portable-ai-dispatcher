import type { DatabaseSync } from 'node:sqlite';
import type { DispatcherTask, TaskStatus } from '../models/task.js';
import type { ProviderId } from '../models/provider.js';
import type { AuditEvent, AuditSink } from '../logging/audit.js';
import type { UsageRecord, UsageStore } from '../routing/usage-store.js';
import { DispatcherError } from '../models/error.js';

/**
 * The only file with raw SQL in it - everything else gets typed functions. Doubles
 * as the SQLite-backed implementation of UsageStore and AuditSink so the routing and
 * logging layers never need to know history is SQLite-backed at all.
 */
export class HistoryRepository implements UsageStore, AuditSink {
  constructor(private readonly db: DatabaseSync) {}

  recordTaskCreated(task: DispatcherTask): void {
    this.run(
      `INSERT INTO tasks (task_id, command, started_at, status, retry_count, fallback_count, input_size)
       VALUES (?, ?, ?, ?, 0, 0, ?)`,
      [task.id, task.command, task.createdAt, task.status, task.specification.rawDescription.length],
    );
  }

  updateTaskStatus(taskId: string, status: TaskStatus, extra: { errorCode?: string; endedAt?: string } = {}): void {
    this.run(`UPDATE tasks SET status = ?, error_code = COALESCE(?, error_code), ended_at = COALESCE(?, ended_at) WHERE task_id = ?`, [
      status,
      extra.errorCode ?? null,
      extra.endedAt ?? null,
      taskId,
    ]);
  }

  incrementRetryCount(taskId: string): void {
    this.run(`UPDATE tasks SET retry_count = retry_count + 1 WHERE task_id = ?`, [taskId]);
  }

  incrementFallbackCount(taskId: string): void {
    this.run(`UPDATE tasks SET fallback_count = fallback_count + 1 WHERE task_id = ?`, [taskId]);
  }

  recordValidationOutcome(taskId: string, passed: boolean): void {
    this.run(`UPDATE tasks SET validation_passed = ? WHERE task_id = ?`, [passed ? 1 : 0, taskId]);
  }

  recordReviewVerdict(taskId: string, verdict: string): void {
    this.run(`UPDATE tasks SET review_verdict = ? WHERE task_id = ?`, [verdict, taskId]);
  }

  recordExecution(params: {
    executionId: string;
    taskId: string;
    provider: ProviderId;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    status: string;
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
  }): void {
    this.run(
      `INSERT INTO executions (execution_id, task_id, provider, started_at, finished_at, duration_ms, status, input_tokens, output_tokens, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        params.executionId,
        params.taskId,
        params.provider,
        params.startedAt,
        params.finishedAt,
        params.durationMs,
        params.status,
        params.inputTokens ?? null,
        params.outputTokens ?? null,
        params.costUsd ?? null,
      ],
    );
  }

  queryHistory(limit = 50): Array<Record<string, unknown>> {
    const stmt = this.db.prepare(`SELECT * FROM tasks ORDER BY started_at DESC LIMIT ?`);
    return stmt.all(limit) as Array<Record<string, unknown>>;
  }

  getTask(taskId: string): Record<string, unknown> | undefined {
    const stmt = this.db.prepare(`SELECT * FROM tasks WHERE task_id = ?`);
    return stmt.get(taskId) as Record<string, unknown> | undefined;
  }

  getExecutionsForTask(taskId: string): Array<Record<string, unknown>> {
    const stmt = this.db.prepare(`SELECT * FROM executions WHERE task_id = ? ORDER BY started_at ASC`);
    return stmt.all(taskId) as Array<Record<string, unknown>>;
  }

  // --- UsageStore ---

  async record(entry: UsageRecord): Promise<void> {
    this.recordExecution({
      executionId: entry.executionId,
      taskId: entry.taskId,
      provider: entry.provider,
      startedAt: entry.startedAt,
      finishedAt: entry.finishedAt,
      durationMs: entry.durationMs,
      status: entry.outcome,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      costUsd: entry.costUsd,
    });
  }

  async recentFor(provider: ProviderId, windowMs: number, now: Date = new Date()): Promise<UsageRecord[]> {
    const cutoffIso = Number.isFinite(windowMs)
      ? new Date(now.getTime() - windowMs).toISOString()
      : '0000-01-01T00:00:00.000Z';
    const stmt = this.db.prepare(
      `SELECT * FROM executions WHERE provider = ? AND finished_at >= ? ORDER BY finished_at ASC`,
    );
    const rows = stmt.all(provider, cutoffIso) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      provider: row['provider'] as ProviderId,
      taskId: row['task_id'] as string,
      executionId: row['execution_id'] as string,
      outcome: row['status'] as UsageRecord['outcome'],
      startedAt: row['started_at'] as string,
      finishedAt: row['finished_at'] as string,
      durationMs: row['duration_ms'] as number,
      inputTokens: (row['input_tokens'] as number | null) ?? undefined,
      outputTokens: (row['output_tokens'] as number | null) ?? undefined,
      costUsd: (row['cost_usd'] as number | null) ?? undefined,
    }));
  }

  // --- AuditSink ---

  async append(event: AuditEvent): Promise<void> {
    this.run(`INSERT INTO audit_events (event_id, task_id, sequence, type, timestamp, data_json) VALUES (?, ?, ?, ?, ?, ?)`, [
      event.eventId,
      event.taskId,
      event.sequence,
      event.type,
      event.timestamp,
      JSON.stringify(event.data),
    ]);
  }

  private run(sql: string, params: unknown[]): void {
    try {
      this.db.prepare(sql).run(...(params as never[]));
    } catch (cause) {
      throw new DispatcherError({
        code: 'HISTORY_WRITE_FAILED',
        message: `History write failed: ${(cause as Error).message}`,
        cause,
        retryable: false,
      });
    }
  }
}
