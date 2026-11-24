export interface MetricsSnapshot {
  readonly inputs: number;
  readonly sent: number;
  readonly filteredPercent: number;
  readonly meanProcessingMs: number;
}

export class MetricsCollector {
  private inputs = 0;
  private sent = 0;
  private totalProcessingMs = 0;

  record(delivered: boolean, processingMs: number): void {
    this.inputs += 1;
    this.sent += Number(delivered);
    this.totalProcessingMs += processingMs;
  }

  snapshot(): MetricsSnapshot {
    return {
      inputs: this.inputs,
      sent: this.sent,
      filteredPercent: this.inputs ? (100 * (this.inputs - this.sent)) / this.inputs : 0,
      meanProcessingMs: this.inputs ? this.totalProcessingMs / this.inputs : 0,
    };
  }
}
