import { describe, expect, it } from 'vitest';
import { BudgetController } from './budget';

describe('rolling frame budget', () => {
  it('expires only deliveries that have reached the full window age', () => {
    const budget = new BudgetController(5_000, 2);
    expect(budget.canSend(0)).toBe(true);
    budget.recordDelivery(0);
    expect(budget.canSend(400)).toBe(true);
    budget.recordDelivery(400);
    expect(budget.canSend(4_999)).toBe(false);
    expect(budget.canSend(5_000)).toBe(true);
    budget.recordDelivery(5_000);
    expect(budget.canSend(5_399)).toBe(false);
    expect(budget.canSend(5_400)).toBe(true);
  });

  it('expires a fractional timestamp at its exact deadline', () => {
    const budget = new BudgetController(5_000, 1);
    expect(budget.canSend(100.2)).toBe(true);
    budget.recordDelivery(100.2);

    expect(budget.canSend(5_100.199)).toBe(false);
    expect(budget.canSend(5_100.2)).toBe(true);
  });

  it('keeps recent deliveries when lowering or raising the cap', () => {
    const budget = new BudgetController(5_000, 3);
    for (const timestamp of [0, 500, 1_000]) {
      expect(budget.canSend(timestamp)).toBe(true);
      budget.recordDelivery(timestamp);
    }
    budget.setLimit(1);
    expect(budget.canSend(5_500)).toBe(false);
    budget.setLimit(2);
    expect(budget.canSend(5_500)).toBe(true);
    budget.recordDelivery(5_500);
    budget.setLimit(1);
    expect(budget.canSend(10_499)).toBe(false);
    expect(budget.canSend(10_500)).toBe(true);
  });

  it('requires a finite positive window and a positive integer frame cap', () => {
    expect(() => new BudgetController(Infinity, 5)).toThrow(RangeError);
    expect(() => new BudgetController(5_000, 0)).toThrow(RangeError);
    expect(() => new BudgetController(5_000, 3).setLimit(1.5)).toThrow(RangeError);
  });
});
