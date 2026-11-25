import { describe, expect, it } from 'vitest';
import { BudgetController } from './budget';

function canSend(budget: BudgetController, time: number): boolean {
  return budget.reserveRealtime(time)?.release() ?? false;
}

describe('rolling frame budget', () => {
  it('expires only deliveries that have reached the full window age', () => {
    const budget = new BudgetController(5_000, 2);
    expect(canSend(budget, 0)).toBe(true);
    budget.reserveRealtime(0)?.commit(0);
    expect(canSend(budget, 400)).toBe(true);
    budget.reserveRealtime(400)?.commit(400);
    expect(canSend(budget, 4_999)).toBe(false);
    expect(canSend(budget, 5_000)).toBe(true);
    budget.reserveRealtime(5_000)?.commit(5_000);
    expect(canSend(budget, 5_399)).toBe(false);
    expect(canSend(budget, 5_400)).toBe(true);
  });

  it('expires a fractional timestamp at its exact deadline', () => {
    const budget = new BudgetController(5_000, 1);
    expect(canSend(budget, 100.2)).toBe(true);
    budget.reserveRealtime(100.2)?.commit(100.2);

    expect(canSend(budget, 5_100.199)).toBe(false);
    expect(canSend(budget, 5_100.2)).toBe(true);
  });

  it('keeps recent deliveries when lowering or raising the cap', () => {
    const budget = new BudgetController(5_000, 3);
    for (const timestamp of [0, 500, 1_000]) {
      expect(canSend(budget, timestamp)).toBe(true);
      budget.reserveRealtime(timestamp)?.commit(timestamp);
    }
    budget.setLimit(1);
    expect(canSend(budget, 5_500)).toBe(false);
    budget.setLimit(2);
    expect(canSend(budget, 5_500)).toBe(true);
    budget.reserveRealtime(5_500)?.commit(5_500);
    budget.setLimit(1);
    expect(canSend(budget, 10_499)).toBe(false);
    expect(canSend(budget, 10_500)).toBe(true);
  });

  it('requires a finite positive window and a positive integer frame cap', () => {
    expect(() => new BudgetController(Infinity, 5)).toThrow(RangeError);
    expect(() => new BudgetController(5_000, 0)).toThrow(RangeError);
    expect(() => new BudgetController(5_000, 3).setLimit(1.5)).toThrow(RangeError);
  });
});
