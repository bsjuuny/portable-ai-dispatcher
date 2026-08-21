import type { AppContext } from '../bootstrap.js';
import type { DispatcherCommand } from '../../models/task.js';
import type { CommonCliOptions } from '../build-task.js';
import { buildTaskFromCli } from '../build-task.js';
import type { ProviderId } from '../../models/provider.js';
import type { TaskOutcome } from '../../core/orchestrator.js';

export interface DispatchCommandOptions extends CommonCliOptions {
  json?: boolean;
}

export async function runDispatchCommand(
  ctx: AppContext,
  command: DispatcherCommand,
  descriptionArg: string | undefined,
  options: DispatchCommandOptions,
): Promise<number> {
  const task = await buildTaskFromCli(command, descriptionArg, options);
  ctx.logger.debug({ event: 'cli.task.built', taskId: task.id, command }, 'Task built from CLI input');
  ctx.history.recordTaskCreated(task);

  const forcedProvider = options.provider as ProviderId | undefined;
  const outcome = await ctx.orchestrator.runTask(task, { forcedProvider, dryRun: options.dryRun });
  ctx.logger.debug({ event: 'cli.task.outcome', taskId: task.id, verdict: outcome.verdict }, 'Orchestrator returned');

  ctx.history.updateTaskStatus(task.id, task.status, { endedAt: new Date().toISOString() });
  if (outcome.validation) ctx.history.recordValidationOutcome(task.id, outcome.validation.passed);
  if (outcome.review) ctx.history.recordReviewVerdict(task.id, outcome.review.verdict);

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          taskId: task.id,
          verdict: outcome.verdict,
          routing: outcome.routing,
          attempts: outcome.attempts.map((a) => ({ provider: a.provider, status: a.result.status })),
          validation: outcome.validation
            ? { passed: outcome.validation.passed, failedStage: outcome.validation.failedStage }
            : undefined,
          review: outcome.review ? { verdict: outcome.review.verdict, findings: outcome.review.findings } : undefined,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    printHumanReadable(outcome, options.dryRun ?? false);
  }

  return outcome.verdict === 'SUCCESS' || outcome.verdict === 'SUCCESS_WITH_WARNING' ? 0 : 1;
}

function printHumanReadable(outcome: TaskOutcome, dryRun: boolean): void {
  const lines: string[] = [];
  lines.push(`Task: ${outcome.task.id} (${outcome.task.command})`);
  lines.push(`Selected provider: ${outcome.routing.selected}`);
  for (const reason of outcome.routing.reasons) lines.push(`  ${reason}`);

  if (dryRun) {
    lines.push('(dry run - no execution performed)');
    process.stdout.write(`${lines.join('\n')}\n`);
    return;
  }

  for (const attempt of outcome.attempts) {
    lines.push(`Execution [${attempt.provider}]: ${attempt.result.status}`);
  }
  if (outcome.validation) {
    lines.push(`Validation: ${outcome.validation.passed ? 'PASSED' : `FAILED at ${outcome.validation.failedStage}`}`);
  }
  if (outcome.review) {
    lines.push(`Review (${outcome.review.reviewer}, independent=${outcome.review.independentReview}): ${outcome.review.verdict}`);
    for (const finding of outcome.review.findings) {
      lines.push(`  [${finding.severity}] ${finding.category}: ${finding.message}`);
    }
  }
  lines.push(`Final verdict: ${outcome.verdict}`);
  process.stdout.write(`${lines.join('\n')}\n`);
}
