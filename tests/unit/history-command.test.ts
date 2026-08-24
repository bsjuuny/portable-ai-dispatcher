import { describe, expect, it } from 'vitest';
import { extractDisposition, extractLatestResultReport } from '../../src/cli/commands/history.js';
import type { TaskResultReport } from '../../src/reporting/task-result-report.js';

function reportEvent(report: Partial<TaskResultReport>, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: 'e1',
    task_id: 't1',
    sequence: 1,
    type: 'task.report.created',
    timestamp: new Date().toISOString(),
    data_json: JSON.stringify({ report }),
    ...overrides,
  };
}

function otherEvent(type: string): Record<string, unknown> {
  return { event_id: 'e0', task_id: 't1', sequence: 0, type, timestamp: new Date().toISOString(), data_json: '{}' };
}

describe('extractLatestResultReport', () => {
  it('returns undefined when there are no events at all', () => {
    expect(extractLatestResultReport([])).toBeUndefined();
  });

  it('returns undefined when no event is a task.report.created', () => {
    const events = [otherEvent('task.created'), otherEvent('task.completed')];
    expect(extractLatestResultReport(events)).toBeUndefined();
  });

  it('extracts the report from a matching event, ignoring unrelated events around it', () => {
    const events = [otherEvent('task.created'), reportEvent({ what: { command: 'fix' } as never }), otherEvent('task.completed')];
    const report = extractLatestResultReport(events);
    expect(report?.what?.command).toBe('fix');
  });

  it('picks the LAST matching event when a report was recorded more than once for the same task', () => {
    const events = [
      reportEvent({ what: { command: 'ask' } as never }, { sequence: 1 }),
      reportEvent({ what: { command: 'fix' } as never }, { sequence: 2 }),
    ];
    const report = extractLatestResultReport(events);
    expect(report?.what?.command).toBe('fix');
  });

  it('skips a report event with malformed data_json instead of throwing, and keeps looking at earlier events', () => {
    const events = [
      reportEvent({ what: { command: 'ask' } as never }, { sequence: 1 }),
      { ...reportEvent({}, { sequence: 2 }), data_json: '{not valid json' },
    ];
    const report = extractLatestResultReport(events);
    expect(report?.what?.command).toBe('ask');
  });

  it('skips a report event whose data has no "report" field', () => {
    const events = [{ ...otherEvent('task.report.created'), data_json: JSON.stringify({ notReport: true }) }];
    expect(extractLatestResultReport(events)).toBeUndefined();
  });
});

function dispositionEvent(type: string, data: Record<string, unknown>, sequence: number): Record<string, unknown> {
  return { event_id: `e${sequence}`, task_id: 't1', sequence, type, timestamp: new Date().toISOString(), data_json: JSON.stringify(data) };
}

describe('extractDisposition', () => {
  it('returns undefined when none of the disposition events are present (e.g. task never reached that stage)', () => {
    const events = [otherEvent('task.created'), otherEvent('task.completed')];
    expect(extractDisposition(events)).toBeUndefined();
  });

  it('reconstructs a BLOCKED_BY_POLICY disposition from real orchestrator.ts event shapes (task_72861a46-style)', () => {
    const events = [
      otherEvent('task.completed'),
      dispositionEvent('change_scope.computed', { filesChanged: 8, linesAdded: 110, linesDeleted: 3 }, 1),
      dispositionEvent('risk.classified', { level: 'LOW', reasons: ['within blast radius limits'] }, 2),
      dispositionEvent(
        'auto_apply.decided',
        { decision: 'BLOCKED_BY_POLICY', reasons: ['one or more touched files changed in the real repository since the task started'] },
        3,
      ),
      dispositionEvent(
        'patch.discarded',
        { decision: 'BLOCKED_BY_POLICY', reasons: ['one or more touched files changed in the real repository since the task started'] },
        4,
      ),
    ];
    const disposition = extractDisposition(events);
    expect(disposition?.changeScope).toEqual({ filesChanged: 8, linesAdded: 110, linesDeleted: 3 });
    expect(disposition?.risk?.level).toBe('LOW');
    expect(disposition?.decision?.outcome).toBe('BLOCKED_BY_POLICY');
    expect(disposition?.applied).toBeUndefined();
  });

  it('captures patch.applied when the decision was AUTO_APPLY', () => {
    const events = [
      dispositionEvent('change_scope.computed', { filesChanged: 2, linesAdded: 10, linesDeleted: 0 }, 1),
      dispositionEvent('risk.classified', { level: 'LOW', reasons: [] }, 2),
      dispositionEvent('auto_apply.decided', { decision: 'AUTO_APPLY', reasons: [] }, 3),
      dispositionEvent('patch.applied', { filesChanged: 2 }, 4),
    ];
    const disposition = extractDisposition(events);
    expect(disposition?.decision?.outcome).toBe('AUTO_APPLY');
    expect(disposition?.applied).toEqual({ filesChanged: 2 });
  });

  it('skips a disposition event with malformed data_json instead of throwing, and still captures the others', () => {
    const events = [
      dispositionEvent('change_scope.computed', { filesChanged: 1, linesAdded: 1, linesDeleted: 1 }, 1),
      { ...dispositionEvent('risk.classified', {}, 2), data_json: '{not valid json' },
    ];
    const disposition = extractDisposition(events);
    expect(disposition?.changeScope).toEqual({ filesChanged: 1, linesAdded: 1, linesDeleted: 1 });
    expect(disposition?.risk).toBeUndefined();
  });
});
