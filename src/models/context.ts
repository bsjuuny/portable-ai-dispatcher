import type { TaskAttachment } from './task.js';
import type { TaskResult } from './result.js';
import type { ValidationResult } from './validation.js';
import type { ReviewResult } from './review.js';
import type { RepositoryMetrics } from './classification.js';

export interface ProjectContext {
  root: string;
  isGitRepo: boolean;
  language?: string;
  framework?: string;
  buildTool?: string;
  packageManager?: string;
  testFramework?: string;
  metrics?: RepositoryMetrics;
  commands: {
    lint?: string[];
    typecheck?: string[];
    build?: string[];
    test?: string[];
  };
}

export interface MemorySnippet {
  summary: string;
  path?: string;
  symbol?: string;
  decision?: string;
  hash: string;
  recordedAt: string;
}

export interface ContextWindow {
  reason: 'error-keyword' | 'stack-trace' | 'failed-test' | 'explicit-range' | 'head-tail-fallback';
  startLine: number;
  endLine: number;
  text: string;
}

export interface WindowedAttachment {
  attachmentId: string;
  windows: ContextWindow[];
  totalLineCount: number;
  keptLineCount: number;
  dedupedLineCount: number;
  truncated: boolean;
}

/** A bounded, name-only listing assembled by Dispatcher for a folder-inventory
 * question. It never includes file contents or common secret/build directories. */
export interface DirectoryInventory {
  root: string;
  entries: string[];
  omittedEntryCount: number;
}

export interface TaskContext {
  project?: ProjectContext;
  relatedFiles?: string[];
  attachments?: TaskAttachment[];
  windowedAttachments?: WindowedAttachment[];
  directoryInventory?: DirectoryInventory[];
  memorySnippets?: MemorySnippet[];
  previousResults?: TaskResult[];
  validationResults?: ValidationResult[];
  reviewResults?: ReviewResult[];
  metadata?: Record<string, unknown>;
}
