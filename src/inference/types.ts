export interface RuntimeClock {
  now(): number;
  /** Schedule asynchronously on the same monotonic clock. */
  after(delayMs: number, callback: () => void): () => void;
}

export const systemClock: RuntimeClock = {
  now: () => performance.now(),
  after: (delayMs, callback) => {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

export type OutputChannel = 'observation' | 'response';
export type SchedulingPolicy = 'fifo' | 'context-aware';

export interface StreamEvent {
  readonly id: number;
  readonly sessionVersion: number;
  readonly source: 'scenario' | 'pixels' | 'user' | 'replay' | 'semantic';
  readonly capturedAtMs: number;
  readonly ingestedAtMs: number;
  readonly label: string;
  readonly reason: string;
  readonly origin?: InferenceOrigin;
}

/** The adapter serializes its evidence into an immutable string before handing it over. */
export interface Evidence {
  readonly source: string;
  readonly sequence: number;
  readonly capturedAtMs: number;
  readonly mediaType: string;
  readonly data: string;
}

export interface ChatMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export function validTokenCount(count: unknown): count is number {
  return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 && count <= 1_000_000_000;
}

export interface ContextSnapshot {
  readonly version: number;
  readonly evidence: readonly Evidence[];
  readonly messages: readonly ChatMessage[];
  readonly encodedBytes: number;
}

export interface InferenceOrigin {
  readonly runtimeInstanceId: string;
  readonly sessionId: string;
  readonly eventId: string;
  readonly sourceGeneration: number;
  readonly taskRevision: number;
  readonly interactionVersion: number;
  readonly producedAtMs: number;
}

export interface InferenceRequest {
  readonly channel: OutputChannel;
  readonly priority: number;
  readonly ttlMs: number;
  readonly dedupeKey?: string;
  /** Revoke tasks on this channel, independently of the scheduling policy. */
  readonly supersede?: boolean;
  readonly supersedeLowerPriority?: boolean;
  /** An earlier queued or running task in the same interaction must succeed first. */
  readonly dependsOn?: number;
  readonly textContext?: string;
  /** Serialized structured context selected by the caller. */
  readonly structuredText?: string;
  /** Admission-time eligibility, including event freshness. */
  readonly canDispatch?: () => boolean;
  /** Live semantic validity. Must not use the admission freshness window. */
  readonly isOutputRelevant?: () => boolean;
}

export interface InferenceTask extends Readonly<Omit<InferenceRequest, 'ttlMs' | 'supersede' | 'supersedeLowerPriority' | 'textContext' | 'structuredText' | 'canDispatch' | 'isOutputRelevant'>> {
  readonly id: number;
  readonly sessionVersion: number;
  readonly interactionVersion: number;
  readonly event: StreamEvent;
  readonly contextVersion: number;
  readonly context: ContextSnapshot;
  readonly deadlineMs: number;
  readonly tokenLimit: number;
  readonly tokenReservation: number;
}

export interface PartialOutput {
  readonly index: number;
  readonly text: string;
  readonly upstreamFirstTextMs?: number;
  readonly providerRequestId?: string;
}

export interface ProviderTerminal {
  readonly status: 'completed' | 'failed' | 'cancelled';
  readonly tokens: number | null;
  readonly usage?: TokenUsage;
  readonly providerRequestId?: string;
  readonly upstreamElapsedMs?: number;
  readonly reason?: string;
}

export interface InferenceProvider {
  /**
   * One logical endpoint. Call terminal only with reliable upstream completion evidence.
   * An abort signal requests a stop. It does not settle capacity or usage.
   * Report a known pre-dispatch failure through terminal with zero usage.
   */
  start(task: InferenceTask, signal: AbortSignal, callbacks: {
    partial(chunk: PartialOutput): void;
    terminal(receipt: ProviderTerminal): void;
    requested?(requestId: string): void;
    dispatched?(requestId: string): void;
    /** The transport ended without proof of upstream termination. */
    unconfirmed?(reason: string): void;
  }): void;
}
