import pino from 'pino';

/**
 * Deliberately does NOT use pino.transport() - that spawns a worker thread which
 * dynamically resolves its target module (e.g. pino-pretty) as a real file on disk,
 * which breaks under esbuild/tsup bundling (see tsup.config.ts comment). Output is
 * always NDJSON to the destination stream; no TTY pretty-printing in v1.0 (documented
 * Known Limitation - pipe through the standalone `pino-pretty` CLI if desired:
 * `ai-dispatcher dispatch ... | pino-pretty`). This trades a cosmetic feature for not
 * introducing bundler-fragile code into the one thing every command depends on.
 *
 * `redact` is defense-in-depth, not the primary secret-scrubbing mechanism (that's
 * logging/redaction.ts, applied explicitly before anything reaches the logger) - see
 * docs/architecture.md.
 */
export interface CreateLoggerOptions {
  destination?: NodeJS.WritableStream;
  level?: pino.LevelWithSilent;
}

export function createLogger(options: CreateLoggerOptions = {}): pino.Logger {
  const destination = options.destination ?? process.stdout;

  return pino(
    {
      level: options.level ?? 'info',
      redact: {
        paths: ['*.password', '*.token', '*.apiKey', '*.authorization', 'env'],
        censor: '[REDACTED]',
      },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    destination,
  );
}

export function childLogger(logger: pino.Logger, taskId: string, executionId?: string): pino.Logger {
  return logger.child({ taskId, ...(executionId ? { executionId } : {}) });
}
