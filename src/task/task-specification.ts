import type { StructuredSpecification, TaskSpecification } from '../models/task.js';

const ERROR_CODE_RE = /\b[A-Z][A-Z0-9]*(?:[-_][A-Z0-9]+){1,4}\b/g;
const STACK_FRAME_RE =
  /^\s*(at\s+\S+.*\(.*\)|File\s+".*",\s+line\s+\d+|#\d+\s+0x[0-9a-f]+|\s+at\s+.*:\d+:\d+)/;
const REQUIREMENT_LINE_RE = /^\s*[-*•]\s*(.+)$/;

/**
 * Extracts best-effort structure from raw task text WITHOUT ever discarding the
 * original. `rawDescription` is always preserved verbatim on TaskSpecification so a
 * provider can fall back to it if this classification misses something - see
 * requirement 21 (Task Specification 원문 보존).
 */
export function parseStructuredSpecification(rawDescription: string): StructuredSpecification {
  const lines = rawDescription.split(/\r?\n/);

  const errorCodes = uniq(rawDescription.match(ERROR_CODE_RE) ?? []);
  const stackTraces = extractStackTraceBlocks(lines);
  const reproductionSteps = extractNumberedSteps(lines);
  const requirements = extractBulletedLines(lines);
  const constraints = requirements.filter((line) => /금지|필수|must not|must|cannot|never/i.test(line));
  const acceptanceCriteria = extractSectionLines(rawDescription, /acceptance criteria|검증 조건/i);

  const summary = lines.find((line) => line.trim().length > 0)?.trim();

  return {
    summary,
    errorCodes: errorCodes.length ? errorCodes : undefined,
    stackTraces: stackTraces.length ? stackTraces : undefined,
    reproductionSteps: reproductionSteps.length ? reproductionSteps : undefined,
    requirements: requirements.length ? requirements : undefined,
    constraints: constraints.length ? constraints : undefined,
    acceptanceCriteria: acceptanceCriteria.length ? acceptanceCriteria : undefined,
  };
}

export function buildTaskSpecification(params: {
  rawDescription: string;
  sourcePaths?: string[];
}): TaskSpecification {
  return {
    rawDescription: params.rawDescription,
    structured: parseStructuredSpecification(params.rawDescription),
    attachments: [],
    sourcePaths: params.sourcePaths ?? [],
  };
}

function extractStackTraceBlocks(lines: string[]): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (STACK_FRAME_RE.test(line)) {
      current.push(line.trim());
    } else if (current.length > 0) {
      blocks.push(current.join('\n'));
      current = [];
    }
  }
  if (current.length > 0) blocks.push(current.join('\n'));
  return blocks;
}

function extractNumberedSteps(lines: string[]): string[] {
  const steps: string[] = [];
  for (const line of lines) {
    const match = /^\s*\d+[.)]\s*(.+)$/.exec(line);
    if (match?.[1]) steps.push(match[1].trim());
  }
  return steps;
}

function extractBulletedLines(lines: string[]): string[] {
  const items: string[] = [];
  for (const line of lines) {
    const match = REQUIREMENT_LINE_RE.exec(line);
    if (match?.[1]) items.push(match[1].trim());
  }
  return items;
}

function extractSectionLines(text: string, headingPattern: RegExp): string[] {
  const lines = text.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => headingPattern.test(line));
  if (headingIndex === -1) return [];
  const items: string[] = [];
  for (let i = headingIndex + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (/^#|^##/.test(line.trim())) break;
    const match = REQUIREMENT_LINE_RE.exec(line);
    if (match?.[1]) items.push(match[1].trim());
  }
  return items;
}

function uniq(values: string[]): string[] {
  return [...new Set(values)];
}
