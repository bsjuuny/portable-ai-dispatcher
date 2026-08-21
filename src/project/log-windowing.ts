import { createHash } from 'node:crypto';
import type { ContextWindow, WindowedAttachment } from '../models/context.js';

export interface WindowingOptions {
  maxInlineLines: number;
  contextLines: number;
  mergeThresholdLines: number;
  maxTotalWindowLines: number;
}

export const DEFAULT_WINDOWING_OPTIONS: WindowingOptions = {
  maxInlineLines: 500,
  contextLines: 15,
  mergeThresholdLines: 5,
  maxTotalWindowLines: 400,
};

const ERROR_KEYWORD_RE = /\b(Error|Exception|Traceback|panic:|fatal:|FAIL\b)/;
const STACK_TRACE_RE = /^\s*(at\s+\S+.*\(.*\)|File\s+".*",\s+line\s+\d+|#\d+\s+0x[0-9a-f]+)/;
const FAILED_TEST_RE = /(✗|FAIL\s|not ok\b|AssertionError|Expected .* Received|^FAILED\s|\d+\s+failing)/;

interface Anchor {
  line: number;
  reason: ContextWindow['reason'];
  priority: number;
}

const REASON_PRIORITY: Record<ContextWindow['reason'], number> = {
  'failed-test': 3,
  'stack-trace': 2,
  'error-keyword': 1,
  'explicit-range': 0,
  'head-tail-fallback': 0,
};

/**
 * Pure function, no I/O - see docs/architecture.md section 5. Short input passes
 * through whole; otherwise finds anchor lines (error keywords, stack trace frames,
 * failed-test markers), expands to symmetric windows, merges nearby windows, dedups
 * byte-identical repeats (common when a retry loop re-attaches the same failure),
 * caps total kept lines by detector priority, and falls back to head+tail windowing
 * when nothing is found at all (e.g. a large clean build log).
 */
export function windowLargeText(
  attachmentId: string,
  text: string,
  options: WindowingOptions = DEFAULT_WINDOWING_OPTIONS,
): WindowedAttachment {
  const lines = text.split(/\r?\n/);
  const totalLineCount = lines.length;

  if (totalLineCount <= options.maxInlineLines) {
    return {
      attachmentId,
      windows: [{ reason: 'explicit-range', startLine: 1, endLine: totalLineCount, text }],
      totalLineCount,
      keptLineCount: totalLineCount,
      dedupedLineCount: 0,
      truncated: false,
    };
  }

  const anchors = findAnchors(lines);
  if (anchors.length === 0) {
    return headTailFallback(attachmentId, lines, totalLineCount);
  }

  const expanded = expandAnchors(anchors, lines.length, options.contextLines);
  const merged = mergeRanges(expanded, options.mergeThresholdLines);

  let windows = merged.map((range) => toWindow(range, lines));
  const { deduped, dedupedLineCount } = dedupeWindows(windows);
  windows = deduped;

  const keptLineCount = windows.reduce((sum, w) => sum + (w.endLine - w.startLine + 1), 0);
  let truncated = false;

  if (keptLineCount > options.maxTotalWindowLines) {
    windows = capByPriority(windows, options.maxTotalWindowLines);
    truncated = true;
  }

  return {
    attachmentId,
    windows,
    totalLineCount,
    keptLineCount: windows.reduce((sum, w) => sum + (w.endLine - w.startLine + 1), 0),
    dedupedLineCount,
    truncated,
  };
}

function findAnchors(lines: string[]): Anchor[] {
  const anchors: Anchor[] = [];
  lines.forEach((line, index) => {
    const lineNo = index + 1;
    if (FAILED_TEST_RE.test(line)) {
      anchors.push({ line: lineNo, reason: 'failed-test', priority: REASON_PRIORITY['failed-test'] });
    } else if (STACK_TRACE_RE.test(line)) {
      anchors.push({ line: lineNo, reason: 'stack-trace', priority: REASON_PRIORITY['stack-trace'] });
    } else if (ERROR_KEYWORD_RE.test(line)) {
      anchors.push({ line: lineNo, reason: 'error-keyword', priority: REASON_PRIORITY['error-keyword'] });
    }
  });
  return anchors;
}

interface Range {
  start: number;
  end: number;
  reason: ContextWindow['reason'];
  priority: number;
}

function expandAnchors(anchors: Anchor[], totalLines: number, contextLines: number): Range[] {
  return anchors.map((a) => ({
    start: Math.max(1, a.line - contextLines),
    end: Math.min(totalLines, a.line + contextLines),
    reason: a.reason,
    priority: a.priority,
  }));
}

function mergeRanges(ranges: Range[], mergeThreshold: number): Range[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: Range[] = [];

  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range.start - last.end <= mergeThreshold) {
      last.end = Math.max(last.end, range.end);
      if (range.priority > last.priority) {
        last.reason = range.reason;
        last.priority = range.priority;
      }
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function toWindow(range: Range, lines: string[]): ContextWindow {
  return {
    reason: range.reason,
    startLine: range.start,
    endLine: range.end,
    text: lines.slice(range.start - 1, range.end).join('\n'),
  };
}

function dedupeWindows(windows: ContextWindow[]): { deduped: ContextWindow[]; dedupedLineCount: number } {
  const seen = new Set<string>();
  const deduped: ContextWindow[] = [];
  let dedupedLineCount = 0;

  for (const window of windows) {
    const hash = createHash('sha256').update(window.text).digest('hex');
    if (seen.has(hash)) {
      dedupedLineCount += window.endLine - window.startLine + 1;
      continue;
    }
    seen.add(hash);
    deduped.push(window);
  }
  return { deduped, dedupedLineCount };
}

function capByPriority(windows: ContextWindow[], maxLines: number): ContextWindow[] {
  // Higher priority first, then more-recent-in-file first (later start line = more recent).
  const ranked = [...windows].sort((a, b) => {
    const priorityDiff = REASON_PRIORITY[b.reason] - REASON_PRIORITY[a.reason];
    if (priorityDiff !== 0) return priorityDiff;
    return b.startLine - a.startLine;
  });

  const kept: ContextWindow[] = [];
  let used = 0;
  for (const window of ranked) {
    const size = window.endLine - window.startLine + 1;
    if (used + size > maxLines && kept.length > 0) continue;
    kept.push(window);
    used += size;
  }
  return kept.sort((a, b) => a.startLine - b.startLine);
}

function headTailFallback(attachmentId: string, lines: string[], totalLineCount: number): WindowedAttachment {
  const headSize = 50;
  const tailSize = 150;
  const headEnd = Math.min(headSize, totalLineCount);
  const tailStart = Math.max(headEnd + 1, totalLineCount - tailSize + 1);

  const windows: ContextWindow[] = [
    { reason: 'head-tail-fallback', startLine: 1, endLine: headEnd, text: lines.slice(0, headEnd).join('\n') },
  ];
  if (tailStart > headEnd) {
    windows.push({
      reason: 'head-tail-fallback',
      startLine: tailStart,
      endLine: totalLineCount,
      text: lines.slice(tailStart - 1).join('\n'),
    });
  }

  const keptLineCount = windows.reduce((sum, w) => sum + (w.endLine - w.startLine + 1), 0);
  return {
    attachmentId,
    windows,
    totalLineCount,
    keptLineCount,
    dedupedLineCount: 0,
    truncated: keptLineCount < totalLineCount,
  };
}
