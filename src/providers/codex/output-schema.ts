import { z } from 'zod';

/**
 * Based on REAL captured output from `codex -a never -s read-only exec --json` (see
 * docs/fixtures/raw-probes/codex-output-jsonl.jsonl) - the error path
 * (thread.started / turn.started / error / turn.failed) was verified live twice
 * against the actually-installed CLI (0.130.0).
 *
 * The success path (a completed turn with an assistant message) could NOT be
 * verified live: the configured account had hit its usage limit during
 * implementation (see docs/fixtures/raw-probes/codex-stderr.log). Rather than invent
 * a shape from memory, event types other than the verified ones are accepted via a
 * loose passthrough schema, and the final answer text is read from the
 * --output-last-message file (see command-builder.ts) instead of being extracted
 * from a guessed JSONL event field. This is a documented Known Limitation until the
 * rate limit resets and the success-path schema can be tightened from a real sample.
 */
export const CodexThreadStartedSchema = z
  .object({ type: z.literal('thread.started'), thread_id: z.string() })
  .passthrough();

export const CodexTurnStartedSchema = z.object({ type: z.literal('turn.started') }).passthrough();

export const CodexErrorEventSchema = z
  .object({ type: z.literal('error'), message: z.string() })
  .passthrough();

export const CodexTurnFailedSchema = z
  .object({
    type: z.literal('turn.failed'),
    error: z.object({ message: z.string() }).passthrough(),
  })
  .passthrough();

const CodexLooseEventSchema = z.object({ type: z.string() }).passthrough();

export interface CodexParsedStream {
  threadId?: string;
  errors: string[];
  failed: boolean;
  events: Array<{ type: string; raw: unknown }>;
}

/**
 * Parses Codex's --json JSONL output defensively: lines that are not valid JSON are
 * skipped rather than aborting the whole parse (this environment has been observed
 * to mix plugin/notify-hook text - garbled Korean process-exit notices - into
 * stdout alongside the real JSONL, unrelated to the dispatcher itself).
 */
export function parseCodexStream(raw: string): CodexParsedStream {
  const result: CodexParsedStream = { errors: [], failed: false, events: [] };

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let candidate: unknown;
    try {
      candidate = JSON.parse(line);
    } catch {
      continue;
    }
    const loose = CodexLooseEventSchema.safeParse(candidate);
    if (!loose.success) continue;

    result.events.push({ type: loose.data.type, raw: candidate });

    if (loose.data.type === 'thread.started') {
      const parsed = CodexThreadStartedSchema.safeParse(candidate);
      if (parsed.success) result.threadId = parsed.data.thread_id;
    } else if (loose.data.type === 'error') {
      const parsed = CodexErrorEventSchema.safeParse(candidate);
      if (parsed.success) result.errors.push(parsed.data.message);
    } else if (loose.data.type === 'turn.failed') {
      const parsed = CodexTurnFailedSchema.safeParse(candidate);
      result.failed = true;
      if (parsed.success) result.errors.push(parsed.data.error.message);
    }
  }

  return result;
}
