import type { RuntimeMeasurementSnapshot } from '../inference/runtime-metrics';

export interface LatencySummary {
  readonly count: number;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
}

export interface RuntimeSummary {
  readonly tasks: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly expired: number;
  readonly invalidated: number;
  readonly rejected: number;
  readonly pending: number;
  readonly unanswered: number;
  readonly staleOutputs: number;
  readonly blockedOutputs: number;
  readonly knownUsage: number;
  readonly unknownUsage: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly firstText: LatencySummary;
  readonly effectiveOutput: LatencySummary;
  readonly upstream: LatencySummary;
  readonly stopToTerminal: LatencySummary;
  readonly reasons: Readonly<Record<string, number>>;
}

function latency(values: Array<number | undefined>): LatencySummary {
  const sorted = values.filter((value): value is number => value !== undefined && Number.isFinite(value))
    .sort((left, right) => left - right);
  if (!sorted.length) return { count: 0, p50Ms: null, p95Ms: null };
  const at = (fraction: number): number => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
  return { count: sorted.length, p50Ms: at(0.5), p95Ms: at(0.95) };
}

export function summarizeRuntime(measurements: readonly RuntimeMeasurementSnapshot[]): RuntimeSummary {
  const outcomes = {
    completed: 0, failed: 0, cancelled: 0, expired: 0, invalidated: 0, rejected: 0, pending: 0,
  };
  const reasons: Record<string, number> = {};
  let unanswered = 0;
  let staleOutputs = 0;
  let blockedOutputs = 0;
  let knownUsage = 0;
  let unknownUsage = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  const firstText: Array<number | undefined> = [];
  const effectiveOutput: Array<number | undefined> = [];
  const upstream: Array<number | undefined> = [];
  const stopToTerminal: Array<number | undefined> = [];
  for (const task of measurements) {
    if (task.outcome in outcomes) outcomes[task.outcome as keyof typeof outcomes] += 1;
    else outcomes.pending += 1;
    if (task.reason) reasons[task.reason] = (reasons[task.reason] ?? 0) + 1;
    if (task.unanswered) unanswered += 1;
    staleOutputs += task.stale;
    blockedOutputs += task.blocked;
    if (task.usage === 'reported') {
      knownUsage += 1;
      inputTokens += task.inputTokens ?? 0;
      outputTokens += task.outputTokens ?? 0;
    } else if (task.usage.startsWith('unknown')) unknownUsage += 1;
    firstText.push(task.firstTextDelayMs);
    effectiveOutput.push(task.firstEffectiveDelayMs);
    upstream.push(task.upstreamElapsedMs);
    stopToTerminal.push(task.waitForTerminalAfterStopMs);
  }
  return {
    tasks: measurements.length,
    ...outcomes,
    unanswered,
    staleOutputs,
    blockedOutputs,
    knownUsage,
    unknownUsage,
    inputTokens,
    outputTokens,
    firstText: latency(firstText),
    effectiveOutput: latency(effectiveOutput),
    upstream: latency(upstream),
    stopToTerminal: latency(stopToTerminal),
    reasons,
  };
}
