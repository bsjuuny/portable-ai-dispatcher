import type { DispatcherTask } from '../models/task.js';
import type { TaskContext } from '../models/context.js';
import { analyzeProject } from './analyzer.js';
import { ProjectMemory, defaultMemoryPath } from './memory.js';
import { windowLargeText, DEFAULT_WINDOWING_OPTIONS, type WindowingOptions } from './log-windowing.js';
import { measureRepository } from './repository-metrics.js';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { DirectoryInventory } from '../models/context.js';

export interface ContextBuilderOptions {
  windowing?: WindowingOptions;
  memoryPath?: string;
}

/**
 * Composes TaskContext from the task specification and project state. Never
 * attaches the whole repository (spec section 57) - only project metadata,
 * relevant memory snippets, and windowed attachment content.
 */
export async function buildTaskContext(
  task: DispatcherTask,
  options: ContextBuilderOptions = {},
): Promise<TaskContext> {
  const [baseProject, metrics] = await Promise.all([
    analyzeProject(task.workingDirectory),
    measureRepository(task.workingDirectory),
  ]);
  const project = { ...baseProject, metrics };

  const memory = new ProjectMemory(options.memoryPath ?? defaultMemoryPath(task.workingDirectory));
  const memorySnippets = await memory.relevantTo(task.specification.rawDescription);

  const windowedAttachments = task.specification.attachments
    .filter((a) => a.content !== undefined)
    .map((a) => windowLargeText(a.id, a.content ?? '', options.windowing ?? DEFAULT_WINDOWING_OPTIONS));
  const directoryInventory = await buildDirectoryInventory(task);

  return {
    project,
    attachments: task.specification.attachments,
    windowedAttachments,
    ...(directoryInventory.length ? { directoryInventory } : {}),
    memorySnippets,
    relatedFiles: task.specification.sourcePaths,
  };
}

const FOLDER_INVENTORY_REQUEST = /(?:폴더|디렉터리|디렉토리|파일\s*(?:목록|리스트|확인)|(?:내용|구성)\s*확인|folder|directory|list\s+(?:files|contents)|what(?:'s| is)\s+in\s+(?:this\s+)?(?:folder|directory))/i;
const EXCLUDED_INVENTORY_ENTRIES = new Set(['.git', '.dispatcher', 'node_modules', 'dist', 'build', 'coverage']);
const MAX_INVENTORY_ENTRIES = 80;

async function buildDirectoryInventory(task: DispatcherTask): Promise<DirectoryInventory[]> {
  if (!FOLDER_INVENTORY_REQUEST.test(task.specification.rawDescription)) return [];
  const candidates = task.specification.sourcePaths.length
    ? task.specification.sourcePaths
    : [task.workingDirectory];
  const result: DirectoryInventory[] = [];
  for (const candidate of [...new Set(candidates.map((path) => resolve(path)))]) {
    try {
      const entries = (await readdir(candidate, { withFileTypes: true }))
        .filter((entry) => !EXCLUDED_INVENTORY_ENTRIES.has(entry.name) && !entry.name.startsWith('.env'))
        .sort((a, b) => a.name.localeCompare(b.name));
      result.push({
        root: candidate,
        entries: entries.slice(0, MAX_INVENTORY_ENTRIES).map((entry) => `${entry.isDirectory() ? '[dir] ' : '[file] '}${entry.name}`),
        omittedEntryCount: Math.max(0, entries.length - MAX_INVENTORY_ENTRIES),
      });
    } catch {
      // A task can name a regular file via --path; omit unreadable/non-directory
      // candidates rather than failing a general natural-language inquiry.
    }
  }
  return result;
}
