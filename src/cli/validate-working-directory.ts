import { statSync } from 'node:fs';
import { DispatcherError } from '../models/error.js';

/**
 * Shared by cli/index.ts (must run before createAppContext(), which otherwise
 * silently `mkdirSync(..., {recursive:true})`s the whole --cwd path into existence
 * as a side effect of opening the history DB - live-verified) and build-task.ts
 * (defense-in-depth for any direct library caller of buildTaskFromCli that skips
 * the CLI entry point entirely).
 */
export function assertWorkingDirectoryExists(workingDirectory: string, requestedCwd: string | undefined): void {
  let stats;
  try {
    stats = statSync(workingDirectory);
  } catch {
    throw new DispatcherError({
      code: 'INVALID_WORKING_DIRECTORY',
      message: `Working directory does not exist: "${workingDirectory}"${requestedCwd ? ` (from --cwd "${requestedCwd}")` : ''}.`,
      retryable: false,
    });
  }
  if (!stats.isDirectory()) {
    throw new DispatcherError({
      code: 'INVALID_WORKING_DIRECTORY',
      message: `Working directory is not a directory: "${workingDirectory}".`,
      retryable: false,
    });
  }
}
