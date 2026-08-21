import { z } from 'zod';

/**
 * Based on real captured output (docs/fixtures/raw-probes/claude-output-json.json,
 * claude-output-stream-json.jsonl) from `claude -p ... --output-format json` and
 * `--output-format stream-json` against the actually-installed CLI (2.1.234) - not
 * written from documentation or guesses (spec requirement 33/section 10).
 *
 * The final "result" event is the one this dispatcher actually depends on and is
 * validated strictly. Other stream-json event types (system/init, rate_limit_event,
 * assistant, and any not yet observed - e.g. tool_use in sessions that use tools) are
 * accepted loosely via passthrough, since a new event type appearing in a future CLI
 * version must not break parsing of the result we actually need.
 */
export const ClaudeResultEventSchema = z
  .object({
    type: z.literal('result'),
    is_error: z.boolean(),
    subtype: z.string(),
    result: z.string().optional(),
    session_id: z.string(),
    duration_ms: z.number(),
    duration_api_ms: z.number().optional(),
    num_turns: z.number().optional(),
    stop_reason: z.string().nullable().optional(),
    total_cost_usd: z.number().optional(),
    usage: z
      .object({
        input_tokens: z.number().optional(),
        output_tokens: z.number().optional(),
        cache_creation_input_tokens: z.number().optional(),
        cache_read_input_tokens: z.number().optional(),
      })
      .passthrough()
      .optional(),
    permission_denials: z.array(z.unknown()).optional(),
    api_error_status: z.union([z.string(), z.number()]).nullable().optional(),
  })
  .passthrough();

export type ClaudeResultEvent = z.infer<typeof ClaudeResultEventSchema>;

const ClaudeLooseEventSchema = z.object({ type: z.string() }).passthrough();

/** Parses a single `--output-format json` payload (one JSON object, not JSONL). */
export function parseClaudeJsonOutput(raw: string): ClaudeResultEvent {
  const parsed: unknown = JSON.parse(raw);
  return ClaudeResultEventSchema.parse(parsed);
}

/**
 * Parses `--output-format stream-json` JSONL: one JSON object per line. Lines that
 * fail to parse as JSON (stray plugin/notify-hook output mixed into stdout has been
 * observed from Codex in this environment; Claude has not shown this, but the parser
 * stays defensive) are skipped rather than aborting the whole stream, and the final
 * `result`-typed line is what's returned.
 */
export function parseClaudeStreamJsonOutput(raw: string): ClaudeResultEvent {
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  let resultEvent: ClaudeResultEvent | undefined;

  for (const line of lines) {
    let candidate: unknown;
    try {
      candidate = JSON.parse(line);
    } catch {
      continue;
    }
    const loose = ClaudeLooseEventSchema.safeParse(candidate);
    if (loose.success && loose.data.type === 'result') {
      resultEvent = ClaudeResultEventSchema.parse(candidate);
    }
  }

  if (!resultEvent) {
    throw new Error('No "result" event found in Claude stream-json output.');
  }
  return resultEvent;
}
