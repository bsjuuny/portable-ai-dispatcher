import type { DispatcherTask } from '../models/task.js';
import type { TaskContext } from '../models/context.js';
import type { TaskResult } from '../models/result.js';
import type { ProviderCapability, ProviderHealth, ProviderId, ProviderUsage } from '../models/provider.js';
import type { ProcessOutcome } from '../process/process-runner.js';
import { DispatcherError } from '../models/error.js';

export interface ProviderRunOptions {
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  approval: 'untrusted' | 'on-request' | 'never';
  model?: string;
  maxBudgetUsd?: number;
  timeoutMs: number;
}

export interface ProviderCommandPlan {
  file: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  stdinContent?: string;
  /** Provider-specific data a command builder needs back at parse time (e.g. Codex's
   * --output-last-message temp file path). Never used for anything security-relevant
   * - it does not affect argv construction, only post-execution parsing. */
  metadata?: Record<string, unknown>;
}

/**
 * Every provider-specific decision (CLI flags, output parsing, auth check) lives
 * behind this interface. Dispatcher Core (routing/task/validation/review) never
 * imports a concrete provider class and never branches on provider id - see
 * docs/architecture.md.
 */
export interface AIProvider {
  readonly id: ProviderId;

  capabilities(): ProviderCapability[];

  checkHealth(opts?: { timeoutMs?: number }): Promise<ProviderHealth>;

  getUsage?(): Promise<ProviderUsage>;

  buildCommand(task: DispatcherTask, context: TaskContext, opts: ProviderRunOptions): ProviderCommandPlan;

  parseOutcome(
    outcome: ProcessOutcome,
    task: DispatcherTask,
    executionId: string,
    plan: ProviderCommandPlan,
  ): Promise<TaskResult> | TaskResult;
}

export class ProviderRegistry {
  private readonly providers = new Map<ProviderId, AIProvider>();

  register(provider: AIProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(id: ProviderId): AIProvider {
    const provider = this.providers.get(id);
    if (!provider) {
      throw new DispatcherError({
        code: 'NO_AVAILABLE_PROVIDER',
        message: `Provider "${id}" is not registered.`,
        retryable: false,
      });
    }
    return provider;
  }

  has(id: ProviderId): boolean {
    return this.providers.has(id);
  }

  list(): AIProvider[] {
    return [...this.providers.values()];
  }
}
