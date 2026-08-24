import type { ProjectContext } from '../models/context.js';
import type { TaskClassification } from '../models/classification.js';
import type { DispatcherTask, PlannedWorkUnit, TaskExecutionPlan } from '../models/task.js';

export function buildExecutionPlan(
  task: DispatcherTask,
  classification: TaskClassification,
  project?: ProjectContext,
): TaskExecutionPlan {
  const scope = classification.scope ?? 'targeted';
  const workUnits = workUnitsFor(task, classification, project);
  return {
    intent: classification.type,
    scope,
    complexity: classification.estimatedComplexity,
    workUnits,
    createdAt: new Date().toISOString(),
  };
}

function workUnitsFor(
  task: DispatcherTask,
  classification: TaskClassification,
  project?: ProjectContext,
): PlannedWorkUnit[] {
  if (task.command === 'fix' && classification.scope === 'repository') {
    return [
      unit('inspect', 'Inspect the repository and identify concrete, reproducible defects and unsafe gaps.', 'provider'),
      unit('prioritize', 'Prioritize findings by impact and select only changes justified by evidence.', 'provider', ['inspect']),
      unit('implement', 'Implement the selected fixes in small, coherent changes with regression coverage.', 'provider', ['prioritize']),
      unit('validate', validationObjective(project), 'dispatcher', ['implement']),
      unit('review', 'Independently review the final patch and block unsafe or incomplete changes.', 'dispatcher', ['validate']),
    ];
  }

  if (task.command === 'fix' || task.command === 'implement') {
    return [
      unit('diagnose', 'Confirm the relevant behavior and determine the smallest correct change.', 'provider'),
      unit('implement', 'Implement the change and add focused regression coverage.', 'provider', ['diagnose']),
      unit('validate', validationObjective(project), 'dispatcher', ['implement']),
      unit('review', 'Review the final patch for correctness, regressions, and safety.', 'dispatcher', ['validate']),
    ];
  }

  return [unit('respond', 'Complete the requested analysis and provide evidence-backed results.', 'provider')];
}

function validationObjective(project?: ProjectContext): string {
  const stages = Object.entries(project?.commands ?? {})
    .filter(([, command]) => command !== undefined)
    .map(([name]) => name);
  return stages.length > 0
    ? `Run the detected validation stages: ${stages.join(', ')}.`
    : 'Run all available project validation and report any unavailable validation explicitly.';
}

function unit(
  id: string,
  objective: string,
  owner: PlannedWorkUnit['owner'],
  dependsOn: string[] = [],
): PlannedWorkUnit {
  return { id, objective, owner, dependsOn };
}
