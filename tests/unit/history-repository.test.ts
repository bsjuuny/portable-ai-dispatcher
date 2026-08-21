import { describe, expect, it, beforeEach } from 'vitest';
import { openDatabase } from '../../src/history/db.js';
import { HistoryRepository } from '../../src/history/repository.js';
import type { DispatcherTask } from '../../src/models/task.js';

function task(id: string): DispatcherTask {
  const now = new Date().toISOString();
  return { id, command: 'fix', specification: { rawDescription: 'x', attachments: [], sourcePaths: [] }, workingDirectory: '.', status: 'created', createdAt: now, updatedAt: now };
}

describe('HistoryRepository (real node:sqlite, in-memory db)', () => {
  let repo: HistoryRepository;

  beforeEach(() => {
    repo = new HistoryRepository(openDatabase(':memory:'));
  });

  it('records and queries a task', () => {
    repo.recordTaskCreated(task('t1'));
    const rows = repo.queryHistory(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!['task_id']).toBe('t1');
    expect(rows[0]!['status']).toBe('created');
  });

  it('updates task status and error code', () => {
    repo.recordTaskCreated(task('t1'));
    repo.updateTaskStatus('t1', 'failed', { errorCode: 'PROCESS_TIMEOUT', endedAt: new Date().toISOString() });
    const row = repo.getTask('t1');
    expect(row!['status']).toBe('failed');
    expect(row!['error_code']).toBe('PROCESS_TIMEOUT');
  });

  it('increments retry and fallback counters independently', () => {
    repo.recordTaskCreated(task('t1'));
    repo.incrementRetryCount('t1');
    repo.incrementRetryCount('t1');
    repo.incrementFallbackCount('t1');
    const row = repo.getTask('t1');
    expect(row!['retry_count']).toBe(2);
    expect(row!['fallback_count']).toBe(1);
  });

  it('records validation and review outcomes', () => {
    repo.recordTaskCreated(task('t1'));
    repo.recordValidationOutcome('t1', false);
    repo.recordReviewVerdict('t1', 'request_changes');
    const row = repo.getTask('t1');
    expect(row!['validation_passed']).toBe(0);
    expect(row!['review_verdict']).toBe('request_changes');
  });

  it('returns undefined for a task that does not exist', () => {
    expect(repo.getTask('nonexistent')).toBeUndefined();
  });

  it('records executions and retrieves them for a task, ordered by start time', () => {
    repo.recordTaskCreated(task('t1'));
    repo.recordExecution({ executionId: 'e1', taskId: 't1', provider: 'claude', startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:01Z', durationMs: 1000, status: 'success' });
    repo.recordExecution({ executionId: 'e2', taskId: 't1', provider: 'codex', startedAt: '2026-01-01T00:00:02Z', finishedAt: '2026-01-01T00:00:03Z', durationMs: 1000, status: 'failure' });
    const executions = repo.getExecutionsForTask('t1');
    expect(executions).toHaveLength(2);
    expect(executions[0]!['provider']).toBe('claude');
    expect(executions[1]!['provider']).toBe('codex');
  });

  it('implements UsageStore.recentFor correctly against real SQL', async () => {
    repo.recordTaskCreated(task('t1')); // executions.task_id has a FOREIGN KEY into tasks - must exist first, matching real dispatch.ts call order
    await repo.record({ provider: 'claude', taskId: 't1', executionId: 'e1', outcome: 'success', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 500 });
    const recent = await repo.recentFor('claude', 3600_000);
    expect(recent).toHaveLength(1);
    expect(recent[0]!.outcome).toBe('success');
  });

  it('implements AuditSink.append and getAuditEventsForTask correctly against real SQL', async () => {
    await repo.append({ eventId: 'evt1', sequence: 1, taskId: 't1', type: 'task.created', timestamp: new Date().toISOString(), data: { foo: 'bar' } });
    const events = repo.getAuditEventsForTask('t1');
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!['data_json'] as string)).toEqual({ foo: 'bar' });
  });

  it('queryHistory respects the limit and orders most-recent-first', () => {
    repo.recordTaskCreated({ ...task('t1'), createdAt: '2026-01-01T00:00:00Z' });
    repo.recordTaskCreated({ ...task('t2'), createdAt: '2026-01-02T00:00:00Z' });
    // recordTaskCreated uses task.createdAt for started_at, so t2 (later) should come first.
    const rows = repo.queryHistory(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!['task_id']).toBe('t2');
  });
});
