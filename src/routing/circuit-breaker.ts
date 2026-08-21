import type { ProviderId } from '../models/provider.js';

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerConfig {
  failureThreshold: number;
  sampleSize: number;
  cooldownMs: number;
}

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 4,
  sampleSize: 5,
  cooldownMs: 600_000,
};

interface ProviderCircuit {
  state: CircuitState;
  recentOutcomes: boolean[]; // true = success
  openedAt?: number;
}

/**
 * Per-process, in-memory only - explicitly a v1.0 limitation (see README "Known
 * Limitations"). Each CLI invocation is short-lived, so persisting circuit state
 * across invocations would need a shared store; not built for v1.0.
 */
export class CircuitBreaker {
  private readonly circuits = new Map<ProviderId, ProviderCircuit>();

  constructor(private readonly config: CircuitBreakerConfig = DEFAULT_CIRCUIT_BREAKER_CONFIG) {}

  canAttempt(provider: ProviderId, now: number = Date.now()): boolean {
    const circuit = this.circuits.get(provider);
    if (!circuit || circuit.state === 'closed') return true;
    if (circuit.state === 'open') {
      if (circuit.openedAt !== undefined && now - circuit.openedAt >= this.config.cooldownMs) {
        circuit.state = 'half_open';
        return true;
      }
      return false;
    }
    return true; // half_open: allow exactly one trial attempt
  }

  recordSuccess(provider: ProviderId): void {
    const circuit = this.getOrCreate(provider);
    circuit.recentOutcomes.push(true);
    trimSamples(circuit, this.config.sampleSize);
    if (circuit.state === 'half_open') {
      circuit.state = 'closed';
      circuit.openedAt = undefined;
    }
  }

  recordFailure(provider: ProviderId): void {
    const circuit = this.getOrCreate(provider);
    circuit.recentOutcomes.push(false);
    trimSamples(circuit, this.config.sampleSize);

    if (circuit.state === 'half_open') {
      circuit.state = 'open';
      circuit.openedAt = Date.now();
      return;
    }

    const failures = circuit.recentOutcomes.filter((ok) => !ok).length;
    if (
      circuit.recentOutcomes.length >= this.config.sampleSize &&
      failures >= this.config.failureThreshold
    ) {
      circuit.state = 'open';
      circuit.openedAt = Date.now();
    }
  }

  stateOf(provider: ProviderId): CircuitState {
    return this.circuits.get(provider)?.state ?? 'closed';
  }

  private getOrCreate(provider: ProviderId): ProviderCircuit {
    let circuit = this.circuits.get(provider);
    if (!circuit) {
      circuit = { state: 'closed', recentOutcomes: [] };
      this.circuits.set(provider, circuit);
    }
    return circuit;
  }
}

function trimSamples(circuit: ProviderCircuit, sampleSize: number): void {
  if (circuit.recentOutcomes.length > sampleSize) {
    circuit.recentOutcomes.splice(0, circuit.recentOutcomes.length - sampleSize);
  }
}
