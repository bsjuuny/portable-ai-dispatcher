import { z } from 'zod';

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

const ExecutionSchema = z.object({
  timeoutMs: z.number().int().positive().default(300_000),
  sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).default('workspace-write'),
  approval: z.enum(['untrusted', 'on-request', 'never']).default('never'),
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

const SafetySchema = z.object({
  protectedPaths: z.array(z.string()).default(['.env', 'secrets/', 'production.yml']),
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
});

export type DispatcherConfig = z.infer<typeof DispatcherConfigSchema>;

export function parseConfig(raw: unknown): DispatcherConfig {
  return DispatcherConfigSchema.parse(raw ?? {});
}
