import { describe, expect, it } from 'vitest';
import { windowLargeText, DEFAULT_WINDOWING_OPTIONS } from '../../src/project/log-windowing.js';

const JAVA_STACK_TRACE = [
  'java.lang.NullPointerException: Cannot invoke User.getId() because user is null',
  '\tat com.example.service.UserService.findUser(UserService.java:128)',
  '\tat com.example.controller.UserController.login(UserController.java:74)',
].join('\n');

function bigCleanLog(lines: number): string {
  return Array.from({ length: lines }, (_, i) => `[INFO] step ${i}: everything is fine`).join('\n');
}

describe('windowLargeText', () => {
  it('passes short input through whole, unmodified', () => {
    const text = 'line1\nline2\nline3';
    const result = windowLargeText('a1', text);
    expect(result.truncated).toBe(false);
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0]!.text).toBe(text);
  });

  it('finds a stack-trace anchor and expands a window around it', () => {
    const padding = Array.from({ length: 600 }, (_, i) => `noise ${i}`).join('\n');
    const text = `${padding}\n${JAVA_STACK_TRACE}\n${padding}`;
    const result = windowLargeText('a1', text, DEFAULT_WINDOWING_OPTIONS);

    expect(result.truncated).toBe(false);
    const stackWindow = result.windows.find((w) => w.reason === 'stack-trace');
    expect(stackWindow).toBeDefined();
    expect(stackWindow!.text).toContain('NullPointerException');
    expect(stackWindow!.text).toContain('UserService.java:128');
  });

  it('falls back to head+tail windowing when no anchors are found at all', () => {
    const text = bigCleanLog(1000);
    const result = windowLargeText('a1', text);

    expect(result.truncated).toBe(true);
    expect(result.windows.every((w) => w.reason === 'head-tail-fallback')).toBe(true);
    expect(result.windows[0]!.text).toContain('step 0:');
    expect(result.windows.at(-1)!.text).toContain('step 999:');
  });

  it('dedupes byte-identical repeated windows (common when a retry loop re-attaches the same failure)', () => {
    const padding = Array.from({ length: 600 }, (_, i) => `noise ${i}`).join('\n');
    const text = `${padding}\n${JAVA_STACK_TRACE}\n${padding}\n${JAVA_STACK_TRACE}\n${padding}`;
    const result = windowLargeText('a1', text);

    const stackWindows = result.windows.filter((w) => w.reason === 'stack-trace' && w.text.includes('NullPointerException'));
    expect(stackWindows).toHaveLength(1);
    expect(result.dedupedLineCount).toBeGreaterThan(0);
  });

  it('merges nearby anchors into a single window instead of two overlapping ones', () => {
    const lines = Array.from({ length: 700 }, (_, i) => `line ${i}`);
    lines[300] = 'Error: first problem';
    lines[305] = 'Error: second problem nearby'; // within contextLines (15) of the first
    const result = windowLargeText('a1', lines.join('\n'));

    const errorWindows = result.windows.filter((w) => w.text.includes('problem'));
    expect(errorWindows).toHaveLength(1);
    expect(errorWindows[0]!.text).toContain('first problem');
    expect(errorWindows[0]!.text).toContain('second problem');
  });

  it('caps total kept lines and prioritizes failed-test over error-keyword anchors when truncating', () => {
    const lines: string[] = [];
    for (let i = 0; i < 50; i += 1) {
      lines.push(...Array.from({ length: 40 }, (_, j) => `filler ${i}-${j}`));
      lines.push(`Error: generic error number ${i}`);
    }
    lines.push(...Array.from({ length: 40 }, (_, j) => `filler-end ${j}`));
    lines.push('FAIL test_something_important');

    const result = windowLargeText('a1', lines.join('\n'), { ...DEFAULT_WINDOWING_OPTIONS, maxTotalWindowLines: 100 });

    expect(result.truncated).toBe(true);
    const hasFailedTest = result.windows.some((w) => w.reason === 'failed-test');
    expect(hasFailedTest).toBe(true);
  });

  it('is a pure function: identical input always produces identical output', () => {
    const text = `${bigCleanLog(600)}\n${JAVA_STACK_TRACE}`;
    const a = windowLargeText('a1', text);
    const b = windowLargeText('a1', text);
    expect(a).toEqual(b);
  });
});
