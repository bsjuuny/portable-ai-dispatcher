import { z } from 'zod';
import { PROVIDER_CAPABILITIES } from '../models/provider.js';
import { DEFAULT_LOCAL_CODING_CONFIG } from '../models/local.js';

// zod v4's `.default(value)` requires `value` to already match the schema's fully
// resolved OUTPUT shape - it does not recursively apply a nested schema's own
// per-field defaults to a partial literal like `{}`. So each nested schema's default
// is computed by parsing `{}` against itself once at module load, bottom-up, instead
// of hand-duplicating the shape as a literal (which would drift out of sync).

const RoutingWeightsSchema = z.object({
  capability: z.number().default(0.35),
  usage: z.number().default(0.2),
  successRate: z.number().default(0.2),
  latency: z.number().default(0.1),
  availability: z.number().default(0.1),
  failurePenalty: z.number().default(0.05),
});

const ProviderConfigSchema = z.object({ enabled: z.boolean().default(true) });

const ProvidersSchema = z.object({
  claude: ProviderConfigSchema.default(ProviderConfigSchema.parse({})),
  codex: ProviderConfigSchema.default(ProviderConfigSchema.parse({})),
});

const AdaptiveTimeoutSchema = z.object({
  enabled: z.boolean().default(true),
  simpleMs: z.number().int().positive().default(300_000),
  normalMs: z.number().int().positive().default(900_000),
  complexMs: z.number().int().positive().default(1_800_000),
  idleMs: z.number().int().positive().default(300_000),
  maximumMs: z.number().int().positive().default(3_600_000),
});

const ExecutionSchema = z.object({
  timeoutMs: z.number().int().positive().default(300_000),
  sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).default('workspace-write'),
  approval: z.enum(['untrusted', 'on-request', 'never']).default('never'),
  adaptiveTimeout: AdaptiveTimeoutSchema.default(AdaptiveTimeoutSchema.parse({})),
  // Total bytes across rawDescription + all attachment contents, checked once at
  // task-build time (cli/build-task.ts) before anything is dispatched. Default
  // (8MB) is generous relative to real prompt sizes - this exists to catch a
  // pasted-by-accident binary/huge log dump early with a clear error, not to
  // constrain normal usage.
  maxTaskInputBytes: z.number().int().positive().default(8 * 1024 * 1024),
});

const RoutingSchema = z.object({ weights: RoutingWeightsSchema.default(RoutingWeightsSchema.parse({})) });

const RetrySchema = z.object({ maxRetries: z.number().int().min(0).default(1) });

const FallbackSchema = z.object({ enabled: z.boolean().default(true) });

const CircuitBreakerSchema = z.object({
  failureThreshold: z.number().int().positive().default(4),
  sampleSize: z.number().int().positive().default(5),
  cooldownMs: z.number().int().positive().default(600_000),
});

const ValidationCommandsSchema = z.object({
  lint: z.array(z.string()).optional(),
  typecheck: z.array(z.string()).optional(),
  build: z.array(z.string()).optional(),
  test: z.array(z.string()).optional(),
});

const ValidationSchema = z.object({
  commands: ValidationCommandsSchema.default(ValidationCommandsSchema.parse({})),
  maxFixAttempts: z.number().int().min(0).default(2),
});

const ReviewSchema = z.object({
  enabled: z.boolean().default(true),
  maxReviewCycles: z.number().int().min(0).default(2),
  preferIndependentReviewer: z.boolean().default(true),
});

const DiagnosticsSchema = z.object({
  saveFailureArtifacts: z.boolean().default(true),
  logPrompts: z.boolean().default(false),
});

// --- Local LLM Adapter + Hardening increment (additive) ---
// All new keys below default to their v1.0-equivalent no-op behavior: `local` is
// on by default only in the sense that Ollama detection runs (spec section on
// honest doctor reporting), but with zero `profiles` nothing is ever routable
// through it; `safety.autoApply.enabled` defaults false so no behavior changes
// for an existing config until the operator explicitly opts in.

