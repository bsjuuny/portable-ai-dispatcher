import { describe, expect, it } from 'vitest';
import { parseReviewResponse } from '../../src/review/review-schema.js';

describe('parseReviewResponse', () => {
  it('parses a well-formed fenced json block', () => {
    const text = [
      'I reviewed the change and found one issue.',
      '```json',
      JSON.stringify({
        verdict: 'request_changes',
        findings: [{ severity: 'error', category: 'null-safety', message: 'user may be null here' }],
      }),
      '```',
    ].join('\n');

    const result = parseReviewResponse(text);
    expect(result.verdict).toBe('request_changes');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.category).toBe('null-safety');
  });

  it('uses the LAST fenced json block when multiple are present (reasoning may include example blocks)', () => {
    const text = [
      '```json',
      JSON.stringify({ verdict: 'critical', findings: [] }),
      '```',
      'Actually let me reconsider...',
      '```json',
      JSON.stringify({ verdict: 'approve', findings: [] }),
      '```',
    ].join('\n');

    const result = parseReviewResponse(text);
    expect(result.verdict).toBe('approve');
  });

  it('falls back to a single info finding when no valid JSON is found, rather than throwing', () => {
    const text = 'This looks fine to me, no structured output today.';
    const result = parseReviewResponse(text);
    expect(result.verdict).toBe('approve_with_warning');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.category).toBe('review-format');
  });

  it('falls back gracefully when the fenced block contains invalid JSON', () => {
    const text = '```json\n{ this is not valid json \n```';
    const result = parseReviewResponse(text);
    expect(result.verdict).toBe('approve_with_warning');
  });

  it('falls back gracefully when the fenced block is valid JSON but does not match the schema', () => {
    const text = '```json\n{"foo": "bar"}\n```';
    const result = parseReviewResponse(text);
    expect(result.verdict).toBe('approve_with_warning');
    expect(result.findings[0]!.category).toBe('review-format');
  });
});
