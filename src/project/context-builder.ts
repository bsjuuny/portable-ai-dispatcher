import type { DispatcherTask } from '../models/task.js';
import type { TaskContext } from '../models/context.js';
import { analyzeProject } from './analyzer.js';
import { ProjectMemory, defaultMemoryPath } from './memory.js';
import { windowLargeText, DEFAULT_WINDOWING_OPTIONS, type WindowingOptions } from './log-windowing.js';

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
  const project = await analyzeProject(task.workingDirectory);

  const memory = new ProjectMemory(options.memoryPath ?? defaultMemoryPath(task.workingDirectory));
  const memorySnippets = await memory.relevantTo(task.specification.rawDescription);

  const windowedAttachments = task.specification.attachments
    .filter((a) => a.content !== undefined)
    .map((a) => windowLargeText(a.id, a.content ?? '', options.windowing ?? DEFAULT_WINDOWING_OPTIONS));

  return {
    project,
    attachments: task.specification.attachments,
    windowedAttachments,
    memorySnippets,
    relatedFiles: task.specification.sourcePaths,
  };
}
