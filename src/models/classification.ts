import type { ProviderCapability } from './provider.js';

export type TaskType =
  | 'ask'
  | 'analysis'
  | 'repository-analysis'
  | 'repository-remediation'
  | 'architecture'
  | 'implementation'
  | 'bugfix'
  | 'review'
  | 'refactor'
  | 'test-generation'
  | 'documentation';

export type TaskScope = 'targeted' | 'module' | 'repository';

export interface RepositoryMetrics {
  totalFiles: number;
  sourceFiles: number;
  testFiles: number;
  packageFiles: number;
  totalSourceBytes: number;
  scanTruncated: boolean;
}

export interface TaskClassification {
  type: TaskType;
  confidence: number;
  requiredCapabilities: ProviderCapability[];
  riskLevel: 'low' | 'medium' | 'high';
  estimatedComplexity: 'simple' | 'normal' | 'complex';
  /** Optional for backwards compatibility with persisted v1.0 task records. */
  scope?: TaskScope;
  signals: string[];
}
