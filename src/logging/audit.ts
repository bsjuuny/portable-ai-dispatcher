import { scrubSecrets, shortHash } from './redaction.js';

// Spec section 69 - the full event taxonomy, append-only (section 70: existing
// events are never modified, only new ones added).
export type AuditEventType =
  | 'task.created'
  | 'task.classified'
  | 'project.context.loaded'
  | 'provider.health.checked'
  | 'provider.usage.checked'
  | 'provider.selected'
  | 'provider.execution.started'
  | 'provider.execution.completed'
  | 'provider.execution.failed'
  | 'provider.execution.timeout'
  | 'retry.started'
  | 'retry.completed'
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
  | 'task.failed'
  | 'task.cancelled';

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
    await this.sink.append({
      eventId: `evt_${taskId}_${this.sequence}`,
      sequence: this.sequence,
      taskId,
      type,
      timestamp: new Date().toISOString(),
      data: this.sanitize(data),
    });
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
    if (this.options.storeRawContent) return data;
    // Even outside the explicit prompt/response helpers above, defensively scrub any
    // string field that looks like it might carry raw provider/user text - this is a
    // second layer, not the only one.
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      sanitized[key] = typeof value === 'string' && value.length > 200 ? '[large text omitted]' : value;
    }
    return sanitized;
  }
}
