import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import type { TaskAttachment } from '../models/task.js';
import { DispatcherError } from '../models/error.js';

// Hard byte cap applied at read time - a blunt OOM guard, distinct from the later
// semantic windowing in project/log-windowing.ts (see docs/architecture.md).
const HARD_BYTE_CAP = 10 * 1024 * 1024; // 10 MiB

export interface ResolveAttachmentOptions {
  workingDirectory: string;
  additionalAllowedDirs?: string[];
}

/**
 * Reads a file attachment and enforces path containment: the resolved real path must
 * live inside workingDirectory or one of additionalAllowedDirs (--add-dir). Anything
 * else - `../../../etc/passwd`, an absolute escape, a symlink pointing outside - is
 * rejected before the content is ever read, let alone handed to a provider.
 */
export async function resolveFileAttachment(
  path: string,
  options: ResolveAttachmentOptions,
): Promise<TaskAttachment> {
  const allowedRoots = await Promise.all(
    [options.workingDirectory, ...(options.additionalAllowedDirs ?? [])].map((dir) =>
      realpath(resolve(dir)).catch(() => resolve(dir)),
    ),
  );

  const absoluteCandidate = isAbsolute(path) ? path : resolve(options.workingDirectory, path);

  let realCandidate: string;
  try {
    realCandidate = await realpath(absoluteCandidate);
  } catch (cause) {
    throw new DispatcherError({
      code: 'ATTACHMENT_READ_FAILED',
      message: `Attachment not found: ${path}`,
      cause,
      retryable: false,
    });
  }

  const contained = allowedRoots.some(
    (root) => realCandidate === root || realCandidate.startsWith(root + sep),
  );
  if (!contained) {
    throw new DispatcherError({
      code: 'PATH_TRAVERSAL_REJECTED',
      message: `Attachment path escapes allowed directories: ${path}`,
      retryable: false,
    });
  }

  const stats = await stat(realCandidate).catch((cause: unknown) => {
    throw new DispatcherError({
      code: 'ATTACHMENT_READ_FAILED',
      message: `Failed to stat attachment: ${path}`,
      cause,
      retryable: false,
    });
  });

  const buffer = await readFile(realCandidate).catch((cause: unknown) => {
    throw new DispatcherError({
      code: 'ATTACHMENT_READ_FAILED',
      message: `Failed to read attachment: ${path}`,
      cause,
      retryable: false,
    });
  });

  const truncated = buffer.byteLength > HARD_BYTE_CAP;
  const content = (truncated ? buffer.subarray(0, HARD_BYTE_CAP) : buffer).toString('utf8');

  return {
    id: createHash('sha256').update(realCandidate).digest('hex').slice(0, 16),
    type: classifyAttachment(realCandidate),
    path: realCandidate,
    name: realCandidate.split(sep).pop(),
    content,
    sizeBytes: content.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    truncated,
    originalSizeBytes: truncated ? stats.size : undefined,
  };
}

export function buildStdinAttachment(content: string): TaskAttachment {
  const truncated = Buffer.byteLength(content, 'utf8') > HARD_BYTE_CAP;
  const text = truncated ? content.slice(0, HARD_BYTE_CAP) : content;
  return {
    id: createHash('sha256').update(content).digest('hex').slice(0, 16),
    type: 'unknown',
    name: 'stdin',
    content: text,
    sizeBytes: Buffer.byteLength(text, 'utf8'),
    sha256: createHash('sha256').update(content).digest('hex'),
    truncated,
    originalSizeBytes: truncated ? Buffer.byteLength(content, 'utf8') : undefined,
  };
}

function classifyAttachment(path: string): TaskAttachment['type'] {
  if (/\.(log|out|err)$/i.test(path)) return 'log';
  if (/\.(md|markdown|txt)$/i.test(path)) return 'document';
  if (/\.(ts|tsx|js|jsx|py|java|go|rs|rb|c|cpp|cs|kt|swift)$/i.test(path)) return 'source';
  return 'file';
}

export async function readStdin(stream: NodeJS.ReadableStream = process.stdin): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}