const LocalRuntimeConfigSchema = z.object({
  enabled: z.boolean().default(true),
  host: z.string().default('http://127.0.0.1:11434'),
});

const LocalLlamaCppRuntimeConfigSchema = z.object({
  enabled: z.boolean().default(false),
  host: z.string().default('http://127.0.0.1:8080'),
});

const LocalOpenAICompatibleRuntimeConfigSchema = z.object({
  enabled: z.boolean().default(false),
  host: z.string().default('http://127.0.0.1:1234'),
});

const LocalRuntimesSchema = z.object({
  ollama: LocalRuntimeConfigSchema.default(LocalRuntimeConfigSchema.parse({})),
  llamacpp: LocalLlamaCppRuntimeConfigSchema.default(LocalLlamaCppRuntimeConfigSchema.parse({})),
  'openai-compatible': LocalOpenAICompatibleRuntimeConfigSchema.default(
    LocalOpenAICompatibleRuntimeConfigSchema.parse({}),
  ),
});

const LocalProfileSchema = z.object({
  name: z.string().min(1, 'local.profiles[].name must not be empty'),
  runtime: z.enum(['ollama', 'llamacpp', 'openai-compatible']),
  model: z.string(),
  role: z.string().optional(),
  capabilities: z.array(z.enum(PROVIDER_CAPABILITIES)).optional(),
});

const LocalCodingSchema = z.object({
  enabled: z.boolean().default(DEFAULT_LOCAL_CODING_CONFIG.enabled),
  maxTurns: z.number().int().min(1).max(100).default(DEFAULT_LOCAL_CODING_CONFIG.maxTurns),
  maxFilesChanged: z.number().int().min(1).max(200).default(DEFAULT_LOCAL_CODING_CONFIG.maxFilesChanged),
  maxFileBytes: z.number().int().min(1_024).max(10 * 1024 * 1024).default(DEFAULT_LOCAL_CODING_CONFIG.maxFileBytes),
  maxReadLines: z.number().int().min(20).max(2_000).default(DEFAULT_LOCAL_CODING_CONFIG.maxReadLines),
  maxOutputTokens: z.number().int().min(128).max(8_192).default(DEFAULT_LOCAL_CODING_CONFIG.maxOutputTokens),
});

const HardwareTierThresholdsSchema = z.object({
  cpuLiteMaxRamGB: z.number().positive().default(16),
  cpuStandardMinRamGB: z.number().positive().default(16),
  cpuPlusMinRamGB: z.number().positive().default(32),
  gpuStandardMinRamGB: z.number().positive().default(32),
  gpuStandardMinVramGB: z.number().positive().default(8),
  workstationMinRamGB: z.number().positive().default(64),
  workstationMinVramGB: z.number().positive().default(24),
});

const LocalCpuSchema = z.object({
  maxThreads: z.union([z.literal('auto'), z.number().int().positive()]).default('auto'),
  reserveCores: z.number().int().min(0).default(2),
});

const LocalEscalationSchema = z.object({
  enabled: z.boolean().default(true),
  maxSteps: z.number().int().min(1).max(5).default(3),
});

const LocalBundleSchema = z.object({
  /** Paths are relative to the dispatch target unless absolute. No downloader exists. */
  runtimeDirectory: z.string().default('runtime'),
  modelPacksDirectory: z.string().default('models'),
  /** True for an offline kit: missing CPU baseline becomes a failed preflight. */
  offlineKitRequired: z.boolean().default(false),
  requireModelLicenseMetadata: z.boolean().default(false),
});

const LocalContextBudgetSchema = z.object({
  cpuLite: z.number().int().min(1_024).default(4_096),
  cpuStandard: z.number().int().min(1_024).default(8_192),
  cpuPlus: z.number().int().min(1_024).default(16_384),
  gpuStandard: z.number().int().min(1_024).default(16_384),
  workstation: z.number().int().min(1_024).default(32_768),
});

