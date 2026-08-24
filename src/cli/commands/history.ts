import type { AppContext } from '../bootstrap.js';
import { formatTaskResultReport, type TaskResultReport } from '../../reporting/task-result-report.js';

export function runHistoryCommand(ctx: AppContext, limit: number, json: boolean): number {
  const rows = ctx.history.queryHistory(limit);
  if (json) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return 0;
  }
  for (const row of rows) {
    process.stdout.write(
      `${row['task_id']} [${row['command']}] status=${row['status']} started=${row['started_at']} retries=${row['retry_count']} fallbacks=${row['fallback_count']}\n`,
    );
  }
  return 0;
}

export function runInspectCommand(ctx: AppContext, taskId: string, json: boolean): number {
  const task = ctx.history.getTask(taskId);
  if (!task) {
    process.stderr.write(`No such task: ${taskId}\n`);
    return 1;
  }
  const executions = ctx.history.getExecutionsForTask(taskId);
  const auditEvents = ctx.history.getAuditEventsForTask(taskId);
  const resultReport = extractLatestResultReport(auditEvents);
  const disposition = extractDisposition(auditEvents);

  if (json) {
    process.stdout.write(`${JSON.stringify({ task, executions, resultReport, disposition }, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`${JSON.stringify(task, null, 2)}\n`);
  process.stdout.write(`Executions:\n${executions.map((e) => `  ${JSON.stringify(e)}`).join('\n')}\n`);
  if (resultReport) {
    process.stdout.write(`\n${formatTaskResultReport(resultReport).join('\n')}\n`);
  } else {
    // Tasks run before this reporting feature existed (or where the process
    // crashed before dispatch.ts recorded the event) genuinely have none - say so
    // rather than silently omitting the section.
    process.stdout.write('\n(no result report recorded for this task)\n');
  }
  if (disposition) {
    process.stdout.write(`\n${formatDisposition(disposition).join('\n')}\n`);
  }
  return 0;
}

/** Change-scope / risk / auto-apply-gate outcome for a task, independent of
 * whether a full TaskResultReport was ever recorded. `orchestrator.ts` always
 * emits these four audit events together right after validation+review pass
 * (change_scope.computed -> risk.classified -> auto_apply.decided -> either
 * patch.applied or patch.discarded) - this is the one place that answers
 * "was anything actually applied to the real repo, and why/why not," which a
 * TaskResultReport-less task (recorded before that feature existed, e.g.) has
 * no other way to surface. Exported for direct unit testing. */
export interface TaskDisposition {
  changeScope?: { filesChanged: number; linesAdded: number; linesDeleted: number };
  risk?: { level: string; reasons: string[] };
  decision?: { outcome: string; reasons: string[] };
  applied?: { filesChanged: number };
}

export function extractDisposition(events: Array<Record<string, unknown>>): TaskDisposition | undefined {
  let disposition: TaskDisposition | undefined;
  for (const event of events) {
    const type = event['type'];
    if (
      type !== 'change_scope.computed' &&
      type !== 'risk.classified' &&
      type !== 'auto_apply.decided' &&
      type !== 'patch.applied' &&
      type !== 'patch.discarded'
    ) {
      continue;
    }
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(String(event['data_json'])) as Record<string, unknown>;
    } catch {
      // A malformed data_json for this one event must not break inspecting the
      // rest of the task - skip just this event and keep looking at the others.
      continue;
    }
    disposition ??= {};
    if (type === 'change_scope.computed') {
      disposition.changeScope = {
        filesChanged: Number(data['filesChanged']),
        linesAdded: Number(data['linesAdded']),
        linesDeleted: Number(data['linesDeleted']),
      };
    } else if (type === 'risk.classified') {
      disposition.risk = { level: String(data['level']), reasons: (data['reasons'] as string[]) ?? [] };
    } else if (type === 'auto_apply.decided') {
      disposition.decision = { outcome: String(data['decision']), reasons: (data['reasons'] as string[]) ?? [] };
    } else if (type === 'patch.applied') {
      disposition.applied = { filesChanged: Number(data['filesChanged']) };
    }
    // patch.discarded carries the same {decision, reasons} shape auto_apply.decided
    // already recorded moments earlier - nothing new to capture from it here.
  }
  return disposition;
}

function formatDisposition(d: TaskDisposition): string[] {
  const lines = ['[변경 사항 처리 결과]'];
  if (d.changeScope) {
    lines.push(`- 변경 규모: 파일 ${d.changeScope.filesChanged}개, 추가 ${d.changeScope.linesAdded}줄, 삭제 ${d.changeScope.linesDeleted}줄`);
  }
  if (d.risk) {
    lines.push(`- 위험도: ${d.risk.level}${d.risk.reasons.length > 0 ? ` (${d.risk.reasons.join('; ')})` : ''}`);
  }
  if (d.decision) {
    const applied = d.decision.outcome === 'AUTO_APPLY';
    lines.push(`- 결정: ${d.decision.outcome} - 실제 저장소에 ${applied ? '적용됨' : '적용되지 않음(폐기됨)'}`);
    if (d.decision.reasons.length > 0) lines.push(`  사유: ${d.decision.reasons.join('; ')}`);
  }
  if (d.applied) {
    lines.push(`- 적용된 파일 수: ${d.applied.filesChanged}`);
  }
  return lines;
}

/** The `task.report.created` audit event's `data.report` is the same
 * TaskResultReport dispatch.ts already built and printed at the end of the run -
 * this reads that same persisted copy back out, rather than rebuilding it (which
 * isn't possible after the fact anyway - the live TaskOutcome no longer exists).
 * `events` is expected in sequence order (as HistoryRepository.getAuditEventsForTask
 * returns it); the *last* matching one wins, in case a report was ever recorded
 * more than once for the same taskId. Exported for direct unit testing. */
export function extractLatestResultReport(events: Array<Record<string, unknown>>): TaskResultReport | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.['type'] !== 'task.report.created') continue;
    try {
      const data = JSON.parse(String(event['data_json'])) as { report?: TaskResultReport };
      if (data.report) return data.report;
    } catch {
      // A malformed data_json for this one event must not break inspecting the
      // rest of the task - fall through and keep looking / report none found.
    }
  }
  return undefined;
}
