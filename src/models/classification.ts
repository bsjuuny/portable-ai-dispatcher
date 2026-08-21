import type { ProviderCapability } from './provider.js';

export type TaskType =
  | 'ask'
  | 'analysis'
  | 'repository-analysis'
  | 'architecture'
  | 'implementation'
  | 'bugfix'
  | 'review'
  | 'refactor'
  | 'test-generation'
  | 'documentation';

export interface TaskClassification {
  type: TaskType;
  confidence: number;
  requiredCapabilities: ProviderCapability[];
  riskLevel: 'low' | 'medium' | 'high';
  estimatedComplexity: 'simple' | 'normal' | 'complex';
  signals: string[];
}
