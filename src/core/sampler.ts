import type { BudgetController } from './budget';
import { MetricsCollector } from './metrics';
import type { MetricsSnapshot } from './metrics';
import type { SamplingContext, SamplingPolicy } from './sampling';
import type { ContextSink, StreamFrame } from './stream';

export interface DeliveryTiming {
  readonly minimumIntervalMs: number;
  readonly maximumSilenceMs: number;
}

export type FrameDecision = 'policy' | 'interval' | 'budget' | 'backpressure' | 'sent';

export class Sampler<T, Sample> {
  private readonly metrics = new MetricsCollector();
  private firstTimestampMs: number | undefined;
  private previousTimestampMs = -Infinity;
  private lastDelivery: SamplingContext<Sample>['lastDelivery'] | undefined;

  constructor(
    private readonly policy: SamplingPolicy<Sample>,
    private readonly budget: BudgetController,
    private readonly timing: DeliveryTiming,
    private readonly sink: ContextSink<T>,
    private readonly now: () => number = () => performance.now(),
  ) {
    if (!Number.isFinite(timing.minimumIntervalMs) || timing.minimumIntervalMs < 0
      || !Number.isFinite(timing.maximumSilenceMs) || timing.maximumSilenceMs <= 0) {
      throw new RangeError('Delivery timing must be finite, with positive maximum silence.');
    }
  }

  /** Samples are immutable and may be retained as the most recent accepted baseline. */
  process(frame: StreamFrame<T>, sample: Sample, preparationMs = 0): FrameDecision {
    const startedAt = this.now();
    const { timestampMs } = frame;
    if (!Number.isFinite(timestampMs) || timestampMs < this.previousTimestampMs) {
      throw new RangeError('Frame timestamps must be finite and nondecreasing.');
    }
    this.firstTimestampMs ??= timestampMs;
    this.previousTimestampMs = timestampMs;

    const decision = this.deliver(frame, sample, this.firstTimestampMs);
    this.metrics.record(decision === 'sent', preparationMs + (this.now() - startedAt));
    return decision;
  }

  snapshot(): MetricsSnapshot {
    return this.metrics.snapshot();
  }

  private deliver(frame: StreamFrame<T>, sample: Sample, firstTimestampMs: number): FrameDecision {
    const { timestampMs } = frame;
    const lastDelivery = this.lastDelivery;
    if (lastDelivery) {
      if (timestampMs < lastDelivery.timestampMs + this.timing.maximumSilenceMs
        && !this.policy.wantsFrame({ timestampMs, firstTimestampMs, sample, lastDelivery })) {
        return 'policy';
      }
      if (timestampMs < lastDelivery.timestampMs + this.timing.minimumIntervalMs) {
        return 'interval';
      }
    }
    if (!this.budget.canSend(timestampMs)) {
      return 'budget';
    }
    if (!this.sink.accept(frame)) {
      return 'backpressure';
    }

    this.budget.recordDelivery(timestampMs);
    this.lastDelivery = { timestampMs, sample };
    return 'sent';
  }
}
