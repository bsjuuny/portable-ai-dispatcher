import { scrubSecrets, shortHash } from './redaction.js';
import { DispatcherError, isDispatcherError } from '../models/error.js';

// Spec section 69 - the full event taxonomy, append-only (section 70: existing
// events are never modified, only new ones added).
export type AuditEventType =
  | 'task.created'
  | 'task.classified'
  | 'task.plan.created'
  | 'project.context.loaded'
  | 'provider.health.checked'
  | 'provider.usage.checked'
  | 'provider.selected'
  | 'provider.execution.started'
  | 'provider.execution.activity'
  | 'provider.execution.completed'
  | 'provider.execution.failed'
  | 'provider.execution.timeout'
  | 'retry.started'
  | 'retry.completed'
  | 'checkpoint.saved'
  | 'fallback.started'
  | 'fallback.completed'
  | 'validation.started'
  | 'validation.passed'
  | 'validation.failed'
  | 'fix.started'
  | 'fix.completed'
  | 'review.started'
  | 'review.completed'
  | 'review.failed'
  | 'task.completed'
  | 'task.report.created'
  | 'task.failed'
  | 'task.cancelled'
  // Local LLM Adapter + Hardening increment (additive, append-only per section 70).
  | 'local.runtime.detected'
  | 'workspace.acquired'
  | 'workspace.released'
  | 'repository.lock.acquired'
  | 'repository.lock.blocked'
  | 'base_revision.pinned'
  | 'base_revision.mismatch'
  | 'change_scope.computed'
  | 'risk.classified'
  | 'auto_apply.decided'
  | 'patch.applied'
  | 'patch.discarded';

export interface AuditEvent {
  eventId: string;
  sequence: number;
  taskId: string;
  type: AuditEventType;
  timestamp: string;
  data: Record<string, unknown>;
}

export interface AuditSink {
  append(event: AuditEvent): Promise<void>;
}

export class InMemoryAuditSink implements AuditSink {
  readonly events: AuditEvent[] = [];
  async append(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

/** Writes every event to all of the given sinks, e.g. persisting to history AND
 * printing live status to the terminal at once - see cli/console-audit-sink.ts. */
export class FanOutAuditSink implements AuditSink {
  constructor(private readonly sinks: AuditSink[]) {}

  async append(event: AuditEvent): Promise<void> {
    await Promise.all(this.sinks.map((sink) => sink.append(event)));
  }
}

export interface AuditLoggerOptions {
  storeRawContent: boolean;
}

/**
 * Default (storeRawContent: false) records only hashes/lengths of prompts and
 * provider responses, never the text itself (spec section 71/72 - Task
 * Specifications and raw provider output can contain internal/sensitive
 * information). When explicitly opted in, raw text is scrubbed via scrubSecrets()
 * first regardless.
 */
export class AuditLogger {
  private sequence = 0;

  constructor(
    private readonly sink: AuditSink,
    private readonly options: AuditLoggerOptions = { storeRawContent: false },
  ) {}

  async record(taskId: string, type: AuditEventType, data: Record<string, unknown> = {}): Promise<void> {
    this.sequence += 1;
    const event = {
      eventId: `evt_${taskId}_${this.sequence}`,
      sequence: this.sequence,
      taskId,
      type,
      timestamp: new Date().toISOString(),
      data: this.sanitize(data),
    };
    try {
      await this.sink.append(event);
    } catch (cause) {
      // The audit trail is load-bearing for this project's whole trust model (spec
      // 69-72: append-only, never silently bypassed) - a write failure (disk full,
      // DB locked/corrupted) must surface as a typed, unmistakable error rather
      // than propagate whatever raw exception the underlying sink happened to
      // throw (e.g. a bare node:sqlite error object with no `.code`), which every
      // other caller in this codebase already assumes is a DispatcherError.
      if (isDispatcherError(cause)) throw cause;
      throw new DispatcherError({
        code: 'AUDIT_WRITE_FAILED',
        message: `Failed to write audit event "${type}" for task ${taskId}: ${(cause as Error).message}`,
        cause,
        taskId,
        retryable: false,
      });
    }
  }

  recordPromptMetadata(taskId: string, type: AuditEventType, promptText: string): Promise<void> {
    return this.record(taskId, type, {
      promptSha256: shortHash(promptText),
      promptLength: promptText.length,
      ...(this.options.storeRawContent ? { promptText: scrubSecrets(promptText) } : {}),
    });
  }

  recordResponseMetadata(taskId: string, type: AuditEventType, responseText: string): Promise<void> {
    return this.record(taskId, type, {
      responseSha256: shortHash(responseText),
      responseLength: responseText.length,
      ...(this.options.storeRawContent ? { responseText: scrubSecrets(responseText) } : {}),
    });
  }

  private sanitize(data: Record<string, unknown>): Record<string, unknown> {
    return sanitizeAuditValue(data, this.options.storeRawContent, new WeakSet(), 0) as Record<string, unknown>;
  }
}

function sanitizeAuditValue(
  value: unknown,
  storeRawContent: boolean,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (typeof value === 'string') {
    if (!storeRawContent && value.length > 200) return '[large text omitted]';
    return scrubSecrets(value);
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 8) return '[nested data omitted]';
  if (seen.has(value)) return '[circular reference omitted]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeAuditValue(entry, storeRawContent, seen, depth + 1));
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' && /password|token|secret|api[_-]?key|authorization/i.test(key)) {
      result[key] = '[REDACTED]';
    } else if (key === 'error') {
      // storeRawContent (diagnostics.logPrompts) exists to keep AI-generated prompt/
      // response text out of the audit log, not to hide *why* a task failed - an
      // error's own message is diagnostic metadata, not model content. Truncating it
      // the same way silently defeats `inspect`/the live console sink exactly when
      // they matter most (live-reproduced: a local-provider failure's real cause was
      // "[large text omitted]" everywhere by default). scrubSecrets still runs on
      // every string inside via the recursive call, so a leaked token embedded in an
      // error message is still caught regardless.
      result[key] = sanitizeAuditValue(entry, true, seen, depth + 1);
    } else {
      result[key] = sanitizeAuditValue(entry, storeRawContent, seen, depth + 1);
    }
  }
  return result;
}
