import { DECISION_ACTIONS } from './types';
import type {
  DecisionAction,
  DecisionCandidate,
  DecisionProvider,
  DecisionProviderResult,
  DecisionResult,
  DecisionState,
  TaskDefinition,
} from './types';

export interface DecisionEngineOptions {
  /** Timeout for each attempt, including the fallback. */
  readonly timeoutMs?: number;
  readonly maxUnsettledPerProvider?: number;
  readonly now?: () => number;
}

function isAction(value: unknown): value is DecisionAction {
  return DECISION_ACTIONS.some((action) => action === value);
}

function validCandidate(value: unknown, probability: boolean): value is DecisionCandidate {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<DecisionCandidate>;
  return isAction(candidate.action)
    && typeof candidate.score === 'number' && Number.isFinite(candidate.score)
    && (!probability || (candidate.score >= 0 && candidate.score <= 1))
    && Number.isFinite(candidate.priority)
    && typeof candidate.reason === 'string' && candidate.reason.length <= 1_024;
}

function validatedResult(value: unknown, provider: DecisionProvider): DecisionProviderResult | null {
  if (!value || typeof value !== 'object') return null;
  const { action, candidates, scoreKind, reason } = value as Partial<DecisionProviderResult>;
  if (!isAction(action) || (scoreKind !== 'heuristic' && scoreKind !== 'model-probability')
    || scoreKind !== provider.scoreKind || typeof reason !== 'string' || reason.length > 1_024
    || !Array.isArray(candidates) || candidates.length > DECISION_ACTIONS.length) return null;
  const copied = [...candidates];
  if (!copied.every((candidate) => validCandidate(candidate, scoreKind === 'model-probability'))
    || !copied.some((candidate) => candidate.action === action)) return null;
  return {
    action, scoreKind, reason,
    candidates: copied.map(({ action, score, priority, reason }) => ({ action, score, priority, reason })),
  };
}

const SAFE_WAIT: DecisionProviderResult = {
  action: 'WAIT',
  candidates: [{ action: 'WAIT', score: 0, priority: 10, reason: 'Deterministic fallback: wait.' }],
  scoreKind: 'heuristic',
  reason: 'No provider decision was available.',
};

/** Supervises provider work and returns proposals. Cancellation rejects with the caller's abort reason. */
export class DecisionEngine {
  private readonly timeoutMs: number;
  private readonly maxUnsettled: number;
  private readonly now: () => number;
  private readonly unsettled = new Map<DecisionProvider, number>();

  constructor(
    private readonly provider: DecisionProvider,
    private readonly fallback: DecisionProvider,
    options: DecisionEngineOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 50;
    this.maxUnsettled = options.maxUnsettledPerProvider ?? 2;
    this.now = options.now ?? (() => performance.now());
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 2_147_483_647) {
      throw new RangeError('Decision timeout must fit a positive timer delay.');
    }
    if (!Number.isSafeInteger(this.maxUnsettled) || this.maxUnsettled < 1) {
      throw new RangeError('Provider capacity must be a positive integer.');
    }
  }

  async decide(state: DecisionState, signal?: AbortSignal): Promise<DecisionResult> {
    signal?.throwIfAborted();
    const startedAtMs = this.now();
    const input = structuredClone(state);
    const primary = await this.attempt(this.provider, input, signal);
    signal?.throwIfAborted();
    const fallback = primary.result ? null : await this.attempt(this.fallback, input, signal);
    signal?.throwIfAborted();
    const completedAtMs = this.now();
    const result = primary.result ?? fallback?.result ?? structuredClone(SAFE_WAIT);
    const providerId = primary.result ? this.provider.id : fallback?.result ? this.fallback.id : 'safe-wait';
    const reason = primary.result ? result.reason
      : fallback?.result ? primary.reason : primary.reason + ' Fallback: ' + fallback?.reason;
    return {
      ...result, providerId, reason, startedAtMs, completedAtMs,
      latencyMs: completedAtMs - startedAtMs,
      timeoutMs: this.timeoutMs,
      degraded: primary.result === null,
    };
  }

  private async attempt(provider: DecisionProvider, state: DecisionState, signal?: AbortSignal): Promise<{
    result: DecisionProviderResult | null;
    reason: string;
  }> {
    const running = this.unsettled.get(provider) ?? 0;
    if (running >= this.maxUnsettled) return { result: null, reason: 'Provider capacity exhausted.' };
    this.unsettled.set(provider, running + 1);
    const release = (): void => {
      const count = this.unsettled.get(provider)!;
      if (count === 1) this.unsettled.delete(provider);
      else this.unsettled.set(provider, count - 1);
    };

    const controller = new AbortController();
    const abort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const deadline = this.now() + this.timeoutMs;
    const timeout = new Error('Provider timed out.');
    const timer = setTimeout(() => controller.abort(timeout), this.timeoutMs);

    try {
      const stopped = new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
      });
      let operation: Promise<DecisionProviderResult>;
      try {
        operation = Promise.resolve(provider.decide(structuredClone(state), controller.signal));
      } catch (error) {
        operation = Promise.reject(error);
      }
      // An ignored abort still occupies its physical provider slot until settlement.
      void operation.then(release, release);
      const value = await Promise.race([stopped, operation]);
      controller.signal.throwIfAborted();
      if (this.now() >= deadline) {
        controller.abort(timeout);
        throw timeout;
      }
      const result = validatedResult(value, provider);
      return { result, reason: result ? '' : 'Provider returned invalid output.' };
    } catch (error) {
      return { result: null, reason: error === timeout ? timeout.message : 'Provider failed.' };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
}

