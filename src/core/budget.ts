import { RollingResourceBudget } from './resource-budget';
import type { ResourceReservation } from './resource-budget';

/** Frame-only admission for an independent comparison strategy. */
export class BudgetController {
  private readonly budget: RollingResourceBudget;

  constructor(windowMs: number, frameLimit: number) {
    this.budget = new RollingResourceBudget({ windowMs, maxFrames: frameLimit, maxBytes: 1 });
  }

  setLimit(frameLimit: number): void {
    this.budget.setLimits({ ...this.budget.limits, maxFrames: frameLimit });
  }

  reserveRealtime(timestampMs: number): ResourceReservation | null {
    return this.budget.reserve(timestampMs, 1, 0);
  }
}
