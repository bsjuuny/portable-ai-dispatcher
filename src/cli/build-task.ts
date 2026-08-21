import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { DispatcherCommand, DispatcherTask } from '../models/task.js';
import { buildTaskSpecification } from '../task/task-specification.js';
import { readStdin, resolveFileAttachment, buildStdinAttachment } from '../task/input-resolver.js';
import { DispatcherError } from '../models/error.js';

export interface CommonCliOptions {
  file?: string;
  path?: string[];
  stdin?: boolean;
  cwd?: string;
  timeout?: string;
  provider?: string;
  dryRun?: boolean;
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
): Promise<DispatcherTask> {
  const workingDirectory = resolve(options.cwd ?? process.cwd());

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

  const now = new Date().toISOString();
  return {
    id: `task_${randomUUID()}`,
    command,
    specification,
    workingDirectory,
    timeoutMs: options.timeout ? Number(options.timeout) : undefined,
    metadata: options.provider ? { explicitProvider: options.provider } : undefined,
    status: 'created',
    createdAt: now,
    updatedAt: now,
  };
}
