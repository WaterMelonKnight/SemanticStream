/** A bounded single-slot queue: one in-flight request plus at most one latest pending request. */
export class LatestFrameQueue<T> {
  private pendingValue: T | null = null;
  private inFlightValue = false;

  get inFlight(): boolean {
    return this.inFlightValue;
  }

  get pending(): T | null {
    return this.pendingValue;
  }

  tryEnqueue(value: T): { readonly accepted: boolean; readonly dropped: number } {
    if (!this.inFlightValue) {
      this.inFlightValue = true;
      return { accepted: true, dropped: 0 };
    }
    const dropped = this.pendingValue === null ? 0 : 1;
    this.pendingValue = value;
    return { accepted: true, dropped };
  }

  takePending(): T | null {
    const value = this.pendingValue;
    this.pendingValue = null;
    if (value !== null) this.inFlightValue = true;
    return value;
  }

  complete(): void {
    this.inFlightValue = false;
  }

  clear(): void {
    this.pendingValue = null;
    this.inFlightValue = false;
  }
}
