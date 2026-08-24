import type { DispatcherTask } from '../models/task.js';
import type { ProviderCapability } from '../models/provider.js';
import type { TaskClassification, TaskType } from '../models/classification.js';
import type { ProjectContext } from '../models/context.js';

interface Rule {
  type: TaskType;
  capabilities: ProviderCapability[];
  keywords: RegExp;
  weight: number;
}

// Ordered by specificity - more specific task types are checked first so a generic
// keyword ("리뷰"/"review") in a bugfix description doesn't steal the classification
// from a more specific bugfix match.
const RULES: Rule[] = [
  {
    type: 'bugfix',
    capabilities: ['bugfix', 'implementation'],
    keywords: /버그|오류|에러|fix|bug|exception|traceback|stack trace|npe|nullpointerexception/i,
    weight: 3,
  },
  {
    type: 'test-generation',
    capabilities: ['test-generation'],
    keywords: /테스트\s*(추가|작성)|regression test|write tests|add tests|unit test/i,
    weight: 3,
  },
  {
    type: 'refactor',
    capabilities: ['refactor', 'implementation'],
    keywords: /리팩터|리팩토링|refactor|restructure|clean\s*up/i,
    weight: 2,
  },
  {
    type: 'review',
    capabilities: ['review'],
    keywords: /검수|리뷰|review\b|code review/i,
    weight: 2,
  },
  {
    type: 'architecture',
    capabilities: ['architecture', 'repository-analysis'],
    keywords: /아키텍처|architecture|설계|design\s*plan|structure the/i,
    weight: 2,
  },
  {
    type: 'repository-analysis',
    capabilities: ['repository-analysis', 'large-context'],
    keywords: /전체.*(분석|검토)|repository|repo-wide|analyze the (repo|codebase)/i,
    weight: 2,
  },
  {
    type: 'documentation',
    capabilities: ['documentation'],
    keywords: /문서화|documentation|readme|docstring/i,
    weight: 1,
  },
  {
    type: 'implementation',
    capabilities: ['implementation'],
    keywords: /추가|구현|기능|implement|add\s+(a\s+)?feature|new endpoint/i,
    weight: 1,
  },
];

const COMMAND_TO_TYPE: Record<DispatcherTask['command'], TaskType | undefined> = {
  fix: 'bugfix',
  review: 'review',
  implement: 'implementation',
  analyze: 'analysis',
  ask: 'ask',
};

const REPOSITORY_SCOPE_RE =
  /(?:프로젝트|저장소|레포|repository|repo|codebase).*(?:전체|전반|확인|점검|검토|분석|오류날|문제점|더\s*수정|audit|inspect|review)|(?:전체|전반|repo-wide|project-wide).*(?:프로젝트|저장소|코드|repository|codebase)/i;
const MODULE_SCOPE_RE = /모듈|패키지|디렉터리|폴더|module|package|directory|folder/i;

/**
 * Rule/keyword-based classification, not an AI call - spec requirement 39 (분류
 * 자체를 위해 AI 호출을 남발하지 않습니다). The `--type` CLI flag, when present in
 * task.metadata, always overrides this entirely.
 */
export function classifyTask(task: DispatcherTask, project?: ProjectContext): TaskClassification {
  const scope = inferScope(task);
  const explicitType = task.metadata?.['explicitType'];
  if (typeof explicitType === 'string' && isTaskType(explicitType)) {
    return {
      type: explicitType,
      confidence: 1,
      requiredCapabilities: capabilitiesForType(explicitType),
      riskLevel: riskLevelFor(explicitType, task),
      estimatedComplexity: estimateComplexity(task, scope, project),
      scope,
      signals: ['explicit --type flag'],
    };
  }

  const text = task.specification.rawDescription;
  const matches = RULES.filter((rule) => rule.keywords.test(text));
  const signals = matches.map((m) => `keyword match: ${m.type}`);

  const commandDefault = COMMAND_TO_TYPE[task.command];
  const best = matches.sort((a, b) => b.weight - a.weight)[0];

  const type: TaskType =
    task.command === 'fix' && scope === 'repository'
      ? 'repository-remediation'
      : best?.type ?? commandDefault ?? 'ask';
  const confidence = type === 'repository-remediation'
    ? 0.95
    : best
      ? Math.min(0.5 + best.weight * 0.15, 0.95)
      : commandDefault
        ? 0.6
        : 0.3;

  if (scope !== 'targeted') signals.push(`scope: ${scope}`);

  if (commandDefault && commandDefault !== type) {
    signals.push(`command default: ${task.command} -> ${commandDefault}`);
  }

  return {
    type,
    confidence,
    requiredCapabilities: capabilitiesForType(type),
    riskLevel: riskLevelFor(type, task),
    estimatedComplexity: estimateComplexity(task, scope, project),
    scope,
    signals,
  };
}

function capabilitiesForType(type: TaskType): ProviderCapability[] {
  if (type === 'repository-remediation') return ['repository-analysis', 'bugfix', 'implementation'];
  const rule = RULES.find((r) => r.type === type);
  if (rule) return rule.capabilities;
  if (type === 'analysis') return ['analysis'];
  return ['analysis'];
}

function riskLevelFor(type: TaskType, task: DispatcherTask): 'low' | 'medium' | 'high' {
  if (type === 'ask' || type === 'analysis' || type === 'documentation') return 'low';
  if (type === 'repository-remediation') return 'high';
  const constraints = task.specification.structured?.constraints ?? [];
  if (type === 'bugfix' && constraints.length === 0) return 'high';
  if (type === 'implementation' || type === 'refactor' || type === 'bugfix') return 'medium';
  return 'low';
}

function estimateComplexity(
  task: DispatcherTask,
  scope: TaskClassification['scope'],
  project?: ProjectContext,
): 'simple' | 'normal' | 'complex' {
  if (scope === 'repository' && (task.command === 'fix' || task.command === 'implement')) {
    return 'complex';
  }
  const length = task.specification.rawDescription.length;
  const requirementCount = task.specification.structured?.requirements?.length ?? 0;
  const attachmentCount = task.specification.attachments.length;
  const metrics = project?.metrics;
  const repositoryWeight = metrics
    ? Math.min(metrics.sourceFiles / 150, 4) + Math.min(metrics.totalSourceBytes / 2_000_000, 3)
    : 0;
  const scopeWeight = scope === 'repository' ? 8 : scope === 'module' ? 3 : 0;
  const score = length / 200 + requirementCount * 2 + attachmentCount * 2 + scopeWeight + repositoryWeight;
  if (score < 3) return 'simple';
  if (score < 10) return 'normal';
  return 'complex';
}

function inferScope(task: DispatcherTask): NonNullable<TaskClassification['scope']> {
  if (task.specification.sourcePaths.length > 0) {
    return task.specification.sourcePaths.length <= 2 ? 'targeted' : 'module';
  }
  const text = task.specification.rawDescription;
  if (REPOSITORY_SCOPE_RE.test(text)) return 'repository';
  if (MODULE_SCOPE_RE.test(text)) return 'module';
  return 'targeted';
}

function isTaskType(value: string): value is TaskType {
  return RULES.some((r) => r.type === value) || value === 'ask' || value === 'analysis' || value === 'repository-remediation';
}
