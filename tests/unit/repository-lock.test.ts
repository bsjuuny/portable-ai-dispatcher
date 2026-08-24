import { describe, expect, it } from 'vitest';
import { RepositoryLock } from '../../src/safety/repository-lock.js';
import { isDispatcherError } from '../../src/models/error.js';

describe('RepositoryLock', () => {
  it('grants the lock when nothing else holds it', () => {
    const lock = new RepositoryLock();
    const handle = lock.acquire('/repo', 'task-1');
    expect(handle.repositoryId).toBe('/repo');
    expect(handle.taskId).toBe('task-1');
    expect(lock.isLocked('/repo')).toBe(true);
  });

  it('rejects a second acquire on the same repository as retryable REPOSITORY_LOCKED', () => {
    const lock = new RepositoryLock();
    lock.acquire('/repo', 'task-1');
    try {
      lock.acquire('/repo', 'task-2');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isDispatcherError(error)).toBe(true);
      if (isDispatcherError(error)) {
        expect(error.code).toBe('REPOSITORY_LOCKED');
        expect(error.retryable).toBe(true);
      }
    }
  });

  it('allows a different repository to be locked independently', () => {
    const lock = new RepositoryLock();
    lock.acquire('/repo-a', 'task-1');
    expect(() => lock.acquire('/repo-b', 'task-2')).not.toThrow();
  });

  it('allows re-acquiring after release', () => {
    const lock = new RepositoryLock();
    const handle = lock.acquire('/repo', 'task-1');
    lock.release(handle);
    expect(lock.isLocked('/repo')).toBe(false);
    expect(() => lock.acquire('/repo', 'task-2')).not.toThrow();
  });

  it('release() is a no-op for a stale handle that no longer matches the currently held lock', () => {
    const lock = new RepositoryLock();
    const staleHandle = lock.acquire('/repo', 'task-1');
    lock.release(staleHandle);
    const newHandle = lock.acquire('/repo', 'task-2');
    lock.release(staleHandle); // must not release task-2's lock
    expect(lock.isLocked('/repo')).toBe(true);
    lock.release(newHandle);
    expect(lock.isLocked('/repo')).toBe(false);
  });
});
