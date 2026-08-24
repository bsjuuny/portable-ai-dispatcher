import type { LocalProviderId } from './provider.js';

export type LocalRuntimeKind = 'ollama' | 'llamacpp' | 'openai-compatible';

export type HardwareTier = 'CPU_LITE' | 'CPU_STANDARD' | 'CPU_PLUS' | 'GPU_STANDARD' | 'AI_WORKSTATION';
export type AccelerationBackend = 'cpu' | 'vulkan' | 'cuda' | 'npu';
export type ModelUsability =
  | 'READY_FAST'
  | 'READY'
  | 'READY_SLOW'
  | 'SUPPORTED_BUT_NOT_RECOMMENDED'
  | 'UNSUPPORTED';

export interface HardwareProfile {
  os: string;
  arch: string;
  cpu: {
    model?: string;
    cores?: number;
    threads?: number;
    /** Known instruction sets only. An empty list means unknown, never "not supported". */
    instructionSets: string[];
  };
  memory: { totalBytes?: number; availableBytes?: number };
  gpu?: {
    vendor?: string;
    model?: string;
    memoryBytes?: number;
    /** Detected or operator-confirmed backends; availability is qualified separately. */
    backends: AccelerationBackend[];
  };
  integratedGpu?: boolean;
  npu?: { available: boolean; vendor?: string };
  disk?: { availableBytes?: number };
  detectedAt: string;
  /** Sources that could not be queried are reported here instead of failing Local AI. */
  warnings: string[];
}

export interface HardwareTierThresholds {
  cpuLiteMaxRamGB: number;
  cpuStandardMinRamGB: number;
  cpuPlusMinRamGB: number;
  gpuStandardMinRamGB: number;
  gpuStandardMinVramGB: number;
  workstationMinRamGB: number;
  workstationMinVramGB: number;
}

export interface CpuResourcePolicy {
  maxThreads: number | 'auto';
  reserveCores: number;
}

export interface ModelPackModel {
  id: string;
  file: string;
  roles: string[];
  minimumRamGB: number;
  recommendedRamGB: number;
  gpuRequired: boolean;
  minimumVramGB?: number;
  sha256?: string;
  maxContextTokens?: number;
  recommendedContext?: Partial<Record<HardwareTier, number>>;
  license?: string;
  licenseFile?: string;
  source?: string;
  commercialUseMetadata?: string;
  redistributionMetadata?: string;
}

export interface ModelPackManifest {
  schemaVersion: '1';
  packId: string;
  packVersion?: string;
  minimumDispatcherVersion?: string;
  guaranteedBaseline?: boolean;
  models: ModelPackModel[];
}

export interface RuntimeArtifactManifest {
  schemaVersion: '1';
  runtimeId: string;
  acceleration: AccelerationBackend;
  os: string;
  arch: string;
  executable: string;
  requiredInstructionSets?: string[];
  version?: string;
  sha256?: string;
}

export interface ModelQualification {
  hardwareFingerprint: string;
  modelId: string;
  modelHash?: string;
  runtimeId: string;
  runtimeVersion?: string;
  qualifiedAt: string;
  loadDurationMs?: number;
  promptTokensPerSecond?: number;
  generationTokensPerSecond?: number;
  peakProcessRssBytes?: number;
  totalDurationMs?: number;
}

export interface LocalRuntimeStatus {
  runtime: LocalRuntimeKind;
  host: string;
  reachable: boolean;
  version?: string;
  checkedAt: string;
  message?: string;
}

export interface LocalModelInfo {
  runtime: LocalRuntimeKind;
  name: string;
  digest?: string;
  family?: string;
  parameterSize?: string;
  quantizationLevel?: string;
  contextLength?: number;
  sizeBytes?: number;
}

export interface LocalProfileConfig {
  name: string;
  runtime: LocalRuntimeKind;
  model: string;
  role?: string;
  capabilities?: string[];
}

export interface LocalCodingConfig {
  enabled: boolean;
  maxTurns: number;
  maxFilesChanged: number;
  maxFileBytes: number;
  maxReadLines: number;
  maxOutputTokens: number;
}

export const DEFAULT_LOCAL_CODING_CONFIG: LocalCodingConfig = {
  enabled: true,
  // Raised from 24 (2026-08-24): that ceiling predates the prompt-prefix-caching
  // fix in local-coding-agent.ts's buildAgentPrompt(), when every turn reprocessed
  // the entire growing prompt from scratch, so the marginal cost of turn N grew
  // with N and a low ceiling was the only guard against runaway cost. Now that
  // llama-server reuses the cached shared prefix (live-verified: repeated ~550-
  // token prefix went from 33.7s to 3.6s), each additional turn's marginal cost is
  // roughly constant instead of growing - and 24 was directly observed to be too
  // low in practice: a real from-scratch Next.js scaffold task hit "reached the
  // maximum of 24 turns without finishing" on its first attempt.
  maxTurns: 40,
  maxFilesChanged: 20,
  maxFileBytes: 1_048_576,
  maxReadLines: 400,
  maxOutputTokens: 1_024,
};

export interface LocalGenerationRequest {
  profileId: LocalProviderId;
  runtime: LocalRuntimeKind;
  host: string;
  model: string;
  prompt: string;
  timeoutMs: number;
  maxOutputTokens?: number;
  jsonSchema?: Record<string, unknown>;
}

export interface LocalGenerationResult {
  text: string;
  raw: unknown;
  durationMs: number;
  /** True when a `<think>...</think>` block was found and stripped from the raw
   * response before `text` was produced - live-verified against qwen3:4b, which
   * emits one even when the request sets `"think": false`. */
  thinkingStripped: boolean;
  /** True when the runtime reports it stopped because it hit the output token
   * limit (llama.cpp stop_type:"limit", Ollama done_reason:"length", OpenAI-
   * compatible finish_reason:"length") rather than finishing naturally - `text`
   * is then a truncated mid-token/mid-JSON fragment, not a complete response. */
  truncated?: boolean;
}

/** Runtime-neutral contract shared by Ollama, llama.cpp, OpenAI-compatible, and future local backends. */
export interface LocalRuntimeAdapter {
  readonly kind: LocalRuntimeKind;
  detect(host: string, opts?: { timeoutMs?: number }): Promise<LocalRuntimeStatus>;
  listModels(host: string, opts?: { timeoutMs?: number }): Promise<LocalModelInfo[]>;
  generate(request: LocalGenerationRequest): Promise<LocalGenerationResult>;
}
