import type { ProviderId } from './provider.js';
import type { TaskClassification } from './classification.js';

export type DispatcherCommand = 'ask' | 'analyze' | 'review' | 'fix' | 'implement';

export interface TaskAttachment {
  id: string;
  type: 'file' | 'log' | 'source' | 'document' | 'unknown';
  path?: string;
  name?: string;
  content?: string;
  sizeBytes: number;
  sha256: string;
  truncated: boolean;
  originalSizeBytes?: number;
}

export interface StructuredSpecification {
  summary?: string;
  errorCodes?: string[];
  stackTraces?: string[];
  reproductionSteps?: string[];
  requirements?: string[];
  constraints?: string[];
  acceptanceCriteria?: string[];
}

export interface TaskSpecification {
  rawDescription: string;
  structured?: StructuredSpecification;
  attachments: TaskAttachment[];
  sourcePaths: string[];
}

export interface PlannedWorkUnit {
  id: string;
  objective: string;
  owner: 'provider' | 'dispatcher';
  dependsOn: string[];
}

export interface TaskExecutionPlan {
  intent: string;
  scope: 'targeted' | 'module' | 'repository';
  complexity: 'simple' | 'normal' | 'complex';
  workUnits: PlannedWorkUnit[];
  createdAt: string;
}

export type TaskStatus =
  | 'created'
  | 'classifying'
  | 'loading_context'
  | 'selecting_provider'
  | 'running'
  | 'validating'
  | 'fixing'
  | 'reviewing'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'cancelled';

export interface DispatcherTask {
  id: string;
  command: DispatcherCommand;
  specification: TaskSpecification;
  workingDirectory: string;
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
  classification?: TaskClassification;
  executionPlan?: TaskExecutionPlan;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
}

export interface TaskAttempt {
  attemptNumber: number;
  executionId: string;
  provider: ProviderId;
  startedAt: string;
  finishedAt?: string;
}
