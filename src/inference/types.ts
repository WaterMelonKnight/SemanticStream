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
  readonly source: 'scenario' | 'pixels' | 'user' | 'replay';
  readonly capturedAtMs: number;
  readonly ingestedAtMs: number;
  readonly label: string;
  readonly reason: string;
}

/** The adapter serializes its evidence into an immutable string before handing it over. */
export interface Evidence {
  readonly source: string;
  readonly sequence: number;
  readonly capturedAtMs: number;
  readonly mediaType: string;
  readonly data: string;
}

export interface ContextSnapshot {
  readonly version: number;
  readonly evidence: readonly Evidence[];
  readonly encodedBytes: number;
}

export interface InferenceRequest {
  readonly channel: OutputChannel;
  readonly priority: number;
  readonly ttlMs: number;
  readonly dedupeKey?: string;
  /** Revoke tasks on this channel, independently of the scheduling policy. */
  readonly supersede?: boolean;
  /** An earlier queued or running task in the same interaction must succeed first. */
  readonly dependsOn?: number;
}

export interface InferenceTask extends Readonly<Omit<InferenceRequest, 'ttlMs' | 'supersede'>> {
  readonly id: number;
  readonly sessionVersion: number;
  readonly interactionVersion: number;
  readonly event: StreamEvent;
  readonly contextVersion: number;
  readonly context: ContextSnapshot;
  readonly deadlineMs: number;
  readonly tokenLimit: number;
}

export interface PartialOutput {
  readonly index: number;
  readonly text: string;
}

export interface ProviderTerminal {
  readonly status: 'completed' | 'failed' | 'cancelled';
  readonly tokens: number | null;
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
  }): void;
}
