export class BudgetController {
  private readonly deliveries: number[] = [];
  private frameLimit: number;

  constructor(private readonly windowMs: number, frameLimit: number) {
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new RangeError('Budget window must be positive and finite.');
    }
    this.frameLimit = BudgetController.validateLimit(frameLimit);
  }

  setLimit(frameLimit: number): void {
    this.frameLimit = BudgetController.validateLimit(frameLimit);
  }

  canSend(timestampMs: number): boolean {
    while (this.deliveries.length && this.deliveries[0] <= timestampMs - this.windowMs) {
      this.deliveries.shift();
    }
    return this.deliveries.length < this.frameLimit;
  }

  /** Record only after canSend and synchronous sink acceptance. */
  recordDelivery(timestampMs: number): void {
    this.deliveries.push(timestampMs);
  }

  private static validateLimit(frameLimit: number): number {
    if (!Number.isSafeInteger(frameLimit) || frameLimit < 1) {
      throw new RangeError('Frame limit must be a positive integer.');
    }
    return frameLimit;
  }
}
