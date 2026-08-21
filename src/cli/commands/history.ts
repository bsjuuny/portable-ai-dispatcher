import type { AppContext } from '../bootstrap.js';

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

  if (json) {
    process.stdout.write(`${JSON.stringify({ task, executions }, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`${JSON.stringify(task, null, 2)}\n`);
  process.stdout.write(`Executions:\n${executions.map((e) => `  ${JSON.stringify(e)}`).join('\n')}\n`);
  return 0;
}
