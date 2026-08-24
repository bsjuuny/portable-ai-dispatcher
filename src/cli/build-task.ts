import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { DispatcherCommand, DispatcherTask } from '../models/task.js';
import { buildTaskSpecification } from '../task/task-specification.js';
import { readStdin, resolveFileAttachment, buildStdinAttachment } from '../task/input-resolver.js';
import { DispatcherError } from '../models/error.js';
import { assertWorkingDirectoryExists } from './validate-working-directory.js';

/** Matches ExecutionSchema.maxTaskInputBytes' default (config/schema.ts) - used
 * when a caller doesn't pass a config-derived limit, so this check is never
 * silently skipped just because a caller omitted the parameter. */
const DEFAULT_MAX_TASK_INPUT_BYTES = 8 * 1024 * 1024;

export interface CommonCliOptions {
  file?: string;
  path?: string[];
  stdin?: boolean;
  cwd?: string;
  timeout?: string;
  provider?: string;
  dryRun?: boolean;
  debug?: boolean;
}

/**
 * Supports all four input modes from spec section 17: positional argument
 * (including multi-line strings, which arrive as one shell-quoted argv element -
 * nothing special needed), --file, --stdin, and combinations of description + --file
 * + --path (spec section 18/19).
 */
export async function buildTaskFromCli(
  command: DispatcherCommand,
  descriptionArg: string | undefined,
  options: CommonCliOptions,
  limits: { maxTaskInputBytes?: number } = {},
): Promise<DispatcherTask> {
  const workingDirectory = resolve(options.cwd ?? process.cwd());
  assertWorkingDirectoryExists(workingDirectory, options.cwd);

  const descriptionParts: string[] = [];
  if (descriptionArg && descriptionArg.trim().length > 0) descriptionParts.push(descriptionArg);

  const attachments = [];

  if (options.file) {
    const attachment = await resolveFileAttachment(options.file, { workingDirectory });
    attachments.push(attachment);
  }

  if (options.stdin || (!descriptionArg && !options.file && !process.stdin.isTTY)) {
    const stdinText = await readStdin();
    if (stdinText.trim().length > 0) {
      if (descriptionParts.length > 0 || options.file) {
        attachments.push(buildStdinAttachment(stdinText));
      } else {
        descriptionParts.push(stdinText);
      }
    }
  }

  const rawDescription = descriptionParts.join('\n\n').trim();
  if (rawDescription.length === 0 && attachments.length === 0) {
    throw new DispatcherError({
      code: 'INVALID_TASK',
      message: 'No task description provided (argument, --file, or --stdin required).',
      retryable: false,
    });
  }

  const sourcePaths: string[] = [];
  for (const path of options.path ?? []) {
    sourcePaths.push(resolve(workingDirectory, path));
  }

  const specification = buildTaskSpecification({
    rawDescription: rawDescription || `(see attachment: ${attachments[0]?.name ?? 'file'})`,
    sourcePaths,
  });
  specification.attachments = attachments;

  const maxTaskInputBytes = limits.maxTaskInputBytes ?? DEFAULT_MAX_TASK_INPUT_BYTES;
  const totalInputBytes =
    Buffer.byteLength(specification.rawDescription, 'utf8') + attachments.reduce((sum, a) => sum + a.sizeBytes, 0);
  if (totalInputBytes > maxTaskInputBytes) {
    throw new DispatcherError({
      code: 'TASK_INPUT_TOO_LARGE',
      message: `Task input is ${totalInputBytes} bytes, exceeding the configured limit of ${maxTaskInputBytes} bytes (execution.maxTaskInputBytes). Trim the description or attachment(s).`,
      retryable: false,
    });
  }

  const now = new Date().toISOString();
  const timeoutMs = parseTimeout(options.timeout);
  return {
    id: `task_${randomUUID()}`,
    command,
    specification,
    workingDirectory,
    timeoutMs,
    metadata: options.provider ? { explicitProvider: options.provider } : undefined,
    status: 'created',
    createdAt: now,
    updatedAt: now,
  };
}

function parseTimeout(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new DispatcherError({
      code: 'INVALID_TASK',
      message: `Invalid --timeout value "${value}": expected a positive integer in milliseconds.`,
      retryable: false,
    });
  }
  return timeout;
}
