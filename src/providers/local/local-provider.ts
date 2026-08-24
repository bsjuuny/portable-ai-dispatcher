import type { DispatcherTask } from '../../models/task.js';
import type { TaskContext } from '../../models/context.js';
import type { TaskResult } from '../../models/result.js';
import type { ProviderCapability, ProviderHealth, LocalProviderId } from '../../models/provider.js';
import {
  DEFAULT_LOCAL_CODING_CONFIG,
  type LocalCodingConfig,
  type LocalProfileConfig,
  type LocalRuntimeAdapter,
} from '../../models/local.js';
import { DispatcherError } from '../../models/error.js';
import type { AIProvider, ProviderCommandPlan, ProviderRunOptions } from '../types.js';
import { buildLocalPrompt } from './local-prompt-builder.js';
import { runLocalCodingAgent } from './local-coding-agent.js';

const TEXT_CAPABILITIES: ProviderCapability[] = ['analysis', 'review', 'documentation'];
const AGENTIC_CAPABILITIES: ProviderCapability[] = [
  'analysis',
  'repository-analysis',
  'review',
  'documentation',
  'implementation',
  'bugfix',
  'test-generation',
  'refactor',
  'terminal',
  'large-context',
];
const REVIEW_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['approve', 'approve_with_warning', 'request_changes', 'critical'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['info', 'warning', 'error', 'critical'] },
          file: { type: 'string' },
          line: { type: 'number' },
          category: { type: 'string' },
          message: { type: 'string' },
          recommendation: { type: 'string' },
        },
        required: ['severity', 'category', 'message'],
        additionalProperties: false,
      },
    },
  },
  required: ['verdict', 'findings'],
  additionalProperties: false,
};

/**
 * Wraps one configured `local.profiles[]` entry as an AIProvider. Unlike Claude/
 * Codex, this is not process-spawn shaped - it talks through a runtime-neutral
 * LocalRuntimeAdapter via
 * executeDirect(), which dispatch-execution.ts's executeOnce() checks before
 * falling back to buildCommand/runProcess/parseOutcome.
 *
 * Raw local completion APIs do not expose filesystem tools themselves. For
 * workspace-write fix/implement tasks, executeDirect() therefore runs the shared
 * bounded JSON tool loop in local-coding-agent.ts; analysis and read-only review
 * remain single text-generation calls. The agent loop is runtime-independent.
 */
export class LocalProvider implements AIProvider {
  readonly id: LocalProviderId;
  readonly dataResidency = 'local' as const;

  constructor(
    private readonly profile: LocalProfileConfig,
    private readonly runtime: LocalRuntimeAdapter,
    private readonly host: string,
    private readonly coding: LocalCodingConfig = DEFAULT_LOCAL_CODING_CONFIG,
  ) {
    this.id = `local-${profile.name}`;
  }

  capabilities(): ProviderCapability[] {
    return this.profile.capabilities?.length
      ? (this.profile.capabilities as ProviderCapability[])
      : this.coding.enabled
        ? AGENTIC_CAPABILITIES
        : TEXT_CAPABILITIES;
  }

  async checkHealth(opts: { timeoutMs?: number } = {}): Promise<ProviderHealth> {
    const status = await this.runtime.detect(this.host, opts);
    return {
      provider: this.id,
      checkedAt: status.checkedAt,
      installed: status.reachable,
      authenticated: true, // loopback HTTP runtime - no auth concept to check
      reachable: status.reachable,
      rateLimited: false,
      ready: status.reachable,
      version: status.version,
      message: status.message,
      reasonCode: status.reachable ? undefined : 'PROVIDER_UNREACHABLE',
    };
  }

  buildCommand(): ProviderCommandPlan {
    throw new DispatcherError({
      code: 'INTERNAL_LOGIC_ERROR',
      message: `LocalProvider "${this.id}" has no process-spawn command plan - it defines executeDirect() and should never reach buildCommand().`,
      provider: this.id,
      retryable: false,
    });
  }

  parseOutcome(): TaskResult {
    throw new DispatcherError({
      code: 'INTERNAL_LOGIC_ERROR',
      message: `LocalProvider "${this.id}" has no process outcome to parse - it defines executeDirect() and should never reach parseOutcome().`,
      provider: this.id,
      retryable: false,
    });
  }

