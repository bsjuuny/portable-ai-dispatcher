import { describe, expect, it } from 'vitest';
import { isRateLimitStatus, isRateLimitText } from '../../src/providers/rate-limit-detection.js';

describe('isRateLimitText', () => {
  it('matches the real Codex usage-limit phrasing', () => {
    expect(isRateLimitText("You've hit your usage limit. Upgrade to Pro...")).toBe(true);
  });

  it('matches common rate-limit phrasings across providers', () => {
    expect(isRateLimitText('Rate limit exceeded, please slow down')).toBe(true);
    expect(isRateLimitText('rate_limit_error: too many requests')).toBe(true);
    expect(isRateLimitText('429 Too Many Requests')).toBe(true);
    expect(isRateLimitText('quota exceeded for this billing period')).toBe(true);
    expect(isRateLimitText('overloaded_error: the API is temporarily overloaded')).toBe(true);
    expect(isRateLimitText('RESOURCE_EXHAUSTED: quota exceeded')).toBe(true);
  });

  it('combines multiple text fragments before matching', () => {
    expect(isRateLimitText('generic failure', undefined, 'contains rate limit info')).toBe(true);
  });

  it('does not match unrelated failure text', () => {
    expect(isRateLimitText('crashed unexpectedly')).toBe(false);
    expect(isRateLimitText('permission denied')).toBe(false);
    expect(isRateLimitText(undefined, null)).toBe(false);
  });
});

describe('isRateLimitStatus', () => {
  it('matches HTTP 429 as number or string', () => {
    expect(isRateLimitStatus(429)).toBe(true);
    expect(isRateLimitStatus('429')).toBe(true);
  });

  it('does not match other status codes', () => {
    expect(isRateLimitStatus(404)).toBe(false);
    expect(isRateLimitStatus(500)).toBe(false);
    expect(isRateLimitStatus(undefined)).toBe(false);
    expect(isRateLimitStatus(null)).toBe(false);
  });
});
