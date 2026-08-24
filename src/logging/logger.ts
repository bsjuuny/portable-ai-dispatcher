/** Minimal dependency-free NDJSON logger. It intentionally covers the small
 * interface Dispatcher uses (`debug` and `child`) so a portable build never
 * depends on a CommonJS logger resolving modules from the host filesystem. */
export type LogLevel = 'silent' | 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

export interface DispatcherLogger {
  debug(data: Record<string, unknown>, message?: string): void;
  child(bindings: Record<string, unknown>): DispatcherLogger;
}

export interface CreateLoggerOptions {
  destination?: NodeJS.WritableStream;
  level?: LogLevel;
}

export function createLogger(options: CreateLoggerOptions = {}): DispatcherLogger {
  return new NdjsonLogger(options.destination ?? process.stdout, options.level ?? 'info');
}

export function childLogger(logger: DispatcherLogger, taskId: string, executionId?: string): DispatcherLogger {
  return logger.child({ taskId, ...(executionId ? { executionId } : {}) });
}

class NdjsonLogger implements DispatcherLogger {
  constructor(
    private readonly destination: NodeJS.WritableStream,
    private readonly level: LogLevel,
    private readonly bindings: Record<string, unknown> = {},
  ) {}

  debug(data: Record<string, unknown>, message?: string): void {
    if (this.level !== 'debug' && this.level !== 'trace') return;
    this.destination.write(`${JSON.stringify({ level: 'debug', time: new Date().toISOString(), ...this.bindings, ...redact(data), ...(message ? { msg: message } : {}) })}\n`);
  }

  child(bindings: Record<string, unknown>): DispatcherLogger {
    return new NdjsonLogger(this.destination, this.level, { ...this.bindings, ...redact(bindings) });
  }
}

function redact(data: Record<string, unknown>): Record<string, unknown> {
  const sensitive = /password|token|apikey|authorization|secret/i;
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, sensitive.test(key) ? '[REDACTED]' : value]));
}
