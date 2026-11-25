import type { RuntimeRecord, TaskSummary } from './scheduler';

interface Measurement {
  task: TaskSummary;
  end?: RuntimeRecord;
  terminal?: RuntimeRecord;
  first?: RuntimeRecord;
  dispatch?: RuntimeRecord;
  quarantine?: RuntimeRecord;
  blocked: number;
  stale: number;
}

function delta(end?: number, start?: number): number | undefined {
  return end !== undefined && start !== undefined ? end - start : undefined;
}

/** Keep milestones per task, independent of how many partials pass through the event journal. */
export class RuntimeMeasurements {
  private readonly tasks = new Map<number, Measurement>();

  record(row: RuntimeRecord): void {
    if (!row.task) return;
    const details = this.tasks.get(row.task.id) ?? { task: row.task, blocked: 0, stale: 0 };
    details.task = row.task;
    this.tasks.set(row.task.id, details);
    if (this.tasks.size > 160) this.tasks.delete(this.tasks.keys().next().value!);
    if (row.kind === 'dispatch') details.dispatch = row;
    if (row.kind === 'first-text') details.first = row;
    if (row.kind === 'end') details.end = row;
    if (row.kind === 'upstream') details.terminal = row;
    if (row.kind === 'quarantined') details.quarantine = row;
    if (row.kind === 'blocked') details.blocked += 1;
    if (row.staleOutput) details.stale += 1;
  }

  snapshot(session?: number) {
    return [...this.tasks.values()].filter(({ task }) => session === undefined || task.session === session)
      .map(({ task, end, terminal, first, dispatch, quarantine, blocked, stale }) => ({
        id: task.id,
        requestId: task.requestId,
        providerRequestId: terminal?.providerRequestId ?? task.providerRequestId,
        startedAtMs: task.startedAtMs,
        startDelayMs: delta(task.startedAtMs, task.ingestedAtMs),
        gatewayDispatchAtMs: dispatch?.atMs,
        firstTextDelayMs: delta(first?.atMs, task.startedAtMs),
        upstreamFirstTextMs: first?.upstreamMs,
        firstEffectiveDelayMs: delta(task.firstOutputAtMs, task.ingestedAtMs),
        outputStopMs: delta(task.stoppedAtMs, task.stopRequestedAtMs),
        waitForTerminalAfterStopMs: delta(terminal?.atMs, task.stopRequestedAtMs),
        upstreamElapsedMs: terminal?.upstreamMs,
        inputTokens: terminal?.usage?.inputTokens,
        outputTokens: terminal?.usage?.outputTokens,
        usage: terminal ? (terminal.usageUnknown ? 'unknown' : terminal.usage ? 'reported' : 'no breakdown')
          : quarantine ? 'unknown · held' : 'pending',
        outcome: end?.outcome ?? 'pending',
        reason: end?.reason,
        blocked,
        stale,
        unanswered: !!end && task.firstOutputAtMs === undefined,
      }));
  }
}
