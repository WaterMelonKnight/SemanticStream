import { DECISION_ACTIONS } from './types';
import type {
  DecisionProvider,
  DecisionProviderResult,
  DecisionResult,
  DecisionState,
} from './types';

export interface DecisionEngineOptions {
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

function isAction(value: string): value is DecisionProviderResult['action'] {
  return (DECISION_ACTIONS as readonly string[]).includes(value);
}

function fallbackResult(): DecisionProviderResult {
  return {
    action: 'WAIT',
    candidates: [{ action: 'WAIT', score: 0, priority: 10, reason: 'Deterministic fallback: wait.' }],
    scoreKind: 'heuristic',
    reason: 'No provider decision was available.',
  };
}

/**
 * Enforces a provider timeout and validates the returned action. The fallback
 * provider is used for timeouts, thrown errors, and invalid actions. The engine
 * returns only an action proposal; resource admission and effect execution stay
 * outside the provider.
 */
export class DecisionEngine {
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(
    private readonly provider: DecisionProvider,
    private readonly fallback: DecisionProvider,
    options: DecisionEngineOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 50;
    this.now = options.now ?? (() => performance.now());
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new RangeError('Decision timeout must be positive and finite.');
    }
  }

  async decide(state: DecisionState): Promise<DecisionResult> {
    const startedAt = this.now();
    const controller = new AbortController();
    let degraded = false;
    let result: DecisionProviderResult | undefined;
    let reason = '';

    try {
      const operation = Promise.resolve(this.provider.decide(state, controller.signal));
      result = this.timeoutMs > 0
        ? await this.withTimeout(operation, controller)
        : await operation;
      if (!isAction(result.action)) {
        degraded = true;
        reason = 'Provider returned an invalid action.';
        result = undefined;
      }
    } catch (error) {
      degraded = true;
      reason = error instanceof Error && error.name === 'DecisionTimeoutError'
        ? 'Provider timed out.'
        : 'Provider failed.';
      controller.abort();
    }

    if (!result) {
      try {
        result = await Promise.resolve(this.fallback.decide(state, controller.signal));
      } catch {
        result = fallbackResult();
      }
      degraded = true;
      if (!reason) reason = 'Fallback used.';
    }

    const selectedProvider = degraded ? this.fallback.id : this.provider.id;
    return {
      ...result,
      providerId: selectedProvider,
      latencyMs: Math.max(0, this.now() - startedAt),
      timeoutMs: this.timeoutMs,
      degraded,
      reason: reason || result.reason,
    };
  }

  private async withTimeout(
    operation: Promise<DecisionProviderResult>,
    controller: AbortController,
  ): Promise<DecisionProviderResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error('Decision provider timed out.');
        error.name = 'DecisionTimeoutError';
        controller.abort();
        reject(error);
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([operation, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

/**
 * Calls the provider at most once per interval and reuses the latest result
 * between ticks. Keeps expensive or remote decisions off the per-frame path.
 */
export class DecisionScheduler {
  private lastResult: DecisionResult | null = null;
  private lastDecisionAt = -Infinity;

  constructor(
    private readonly engine: DecisionEngine,
    private readonly intervalMs: number,
  ) {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new RangeError('Decision interval must be positive and finite.');
    }
  }

  get latest(): DecisionResult | null {
    return this.lastResult;
  }

  async evaluate(state: DecisionState): Promise<DecisionResult | null> {
    if (this.lastResult && state.timestampMs - this.lastDecisionAt < this.intervalMs) {
      return this.lastResult;
    }
    this.lastDecisionAt = state.timestampMs;
    this.lastResult = await this.engine.decide(state);
    return this.lastResult;
  }
}
