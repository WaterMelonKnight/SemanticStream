import type { GatewayBudget } from '../inference/wire';

export interface CostView {
  /** All monetary values are integer nano-USD internally. */
  readonly totalNanoUsd: number;
  readonly settledNanoUsd: number;
  readonly reservedNanoUsd: number;
  readonly provisionalNanoUsd: number;
  readonly availableNanoUsd: number;
  readonly utilization: number;
  readonly accepted: number;
  readonly requestLimit: number;
  readonly quarantined: number;
  readonly frozen: boolean;
  readonly estimated: true;
}

export class InvalidGatewayBudget extends Error {}

export function costView(budget: GatewayBudget): CostView {
  const values = [
    budget.limitNanoUsd, budget.settledNanoUsd, budget.provisionalNanoUsd,
    budget.reservedNanoUsd, budget.accepted, budget.requestLimit,
  ];
  if (!values.every((value) => Number.isSafeInteger(value) && value >= 0)
    || !Number.isSafeInteger(budget.quarantined) || budget.quarantined < 0
    || typeof budget.blocked !== 'boolean') throw new InvalidGatewayBudget('Invalid gateway budget fields');
  const committed = budget.settledNanoUsd + budget.provisionalNanoUsd + budget.reservedNanoUsd;
  return {
    totalNanoUsd: budget.limitNanoUsd,
    settledNanoUsd: budget.settledNanoUsd,
    reservedNanoUsd: budget.reservedNanoUsd,
    provisionalNanoUsd: budget.provisionalNanoUsd,
    availableNanoUsd: Math.max(0, budget.limitNanoUsd - committed),
    utilization: budget.limitNanoUsd > 0 ? Math.min(1, committed / budget.limitNanoUsd) : 0,
    accepted: budget.accepted,
    requestLimit: budget.requestLimit,
    quarantined: budget.quarantined,
    frozen: budget.blocked,
    estimated: true,
  };
}

export function formatUsd(nanoUsd: number | null): string {
  if (nanoUsd === null || !Number.isFinite(nanoUsd)) return '—';
  const sign = nanoUsd < 0 ? '-' : '';
  const value = Math.abs(nanoUsd) / 1_000_000_000;
  return `${sign}$${value.toFixed(6)}`;
}

export function formatUtilization(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${(100 * value).toFixed(1)}%`;
}
