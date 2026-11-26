import { describe, expect, it } from 'vitest';
import type { GatewayBudget } from '../inference/wire';
import { costView, formatUsd, formatUtilization, InvalidGatewayBudget } from './cost';

function budget(overrides: Partial<GatewayBudget> = {}): GatewayBudget {
  return {
    held: 1, slots: 2, quarantined: 1, accepted: 4, requestLimit: 20,
    limitNanoUsd: 1_000_000_000, costPerRequestNanoUsd: 2_208,
    settledNanoUsd: 80_000_000, provisionalNanoUsd: 10_000_000,
    reservedNanoUsd: 20_000_000, blocked: false,
    ...overrides,
  };
}

describe('gateway cost view', () => {
  it('keeps nano-dollar precision and computes available/utilization', () => {
    const view = costView(budget());
    expect(view.settledNanoUsd).toBe(80_000_000);
    expect(view.availableNanoUsd).toBe(890_000_000);
    expect(view.utilization).toBeCloseTo(0.11, 6);
    expect(view.estimated).toBe(true);
    expect(formatUsd(view.settledNanoUsd)).toBe('$0.080000');
    expect(formatUtilization(view.utilization)).toBe('11.0%');
    expect(view.frozen).toBe(false);
    expect(view.admission).toMatchObject({ canAdmit: true, reasons: [] });
  });

  it('clamps available budget at zero and exposes frozen/quarantine state', () => {
    const view = costView(budget({ limitNanoUsd: 100, settledNanoUsd: 90, provisionalNanoUsd: 20, reservedNanoUsd: 30, blocked: true }));
    expect(view.availableNanoUsd).toBe(0);
    expect(view.utilization).toBe(1);
    expect(view.frozen).toBe(true);
    expect(view.quarantined).toBe(1);
    expect(view.admission.canAdmit).toBe(false);
    expect(view.admission.reasons).toContain('ledger_frozen');
  });

  it('distinguishes cost, request-limit and slot constraints from an unfrozen ledger', () => {
    const cost = costView(budget({ limitNanoUsd: 100, settledNanoUsd: 99, provisionalNanoUsd: 0, reservedNanoUsd: 0, costPerRequestNanoUsd: 2 }));
    expect(cost.frozen).toBe(false);
    expect(cost.admission.canAdmit).toBe(false);
    expect(cost.admission.reasons).toEqual(['cost_exhausted']);
    const requests = costView(budget({ accepted: 20 }));
    expect(requests.admission.reasons).toEqual(['request_limit']);
    const slots = costView(budget({ held: 2 }));
    expect(slots.admission.reasons).toEqual(['slots_full']);
  });

  it('rejects negative or non-integer ledger values', () => {
    expect(() => costView(budget({ settledNanoUsd: -1 }))).toThrow(InvalidGatewayBudget);
    expect(() => costView(budget({ accepted: 1.5 }))).toThrow(InvalidGatewayBudget);
  });
});
