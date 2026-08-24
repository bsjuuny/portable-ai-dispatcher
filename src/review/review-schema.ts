import { z } from 'zod';

export const ReviewFindingSchema = z.object({
  severity: z.enum(['info', 'warning', 'error', 'critical']),
  file: z.string().optional(),
  line: z.number().optional(),
  category: z.string(),
  message: z.string(),
  recommendation: z.string().optional(),
});

export const ReviewResponseSchema = z.object({
  verdict: z.enum(['approve', 'approve_with_warning', 'request_changes', 'critical']),
  findings: z.array(ReviewFindingSchema),
});

export type ReviewResponse = z.infer<typeof ReviewResponseSchema>;

/**
 * Reviewer providers are instructed to emit a fenced ```json block as the last thing
 * in their response, so review output can be parsed reliably regardless of how much
 * free-text reasoning precedes it. Falls back to treating the whole response as a
 * blocking review-format finding if no valid JSON block is found. Autonomous apply
 * must fail closed when the reviewer cannot produce a machine-verifiable verdict.
 */
export function parseReviewResponse(text: string): ReviewResponse {
  const fenced = /```json\s*([\s\S]*?)```/g;
  let lastMatch: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = fenced.exec(text)) !== null) {
    lastMatch = match;
  }

  const candidateText = lastMatch?.[1] ?? text;
  try {
    const parsed: unknown = JSON.parse(candidateText);
    return ReviewResponseSchema.parse(parsed);
  } catch {
    return {
      verdict: 'request_changes',
      findings: [
        {
          severity: 'error',
          category: 'review-format',
          message: `Reviewer response was not valid structured JSON; raw text preserved: ${text.slice(0, 500)}`,
        },
      ],
    };
  }
}
