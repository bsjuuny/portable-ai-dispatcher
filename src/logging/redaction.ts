import { createHash } from 'node:crypto';

// Each pattern targets a specific, well-known secret shape rather than a generic
// "looks sensitive" heuristic, to keep false positives low while catching the
// categories spec section 73 explicitly names.
const SECRET_PATTERNS: RegExp[] = [
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /sk-[A-Za-z0-9]{20,}/g, // OpenAI/Anthropic-style API key
  /gh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub token (ghp_/gho_/ghu_/ghs_/ghr_)
  /github_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained PAT
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT-shaped
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, // PEM block
  /\b(PASSWORD|TOKEN|SECRET|API_KEY|PRIVATE_KEY)\s*=\s*\S+/gi, // .env-style secret lines
];

const REDACTED_PLACEHOLDER = '[REDACTED]';

/** Replaces every recognized secret shape with a fixed placeholder - never partial masking, which can leak length/prefix. */
export function scrubSecrets(text: string): string {
  let scrubbed = text;
  for (const pattern of SECRET_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, REDACTED_PLACEHOLDER);
  }
  return scrubbed;
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Short, display-safe prefix for terminal/log output - never the full 64-char hash, which is only kept in the history record for correlation. */
export function shortHash(content: string): string {
  return hashContent(content).slice(0, 12);
}
