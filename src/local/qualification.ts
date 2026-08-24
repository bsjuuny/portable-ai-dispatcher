import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LocalGenerationRequest, LocalRuntimeAdapter, ModelQualification } from '../models/local.js';

const CACHE_SCHEMA_VERSION = '1';
const CACHE_PATH = join('.dispatcher', 'local', 'qualification.json');

interface QualificationCache {
  schemaVersion: typeof CACHE_SCHEMA_VERSION;
  entries: ModelQualification[];
}

export interface QualificationInput {
  root: string;
  adapter: LocalRuntimeAdapter;
  request: LocalGenerationRequest;
  hardwareFingerprint: string;
  runtimeVersion?: string;
  modelHash?: string;
}

/**
 * A deliberately small, repeatable local inference qualification. It measures
 * the endpoint actually used by Dispatcher without trying to inspect or alter
 * an external runtime process.  That keeps Ollama, llama.cpp and arbitrary
 * OpenAI-compatible local servers on the same contract.
 */
export async function qualifyLocalModel(input: QualificationInput): Promise<ModelQualification> {
  const result = await input.adapter.generate({
    ...input.request,
    prompt: 'Reply with exactly: LOCAL_AI_OK',
    maxOutputTokens: Math.min(input.request.maxOutputTokens ?? 32, 32),
  });
  const outputTokens = Math.max(1, result.text.trim().split(/\s+/u).filter(Boolean).length);
  const qualification: ModelQualification = {
    hardwareFingerprint: input.hardwareFingerprint,
    modelId: input.request.model,
    ...(input.modelHash ? { modelHash: input.modelHash } : {}),
    runtimeId: input.request.runtime,
    ...(input.runtimeVersion ? { runtimeVersion: input.runtimeVersion } : {}),
    qualifiedAt: new Date().toISOString(),
    generationTokensPerSecond: Number((outputTokens / Math.max(0.001, result.durationMs / 1000)).toFixed(3)),
    totalDurationMs: result.durationMs,
  };
  saveQualification(input.root, qualification);
  return qualification;
}

export function loadQualifications(root: string): ModelQualification[] {
  const path = join(root, CACHE_PATH);
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as QualificationCache;
    return parsed.schemaVersion === CACHE_SCHEMA_VERSION && Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

export function findQualification(
  root: string,
  criteria: Pick<ModelQualification, 'hardwareFingerprint' | 'modelId' | 'runtimeId'> & { maxAgeMs?: number },
): { qualification?: ModelQualification; stale: boolean } {
  const candidate = loadQualifications(root)
    .filter((entry) => entry.hardwareFingerprint === criteria.hardwareFingerprint && entry.modelId === criteria.modelId && entry.runtimeId === criteria.runtimeId)
    .sort((a, b) => b.qualifiedAt.localeCompare(a.qualifiedAt))[0];
  if (!candidate) return { stale: true };
  const maxAgeMs = criteria.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000;
  return { qualification: candidate, stale: Date.now() - Date.parse(candidate.qualifiedAt) > maxAgeMs };
}

function saveQualification(root: string, qualification: ModelQualification): void {
  const path = join(root, CACHE_PATH);
  const entries = loadQualifications(root)
    .filter((entry) => !(entry.hardwareFingerprint === qualification.hardwareFingerprint && entry.modelId === qualification.modelId && entry.runtimeId === qualification.runtimeId));
  entries.push(qualification);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ schemaVersion: CACHE_SCHEMA_VERSION, entries }, null, 2)}\n`, 'utf8');
}
