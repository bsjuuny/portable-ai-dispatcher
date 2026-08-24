import { DispatcherError } from '../models/error.js';

export type RepositoryLockMode = 'write';

export interface RepositoryLockHandle {
  repositoryId: string;
  taskId: string;
  mode: RepositoryLockMode;
  acquiredAt: string;
}

/**
 * Per-process, in-memory only - same explicit v1.0-style limitation as
 * routing/circuit-breaker.ts (see its comment and README "Known Limitations"):
 * a second `ai-dispatcher` process is not coordinated with, since each CLI
 * invocation is short-lived and there is no shared store for v1.0/this
 * increment. Within a single process, this is still real protection against two
 * concurrent code-changing tasks racing to apply into the same repository.
 */
export class RepositoryLock {
  private readonly held = new Map<string, RepositoryLockHandle>();

  acquire(repositoryId: string, taskId: string): RepositoryLockHandle {
    const existing = this.held.get(repositoryId);
    if (existing) {
      throw new DispatcherError({
        code: 'REPOSITORY_LOCKED',
        message: `Repository "${repositoryId}" is already locked by task ${existing.taskId} (acquired ${existing.acquiredAt}).`,
        taskId,
        retryable: true,
      });
    }
    const handle: RepositoryLockHandle = { repositoryId, taskId, mode: 'write', acquiredAt: new Date().toISOString() };
    this.held.set(repositoryId, handle);
    return handle;
  }

  release(handle: RepositoryLockHandle): void {
    const current = this.held.get(handle.repositoryId);
    if (current === handle) this.held.delete(handle.repositoryId);
  }

  isLocked(repositoryId: string): boolean {
    return this.held.has(repositoryId);
  }
}
