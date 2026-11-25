import { MetricsCollector } from './metrics';
import type { FrameDecision, MetricsSnapshot } from './metrics';
import type { SamplingContext, SamplingPolicy } from './sampling';
import type { DeliveryAdmission } from './resource-admission';
import type { ContextSink, StreamFrame } from './stream';

export interface DeliveryTiming {
  readonly minimumIntervalMs: number;
  readonly maximumSilenceMs: number;
}

export type { FrameDecision } from './metrics';

export class Sampler<T, Sample> {
  private readonly metrics = new MetricsCollector();
  private firstTimestampMs: number | undefined;
  private previousTimestampMs = -Infinity;
  private deliveredAtMs: number | null = null;
  private selection: 'first-frame' | 'silence-refresh' | 'policy' | null = null;
  private delivering = false;
  private lastDelivery: SamplingContext<Sample>['lastDelivery'] | undefined;

  constructor(
    private readonly policy: SamplingPolicy<Sample>,
    private readonly admission: DeliveryAdmission,
    private readonly timing: DeliveryTiming,
    private readonly sink: ContextSink<T>,
    private readonly now: () => number = () => performance.now(),
    private readonly deliveryBytes = 0,
    private readonly deliveryClock?: () => number,
  ) {
    if (!Number.isFinite(timing.minimumIntervalMs) || timing.minimumIntervalMs < 0
      || !Number.isFinite(timing.maximumSilenceMs) || timing.maximumSilenceMs <= 0) {
      throw new RangeError('Delivery timing must be finite, with positive maximum silence.');
    }
  }

  /** Samples are immutable and may be retained as the most recent accepted baseline. */
  process(frame: StreamFrame<T>, sample: Sample, preparationMs = 0): FrameDecision {
    if (this.delivering) throw new Error('Sampler processing cannot be reentered by its sink.');
    const startedAt = this.now();
    const { timestampMs } = frame;
    if (!Number.isFinite(timestampMs) || timestampMs < this.previousTimestampMs) {
      throw new RangeError('Frame timestamps must be finite and nondecreasing.');
    }
    this.firstTimestampMs ??= timestampMs;
    this.previousTimestampMs = timestampMs;

    const decision = this.deliver(frame, sample, this.firstTimestampMs);
    this.metrics.record(decision, preparationMs + (this.now() - startedAt));
    return decision;
  }

  get lastDeliveredAtMs(): number | null {
    return this.deliveredAtMs;
  }

  get lastSelection() {
    return this.selection;
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
    const reservation = this.admission.reserveRealtime(this.deliveryClock?.() ?? timestampMs, this.deliveryBytes);
    if (!reservation) return 'budget';

    this.delivering = true;
    try {
      if (!this.sink.accept(frame)) return 'backpressure';
      const deliveredAtMs = this.deliveryClock?.() ?? timestampMs;
      reservation.commit(deliveredAtMs);
      this.deliveredAtMs = deliveredAtMs;
      this.selection = !lastDelivery ? 'first-frame'
        : timestampMs >= lastDelivery.timestampMs + this.timing.maximumSilenceMs ? 'silence-refresh' : 'policy';
      this.lastDelivery = { timestampMs, sample };
      return 'sent';
    } finally {
      reservation.release();
      this.delivering = false;
    }
  }
}
