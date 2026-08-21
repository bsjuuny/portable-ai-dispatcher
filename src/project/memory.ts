import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { MemorySnippet } from '../models/context.js';

/**
 * JSON-file-backed project memory - no embeddings/vector search in v1.0 (documented
 * Known Limitation, spec section 55/56). Relevance ranking is recency + keyword
 * overlap only. Stores summaries/decisions/hashes, never full source copies.
 */
export interface MemoryRecord extends MemorySnippet {
  keywords: string[];
}

interface MemoryFile {
  version: 1;
  records: MemoryRecord[];
}

export class ProjectMemory {
  private cache: MemoryFile | undefined;

  constructor(private readonly filePath: string) {}

  async load(): Promise<MemoryFile> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.filePath, 'utf8');
      this.cache = JSON.parse(raw) as MemoryFile;
    } catch {
      this.cache = { version: 1, records: [] };
    }
    return this.cache;
  }

  async remember(entry: {
    summary: string;
    path?: string;
    symbol?: string;
    decision?: string;
    sourceText?: string;
  }): Promise<void> {
    const file = await this.load();
    const record: MemoryRecord = {
      summary: entry.summary,
      path: entry.path,
      symbol: entry.symbol,
      decision: entry.decision,
      hash: createHash('sha256').update(entry.sourceText ?? entry.summary).digest('hex').slice(0, 16),
      recordedAt: new Date().toISOString(),
      keywords: extractKeywords(`${entry.summary} ${entry.decision ?? ''} ${entry.symbol ?? ''}`),
    };
    file.records.push(record);
    await this.persist(file);
  }

  /** Recency + keyword-overlap ranking - no embeddings (see class docstring). */
  async relevantTo(queryText: string, limit = 5): Promise<MemorySnippet[]> {
    const file = await this.load();
    const queryKeywords = new Set(extractKeywords(queryText));

    const scored = file.records.map((record) => {
      const overlap = record.keywords.filter((k) => queryKeywords.has(k)).length;
      const ageMs = Date.now() - new Date(record.recordedAt).getTime();
      const recencyScore = 1 / (1 + ageMs / (7 * 24 * 60 * 60 * 1000)); // half-relevance per week, roughly
      return { record, score: overlap * 2 + recencyScore };
    });

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ record }) => ({
        summary: record.summary,
        path: record.path,
        symbol: record.symbol,
        decision: record.decision,
        hash: record.hash,
        recordedAt: record.recordedAt,
      }));
  }

  private async persist(file: MemoryFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(file, null, 2), 'utf8');
    this.cache = file;
  }
}

export function defaultMemoryPath(projectRoot: string): string {
  return join(projectRoot, '.dispatcher', 'project', 'memory.json');
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'to', 'of', 'in', 'and', 'or', 'for', 'on', 'with',
  '을', '를', '이', '가', '은', '는', '에', '의', '와', '과', '도',
]);

function extractKeywords(text: string): string[] {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9가-힣_.]+/i)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return [...new Set(words)];
}
