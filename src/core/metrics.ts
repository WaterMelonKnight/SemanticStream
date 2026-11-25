export type FrameDecision = 'policy' | 'interval' | 'budget' | 'backpressure' | 'sent';

export type FilterReason = Exclude<FrameDecision, 'sent'>;

export type FilterReasonCounts = Readonly<Record<FilterReason, number>>;

export interface MetricsSnapshot {
  readonly inputs: number;
  readonly sent: number;
  readonly filteredPercent: number;
  readonly meanProcessingMs: number;
  readonly reasons: FilterReasonCounts;
}

export class MetricsCollector {
  private inputs = 0;
  private sent = 0;
  private totalProcessingMs = 0;
  private readonly reasons: Record<FilterReason, number> = {
    policy: 0,
    interval: 0,
    budget: 0,
    backpressure: 0,
  };

  record(decision: FrameDecision, processingMs: number): void {
    this.inputs += 1;
    if (decision === 'sent') {
      this.sent += 1;
    } else {
      this.reasons[decision] += 1;
    }
    this.totalProcessingMs += processingMs;
  }

  snapshot(): MetricsSnapshot {
    return {
      inputs: this.inputs,
      sent: this.sent,
      filteredPercent: this.inputs ? (100 * (this.inputs - this.sent)) / this.inputs : 0,
      meanProcessingMs: this.inputs ? this.totalProcessingMs / this.inputs : 0,
      reasons: { ...this.reasons },
    };
  }
}