export interface ScheduledDecision extends DecisionResult {
  readonly sessionId: string;
  readonly generation: number;
  readonly taskRevision: number;
  readonly requestId: number;
  readonly observationVersion: number;
  readonly contextVersion: number;
  readonly observedAtMs: number;
}

function taskKey({ id, label, category, priority, roi }: TaskDefinition): string {
  return JSON.stringify([id, label, category, priority, roi?.x, roi?.y, roi?.width, roi?.height]);
}

/** One active evaluation, no queue. Skipped ticks leave the latest proposal available. */
export class DecisionScheduler {
  private sessionId: string | undefined;
  private currentTask: string | undefined;
  private generation = 0;
  private taskRevision = 0;
  private requestId = 0;
  private observationVersion = 0;
  private contextVersion = 0;
  private observedAtMs = -Infinity;
  private lastStartedAt = -Infinity;
  private pending: AbortController | null = null;
  private lastResult: ScheduledDecision | null = null;

  constructor(
    private readonly engine: DecisionEngine,
    private readonly intervalMs: number,
    private readonly maxObservationAgeMs = 2 * intervalMs,
    private readonly now: () => number = () => performance.now(),
  ) {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0
      || !Number.isFinite(maxObservationAgeMs) || maxObservationAgeMs < intervalMs) {
      throw new RangeError('Decision interval and observation age must be finite and ordered.');
    }
  }

  get latest(): ScheduledDecision | null {
    return this.lastResult;
  }

  /** Clear eligibility on changes to task settings or strategy. */
  invalidate(): void {
    this.clear();
    this.taskRevision += 1;
  }

  invalidateContext(): void {
    this.clear();
    this.contextVersion += 1;
  }

  reset(): void {
    this.clear();
    this.generation += 1;
    this.taskRevision = 0;
    this.contextVersion = 0;
    this.sessionId = undefined;
    this.currentTask = undefined;
    this.observationVersion = 0;
    this.observedAtMs = -Infinity;
  }

  applicable(atMs: number): ScheduledDecision | null {
    const result = this.lastResult;
    return result && atMs >= result.observedAtMs
      && atMs - result.observedAtMs <= this.maxObservationAgeMs ? result : null;
  }

  async evaluate(state: DecisionState): Promise<ScheduledDecision | null> {
    if (state.sessionId !== this.sessionId) {
      this.reset();
      this.sessionId = state.sessionId;
    }
    if (!Number.isFinite(state.timestampMs) || state.timestampMs < this.observedAtMs) {
      throw new RangeError('Decision observation times must be finite and nondecreasing.');
    }
    const key = taskKey(state.task);
    if (key !== this.currentTask) {
      this.invalidate();
      this.currentTask = key;
    }
    this.observedAtMs = state.timestampMs;
    const observationVersion = ++this.observationVersion;
    if (this.pending || state.timestampMs - this.lastStartedAt < this.intervalMs) return null;
    this.lastStartedAt = state.timestampMs;
    const requestId = ++this.requestId;
    const { generation, taskRevision, contextVersion } = this;
    const { sessionId, timestampMs: observedAtMs } = state;
    const controller = new AbortController();
    this.pending = controller;

    try {
      const result = await this.engine.decide(state, controller.signal);
      if (this.pending !== controller || this.now() - observedAtMs > this.maxObservationAgeMs) return null;
      this.lastResult = {
        ...result, sessionId, generation, taskRevision, requestId, observationVersion, contextVersion, observedAtMs,
      };
      return this.lastResult;
    } catch (error) {
      if (controller.signal.aborted) return null;
      throw error;
    } finally {
      if (this.pending === controller) this.pending = null;
    }
  }

  private clear(): void {
    this.lastResult = null;
    this.lastStartedAt = -Infinity;
    const pending = this.pending;
    this.pending = null;
    pending?.abort();
  }
}