// Each profile is registered as provider id `local-<name>` (ProviderRegistry.register()
// keys a plain Map by id) - two profiles sharing a name would silently overwrite each
// other with no error, the second one winning with no indication the first was ever
// dropped. Rejected at config-parse time instead, where the operator can see why.
const LocalSchema = z.object({
  runtimes: LocalRuntimesSchema.default(LocalRuntimesSchema.parse({})),
  profiles: z
    .array(LocalProfileSchema)
    .default([])
    .refine((profiles) => new Set(profiles.map((p) => p.name)).size === profiles.length, {
      message: 'local.profiles[].name must be unique - duplicate names would silently overwrite each other as the same local-<name> provider id',
    }),
  allowAutoDownload: z.boolean().default(false),
  coding: LocalCodingSchema.default(LocalCodingSchema.parse({})),
  cpu: LocalCpuSchema.default(LocalCpuSchema.parse({})),
  hardware: z.object({
    tiers: HardwareTierThresholdsSchema.default(HardwareTierThresholdsSchema.parse({})),
  }).default({ tiers: HardwareTierThresholdsSchema.parse({}) }),
  bundle: LocalBundleSchema.default(LocalBundleSchema.parse({})),
  escalation: LocalEscalationSchema.default(LocalEscalationSchema.parse({})),
  contextBudget: LocalContextBudgetSchema.default(LocalContextBudgetSchema.parse({})),
});

const WorkspaceIsolationSchema = z.object({ enabled: z.boolean().default(true) });

const BlastRadiusLimitSchema = z.object({
  maxFiles: z.number().int().positive(),
  maxChangedLines: z.number().int().positive(),
});

const BlastRadiusSchema = z.object({
  bugfix: BlastRadiusLimitSchema.default({ maxFiles: 15, maxChangedLines: 400 }),
  implementation: BlastRadiusLimitSchema.default({ maxFiles: 30, maxChangedLines: 1000 }),
  refactor: BlastRadiusLimitSchema.default({ maxFiles: 50, maxChangedLines: 2000 }),
});

const AutoApplySchema = z.object({
  enabled: z.boolean().default(false),
  maxRiskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH']).default('MEDIUM'),
});

const SafetySchema = z.object({
  protectedPaths: z.array(z.string()).default(['.env', 'secrets/', 'production.yml']),
  workspaceIsolation: WorkspaceIsolationSchema.default(WorkspaceIsolationSchema.parse({})),
  blastRadius: BlastRadiusSchema.default(BlastRadiusSchema.parse({})),
  autoApply: AutoApplySchema.default(AutoApplySchema.parse({})),
});

export const DispatcherConfigSchema = z.object({
  providers: ProvidersSchema.default(ProvidersSchema.parse({})),
  execution: ExecutionSchema.default(ExecutionSchema.parse({})),
  routing: RoutingSchema.default(RoutingSchema.parse({})),
  retry: RetrySchema.default(RetrySchema.parse({})),
  fallback: FallbackSchema.default(FallbackSchema.parse({})),
  circuitBreaker: CircuitBreakerSchema.default(CircuitBreakerSchema.parse({})),
  validation: ValidationSchema.default(ValidationSchema.parse({})),
  review: ReviewSchema.default(ReviewSchema.parse({})),
  diagnostics: DiagnosticsSchema.default(DiagnosticsSchema.parse({})),
  safety: SafetySchema.default(SafetySchema.parse({})),
  local: LocalSchema.default(LocalSchema.parse({})),
});

export type DispatcherConfig = z.infer<typeof DispatcherConfigSchema>;

export function parseConfig(raw: unknown): DispatcherConfig {
  return DispatcherConfigSchema.parse(raw ?? {});
}
