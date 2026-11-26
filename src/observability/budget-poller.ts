import type { GatewayBudget } from '../inference/wire';

export type BudgetPollResult =
  | { readonly status: 'updated'; readonly budget: GatewayBudget; readonly atMs: number }
  | { readonly status: 'error'; readonly message: string; readonly atMs: number }
  | { readonly status: 'skipped' };

/**
 * Bounded, non-overlapping gateway budget polling. A failed poll is returned as
 * data and never thrown into the inference path.
 */
export class BudgetPoller {
  private inFlight = false;

  constructor(
    private readonly fetchBudget: () => Promise<GatewayBudget>,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get busy(): boolean {
    return this.inFlight;
  }

  async poll(): Promise<BudgetPollResult> {
    if (this.inFlight) return { status: 'skipped' };
    this.inFlight = true;
    try {
      return { status: 'updated', budget: await this.fetchBudget(), atMs: this.now() };
    } catch (error) {
      return {
        status: 'error',
        message: error instanceof Error ? error.message.slice(0, 160) : 'Gateway budget unavailable',
        atMs: this.now(),
      };
    } finally {
      this.inFlight = false;
    }
  }
}
