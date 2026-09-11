import './suppress-experimental-warnings.js';
import { Command } from 'commander';
import { createAppContext } from './bootstrap.js';
import { runDispatchCommand } from './commands/dispatch.js';
import { runDoctorCommand } from './commands/doctor.js';
import { runUsageCommand, runProvidersCommand } from './commands/usage.js';
import { runHistoryCommand, runInspectCommand } from './commands/history.js';
import { runExplainCommand } from './commands/explain.js';
import { runLocalStatusCommand, runLocalRuntimesCommand, runLocalModelsCommand, runLocalBenchmarkCommand, runLocalImportPackCommand, runLocalStartCommand } from './commands/local.js';
import { runPreflightCommand } from './commands/preflight.js';
import { runPortableAssembleCommand, runPortableAddNodeCommand, runPortableSealCommand } from './commands/portable.js';
import { isDispatcherError } from '../models/error.js';
import { resolve } from 'node:path';
import { assertWorkingDirectoryExists } from './validate-working-directory.js';

const program = new Command();
program.name('ai-dispatcher').description('AI Development Control Plane - routes tasks between Claude Code and Codex.');

function addCommonOptions(cmd: Command): Command {
  return cmd
    .option('--file <path>', 'Read task specification from a file')
    .option('--stdin', 'Read task specification from stdin')
    .option('--path <paths...>', 'Related file/directory paths for context')
    .option('--cwd <path>', 'Working directory (default: current directory)')
    .option('--timeout <ms>', 'Execution timeout in milliseconds')
    .option('--provider <id>', 'Force a specific provider (claude|codex|local-<profile>)')
    .option('--dry-run', 'Show routing decision without executing')
    .option('--json', 'Output JSON')
    .option('--debug', 'Enable verbose logging');
}

for (const command of ['ask', 'analyze', 'review', 'fix', 'implement'] as const) {
  addCommonOptions(program.command(`${command} [description]`)).action(async (description: string | undefined, options) => {
    try {
      const workingDirectory = resolve(options.cwd ?? process.cwd());
      // Must run BEFORE createAppContext(): that call opens the history DB via
      // history/db.ts's mkdirSync(dirname(path), {recursive:true}), which silently
      // creates the entire --cwd path if it didn't exist - live-verified this
      // creates a real, empty, non-git ".dispatcher"-only directory tree from a
      // typo'd --cwd, defeating any later existence check and then failing much
      // more confusingly downstream (e.g. inside git worktree setup).
      assertWorkingDirectoryExists(workingDirectory, options.cwd);
      const ctx = createAppContext(workingDirectory, { debug: Boolean(options.debug) });
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
  .command('preflight')
  .description('Inspect CPU/GPU capabilities and offline runtime/model-pack compatibility.')
  .option('--json', 'Output JSON')
  .action(async (options) => {
    const ctx = createAppContext(process.cwd());
    process.exitCode = await runPreflightCommand(ctx, Boolean(options.json));
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

const local = program.command('local').description('Local LLM runtime status and inventory.');

local
  .command('start')
  .description('Start the exact local llama.cpp runtime/model selected by offline preflight.')
  .action(async () => {
    const ctx = createAppContext(process.cwd());
    process.exitCode = await runLocalStartCommand(ctx);
  });

local
  .command('status')
  .description('Runtime reachability + configured local.profiles[] provider health.')
  .option('--json', 'Output JSON')
  .action(async (options) => {
    const ctx = createAppContext(process.cwd());
    process.exitCode = await runLocalStatusCommand(ctx, Boolean(options.json));
  });

local
  .command('runtimes')
  .description('Local runtime reachability, independent of configured profiles.')
  .option('--json', 'Output JSON')
  .action(async (options) => {
    const ctx = createAppContext(process.cwd());
    process.exitCode = await runLocalRuntimesCommand(ctx, Boolean(options.json));
  });

local
  .command('models')
  .description('Real installed model inventory per reachable runtime.')
  .option('--json', 'Output JSON')
  .action(async (options) => {
    const ctx = createAppContext(process.cwd());
    process.exitCode = await runLocalModelsCommand(ctx, Boolean(options.json));
  });

local
  .command('benchmark [profile]')
  .description('Qualify a configured local model and cache its observed throughput.')
  .option('--json', 'Output JSON')
  .action(async (profile: string | undefined, options) => {
    const ctx = createAppContext(process.cwd());
    process.exitCode = await runLocalBenchmarkCommand(ctx, profile, Boolean(options.json));
  });

local
  .command('import-pack <source>')
  .description('Validate and import a pre-downloaded offline model pack; no network is used.')
  .option('--json', 'Output JSON')
  .action((source: string, options) => {
    const ctx = createAppContext(process.cwd());
    process.exitCode = runLocalImportPackCommand(ctx, source, Boolean(options.json));
  });

const portable = program.command('portable').description('Create and operate an offline USB-portable Dispatcher kit.');

portable
  .command('assemble <destination>')
  .description('Create a self-contained kit. Existing runtime/ and models/ folders are copied by default; nothing is downloaded.')
  .option('--target <target>', 'Portable target: windows-x64 or macos-arm64 (defaults to the current supported host)')
  .option('--without-assets', 'Create the kit structure without copying runtime/ or models/')
  .option('--json', 'Output JSON')
  .action((destination: string, options) => {
    const ctx = createAppContext(process.cwd());
    process.exitCode = runPortableAssembleCommand(ctx, destination, !options.withoutAssets, Boolean(options.json), options.target as string | undefined);
  });

portable
  .command('add-node <destination>')
  .description('Copy the current Node.js 22+ executable into a Windows portable kit; Mac kits require a complete arm64 Node distribution.')
  .option('--json', 'Output JSON')
  .action((destination: string, options) => {
    process.exitCode = runPortableAddNodeCommand(resolve(process.cwd(), destination), Boolean(options.json));
  });

portable
  .command('seal <destination>')
  .description('Review then regenerate kit-lock.json after adding or replacing offline assets.')
  .option('--json', 'Output JSON')
  .action((destination: string, options) => {
    process.exitCode = runPortableSealCommand(resolve(process.cwd(), destination), Boolean(options.json));
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
