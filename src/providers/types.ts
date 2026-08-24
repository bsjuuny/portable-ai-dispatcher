import type { DispatcherTask } from '../models/task.js';
import type { TaskContext } from '../models/context.js';
import type { TaskResult } from '../models/result.js';
import type { ProviderCapability, ProviderDataResidency, ProviderHealth, ProviderId, ProviderUsage } from '../models/provider.js';
import type { ProcessOutcome } from '../process/process-runner.js';
import { DispatcherError } from '../models/error.js';

export interface ProviderRunOptions {
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  approval: 'untrusted' | 'on-request' | 'never';
  model?: string;
  maxBudgetUsd?: number;
  timeoutMs: number;
  /** Ends a provider only when no stdout/stderr activity is observed for this long. */
  idleTimeoutMs?: number;
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

  /** 'local' | 'cloud' | undefined. Cloud providers (Claude/Codex) leave this
   * undefined - callers that care treat a missing value as 'cloud'. */
  readonly dataResidency?: ProviderDataResidency;

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

  /**
   * Optional alternate execution path for providers that are not process-spawn
   * shaped (e.g. LocalProvider talking HTTP to Ollama). When present,
   * dispatch-execution.ts's executeOnce() calls this instead of
   * buildCommand/runProcess/parseOutcome. Claude/Codex never define this, so
   * their behavior is byte-for-byte unchanged.
   */
  executeDirect?(
    task: DispatcherTask,
    context: TaskContext,
    opts: ProviderRunOptions,
    executionId: string,
  ): Promise<TaskResult>;
}

export class ProviderRegistry {
  private readonly providers = new Map<ProviderId, AIProvider>();

  register(provider: AIProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(id: ProviderId): AIProvider {
    const provider = this.providers.get(id);
    if (!provider) {
      // A `local-<name>` id specifically means "this profile isn't configured (or
      // its runtime is disabled in config.local.runtimes)" - createLocalProviders()
      // silently skips those, so distinguish that case from a genuinely unknown/
      // mistyped cloud provider id (NO_AVAILABLE_PROVIDER), which is a different
      // problem with a different fix (enable the runtime / add the profile, vs.
      // check the provider name).
      const isLocalId = id.startsWith('local-');
      throw new DispatcherError({
        code: isLocalId ? 'LOCAL_RUNTIME_NOT_CONFIGURED' : 'NO_AVAILABLE_PROVIDER',
        message: isLocalId
          ? `Local provider "${id}" is not configured - add it to local.profiles[] with a runtime enabled in local.runtimes, or check "dispatcher local status".`
          : `Provider "${id}" is not registered.`,
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
