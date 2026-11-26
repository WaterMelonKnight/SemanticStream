import { describe, expect, it } from 'vitest';
import { BudgetPoller } from './budget-poller';

function budget() {
  return {
    held: 0, slots: 2, quarantined: 0, accepted: 0, requestLimit: 20, limitNanoUsd: 100,
    costPerRequestNanoUsd: 1, settledNanoUsd: 0, provisionalNanoUsd: 0, reservedNanoUsd: 0, blocked: false,
  };
}

describe('budget poller', () => {
  it('does not overlap requests', async () => {
    let resolve!: (value: ReturnType<typeof budget>) => void;
    let calls = 0;
    const poller = new BudgetPoller(() => { calls += 1; return new Promise((done) => { resolve = done; }); }, () => 7);
    const first = poller.poll();
    expect(poller.busy).toBe(true);
    await expect(poller.poll()).resolves.toEqual({ status: 'skipped' });
    resolve(budget());
    await expect(first).resolves.toMatchObject({ status: 'updated', atMs: 7 });
    expect(calls).toBe(1);
    expect(poller.busy).toBe(false);
  });

  it('returns network errors as data and clears the in-flight guard', async () => {
    const poller = new BudgetPoller(async () => { throw new Error('offline'); }, () => 9);
    await expect(poller.poll()).resolves.toEqual({ status: 'error', message: 'offline', atMs: 9 });
    expect(poller.busy).toBe(false);
  });
});