  async executeDirect(task: DispatcherTask, context: TaskContext, opts: ProviderRunOptions, executionId: string): Promise<TaskResult> {
    if (isCodeChangingTask(task) && opts.sandbox !== 'read-only') {
      if (!this.coding.enabled) {
        return {
          taskId: task.id,
          executionId,
          provider: this.id,
          status: 'failed',
          durationMs: 0,
          error: { code: 'LOCAL_AGENT_NO_CHANGES', message: 'Local autonomous coding is disabled by local.coding.enabled.' },
        };
      }

      const agentResult = await runLocalCodingAgent({
        profileId: this.id,
        runtimeKind: this.profile.runtime,
        runtime: this.runtime,
        host: this.host,
        model: this.profile.model,
        task,
        context,
        timeoutMs: opts.timeoutMs,
        config: this.coding,
      });
      return {
        taskId: task.id,
        executionId,
        provider: this.id,
        status: 'success',
        summary: agentResult.summary,
        text: agentResult.summary,
        filesChanged: agentResult.filesChanged,
        durationMs: agentResult.durationMs,
        usage: {
          provider: this.id,
          windowStart: new Date(Date.now() - agentResult.durationMs).toISOString(),
          windowEnd: new Date().toISOString(),
          requests: agentResult.turns,
          successes: 1,
          failures: 0,
          timeouts: 0,
          averageDurationMs: agentResult.durationMs,
        },
      };
    }

    if (task.command === 'ask' && context.directoryInventory?.length) {
      const text = formatDirectoryInventory(context.directoryInventory, requestedInventoryLimit(task.specification.rawDescription));
      return {
        taskId: task.id,
        executionId,
        provider: this.id,
        status: 'success',
        summary: firstLine(text),
        text,
        durationMs: 0,
      };
    }

    const prompt = buildLocalPrompt(task, context);
    const startedAt = new Date().toISOString();

    const result = await this.runtime.generate({
      profileId: this.id,
      runtime: this.profile.runtime,
      host: this.host,
      model: this.profile.model,
      prompt,
      timeoutMs: opts.timeoutMs,
      maxOutputTokens: task.command === 'ask' ? Math.min(256, this.coding.maxOutputTokens) : this.coding.maxOutputTokens,
      ...(isCodeChangingTask(task) && opts.sandbox === 'read-only'
        ? { jsonSchema: REVIEW_JSON_SCHEMA, maxOutputTokens: this.coding.maxOutputTokens }
        : {}),
    });

    return {
      taskId: task.id,
      executionId,
      provider: this.id,
      status: 'success',
      summary: firstLine(result.text),
      text: result.text,
      durationMs: result.durationMs,
      usage: {
        provider: this.id,
        windowStart: startedAt,
        windowEnd: new Date().toISOString(),
        requests: 1,
        successes: 1,
        failures: 0,
        timeouts: 0,
        averageDurationMs: result.durationMs,
      },
    };
  }
}

function isCodeChangingTask(task: DispatcherTask): boolean {
  return task.command === 'fix' || task.command === 'implement';
}

function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim().length > 0);
  return line ? line.trim().slice(0, 200) : '(empty response)';
}

function formatDirectoryInventory(inventories: NonNullable<TaskContext['directoryInventory']>, limit: number): string {
  return inventories.map((inventory) => {
    const entries = inventory.entries.slice(0, limit).map((entry) => `- ${entry}`).join('\n');
    const omitted = inventory.omittedEntryCount > 0 || inventory.entries.length > limit
      ? `\n- 그 외 ${inventory.omittedEntryCount + Math.max(0, inventory.entries.length - limit)}개 항목은 생략했습니다.`
      : '';
    return `확인한 폴더: ${inventory.root}\n${entries || '- 비어 있습니다.'}${omitted}`;
  }).join('\n\n');
}

function requestedInventoryLimit(description: string): number {
  const match = description.match(/\b(\d{1,2})\s*(?:개|items?|entries?)\s*(?:이내|이하|까지|or\s+fewer|at\s+most)?/i);
  const parsed = match ? Number(match[1]) : 20;
  return Number.isSafeInteger(parsed) ? Math.max(1, Math.min(20, parsed)) : 20;
}
