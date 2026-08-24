import type { HardwareTier, ModelQualification, ModelUsability } from '../models/local.js';

export interface LocalModelCandidate {
  id: string;
  roles: string[];
  status: ModelUsability;
  recommendedContextTokens?: number;
  qualification?: ModelQualification;
  warm?: boolean;
}

export interface ModelRoute {
  selected?: LocalModelCandidate;
  alternatives: LocalModelCandidate[];
  reason: string;
  contextBudget: number;
}

/** Routes to the smallest qualified model that can serve the requested role.
 * GPU is an accelerator, never a prerequisite for this CPU-first policy. */
export function routeLocalModel(
  candidates: LocalModelCandidate[],
  role: string,
  tier: HardwareTier,
  contextBudget: number,
): ModelRoute {
  const usable = candidates
    .filter((candidate) => candidate.roles.includes(role) && isUsable(candidate.status))
    .sort((a, b) => score(b, tier) - score(a, tier) || a.id.localeCompare(b.id));
  const selected = usable[0];
  return {
    ...(selected ? { selected } : {}),
    alternatives: selected ? usable.slice(1) : [],
    reason: selected
      ? `${selected.id} selected for ${role}; it is ${selected.status}${selected.warm ? ' and already warm' : ''}.`
      : `No installed model is usable for ${role}; automatic download is disabled.`,
    contextBudget: Math.min(contextBudget, selected?.recommendedContextTokens ?? contextBudget),
  };
}

function isUsable(status: ModelUsability): boolean {
  return status === 'READY_FAST' || status === 'READY' || status === 'READY_SLOW';
}

function score(candidate: LocalModelCandidate, tier: HardwareTier): number {
  const statusScore: Record<ModelUsability, number> = {
    READY_FAST: 100,
    READY: 80,
    READY_SLOW: 50,
    SUPPORTED_BUT_NOT_RECOMMENDED: 0,
    UNSUPPORTED: 0,
  };
  const throughput = Math.min(30, candidate.qualification?.generationTokensPerSecond ?? 0);
  const warm = candidate.warm ? 10 : 0;
  const cpuPenalty = (tier === 'CPU_LITE' || tier === 'CPU_STANDARD') && candidate.status === 'READY_SLOW' ? 15 : 0;
  return statusScore[candidate.status] + throughput + warm - cpuPenalty;
}
