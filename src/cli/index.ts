import { Command } from 'commander';
import { createAppContext } from './bootstrap.js';
import { runDispatchCommand } from './commands/dispatch.js';
import { runDoctorCommand } from './commands/doctor.js';
import { runUsageCommand, runProvidersCommand } from './commands/usage.js';
import { runHistoryCommand, runInspectCommand } from './commands/history.js';
import { runExplainCommand } from './commands/explain.js';
import { isDispatcherError } from '../models/error.js';

const program = new Command();
program.name('ai-dispatcher').description('AI Development Control Plane - routes tasks between Claude Code and Codex.');

function addCommonOptions(cmd: Command): Command {
  return cmd
    .option('--file <path>', 'Read task specification from a file')
    .option('--stdin', 'Read task specification from stdin')
    .option('--path <paths...>', 'Related file/directory paths for context')
    .option('--cwd <path>', 'Working directory (default: current directory)')
    .option('--timeout <ms>', 'Execution timeout in milliseconds')
    .option('--provider <id>', 'Force a specific provider (claude|codex)')
    .option('--dry-run', 'Show routing decision without executing')
    .option('--json', 'Output JSON')
    .option('--debug', 'Enable verbose logging');
}

for (const command of ['ask', 'analyze', 'review', 'fix', 'implement'] as const) {
  addCommonOptions(program.command(`${command} [description]`)).action(async (description: string | undefined, options) => {
    const ctx = createAppContext(process.cwd(), { debug: Boolean(options.debug) });
    try {
      const code = await runDispatchCommand(ctx, command, description, options);
      process.exitCode = code;
    } catch (error) {
      reportError(error);
    }
  });
}

program
  .command('doctor')
  .option('--json', 'Output JSON')
  .action(async (options) => {
    const ctx = createAppContext(process.cwd());
    process.exitCode = await runDoctorCommand(ctx, Boolean(options.json));
  });

program
  .command('providers')
  .option('--json', 'Output JSON')
  .action((options) => {
    const ctx = createAppContext(process.cwd());
    process.exitCode = runProvidersCommand(ctx, Boolean(options.json));
  });

program
  .command('usage [provider]')
  .option('--json', 'Output JSON')
  .action(async (provider: string | undefined, options) => {
    const ctx = createAppContext(process.cwd());
    process.exitCode = await runUsageCommand(ctx, provider, Boolean(options.json));
  });

program
  .command('status')
  .option('--json', 'Output JSON')
  .action(async (options) => {
    const ctx = createAppContext(process.cwd());
    process.exitCode = await runDoctorCommand(ctx, Boolean(options.json));
  });

program
  .command('history')
  .option('--limit <n>', 'Number of tasks to show', '50')
  .option('--json', 'Output JSON')
  .action((options) => {
    const ctx = createAppContext(process.cwd());
    process.exitCode = runHistoryCommand(ctx, Number(options.limit), Boolean(options.json));
  });

program
  .command('inspect <taskId>')
  .option('--json', 'Output JSON')
  .action((taskId: string, options) => {
    const ctx = createAppContext(process.cwd());
    process.exitCode = runInspectCommand(ctx, taskId, Boolean(options.json));
  });

program
  .command('explain <taskId>')
  .option('--json', 'Output JSON')
  .action((taskId: string, options) => {
    const ctx = createAppContext(process.cwd());
    process.exitCode = runExplainCommand(ctx, taskId, Boolean(options.json));
  });

function reportError(error: unknown): void {
  if (isDispatcherError(error)) {
    process.stderr.write(`Error [${error.code}]: ${error.message}\n`);
  } else {
    process.stderr.write(`Unexpected error: ${(error as Error).message}\n`);
  }
  process.exitCode = 1;
}

program.parseAsync(process.argv).catch(reportError);
