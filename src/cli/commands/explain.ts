import type { AppContext } from '../bootstrap.js';

/** Reads the persisted provider.selected audit event for a task - spec section 41. */
export function runExplainCommand(ctx: AppContext, taskId: string, json: boolean): number {
  const events = ctx.history.getAuditEventsForTask(taskId);
  const selectedEvent = events.find((e) => e['type'] === 'provider.selected');
  const classifiedEvent = events.find((e) => e['type'] === 'task.classified');

  if (!selectedEvent) {
    process.stderr.write(`No routing decision recorded for task: ${taskId}\n`);
    return 1;
  }

  const data = JSON.parse(selectedEvent['data_json'] as string) as { provider: string; reasons: string[] };
  const classification = classifiedEvent ? (JSON.parse(classifiedEvent['data_json'] as string) as Record<string, unknown>) : undefined;

  if (json) {
    process.stdout.write(`${JSON.stringify({ taskId, classification, selected: data.provider, reasons: data.reasons }, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(`Task: ${taskId}\n`);
  if (classification) process.stdout.write(`Type: ${classification['type']}\n`);
  process.stdout.write(`Selected: ${data.provider}\n\nReasons:\n`);
  for (const reason of data.reasons) process.stdout.write(`  ${reason}\n`);
  return 0;
}
