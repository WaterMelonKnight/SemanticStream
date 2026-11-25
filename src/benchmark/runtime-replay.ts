import { InferenceScheduler } from '../inference/scheduler';
import type { RuntimeRecord } from '../inference/scheduler';
import { ScriptedStreamingProvider } from '../inference/scripted-provider';
import type { StreamScript } from '../inference/scripted-provider';
import type { InferenceRequest, SchedulingPolicy } from '../inference/types';
import { ReplayClock } from './runtime-clock';

const VARIANTS: readonly { name: string; policy: SchedulingPolicy; slots: number }[] = [
  { name: 'Serial FIFO', policy: 'fifo', slots: 1 },
  { name: 'Concurrent FIFO', policy: 'fifo', slots: 2 },
  { name: 'SemanticStream', policy: 'context-aware', slots: 2 },
  { name: 'SemanticStream single-slot', policy: 'context-aware', slots: 1 },
];
const DEFAULT_SCRIPT: StreamScript = { firstTokenMs: 100, intervalMs: 100, chunks: ['first', ' second'] };
const TRANSPORT = { windowMs: 500, maxFrames: 3, maxBytes: 360 };
const TOKENS_PER_TASK = 32;
const TOTAL_TOKENS = 320;
const QUEUE = 3;

function quantiles(samples: number[]) {
  const sorted = samples.sort((a, b) => a - b);
  const nearestRank = (p: number) => sorted[Math.ceil(p * sorted.length) - 1] ?? null;
  return { count: sorted.length, p50Ms: nearestRank(0.5), p95Ms: nearestRank(0.95) };
}

function evaluate(records: readonly RuntimeRecord[]) {
  const inputs = new Map<number, number>();
  const ended = new Map<number, RuntimeRecord>();
  const lastWriter = new Map<string, number>();
  let staleOutputLeaks = 0;
  for (const row of records) {
    if (row.event) inputs.set(row.event.id, row.event.ingestedAtMs);
    if (row.kind === 'end' && row.task) ended.set(row.task.id, row);
    if (row.kind !== 'output' || !row.task) continue;
    const { id, deadlineMs, session, interaction, channel } = row.task;
    const scope = [session, interaction, channel].join('/');
    if (ended.has(id) || row.atMs >= deadlineMs || id < (lastWriter.get(scope) ?? 0)) staleOutputLeaks += 1;
    lastWriter.set(scope, id);
  }
  const tasks = [...ended.values()].map(({ outcome, reason, task }) => {
    const summary = task!;
    const ingestedAt = inputs.get(summary.eventId)!;
    return {
      id: summary.id, eventId: summary.eventId, outcome, reason,
      startDelayMs: summary.startedAtMs === undefined ? null : summary.startedAtMs - ingestedAt,
      firstOutputDelayMs: summary.firstOutputAtMs === undefined ? null : summary.firstOutputAtMs - ingestedAt,
    };
  });
  const started = tasks.filter((task) => task.startDelayMs !== null);
  const expiries = tasks.filter(({ outcome }) => outcome === 'expired').length;
  const invalid = started.filter(({ outcome, firstOutputDelayMs }) =>
    outcome !== 'completed' || firstOutputDelayMs === null).length;
  return {
    taskCount: tasks.length,
    starts: started.length,
    startLatency: quantiles(started.map((task) => task.startDelayMs!)),
    firstOutputLatency: quantiles(tasks.flatMap(({ firstOutputDelayMs }) =>
      firstOutputDelayMs === null ? [] : [firstOutputDelayMs])),
    expiries,
    deadlineViolationRate: expiries / tasks.length,
    staleOutputLeaks,
    blockedPartials: records.filter(({ kind }) => kind === 'blocked').length,
    invalidInferenceCount: invalid,
    invalidInferenceShare: invalid / started.length,
    tasks,
    failures: tasks.filter(({ outcome, firstOutputDelayMs }) => outcome !== 'completed' || firstOutputDelayMs === null)
      .map(({ id, eventId, reason, outcome }) => ({
        id, eventId, outcome, reason: outcome === 'completed' ? 'Completed without effective output' : reason,
      })),
  };
}

function replay({ name, policy, slots }: (typeof VARIANTS)[number]) {
  const clock = new ReplayClock();
  const scripts = new Map<string, StreamScript>([
    ['Pixel noise', { ...DEFAULT_SCRIPT, finishAfterMs: 200 }],
    ['Critical alert', { ...DEFAULT_SCRIPT, firstTokenMs: 20, intervalMs: 40 }],
    ['Parent finishes', { ...DEFAULT_SCRIPT, firstTokenMs: 60 }],
    ['Ignores cancellation', { ...DEFAULT_SCRIPT, ignoreCancel: true, unknownUsage: true, latePartialMs: 25 }],
    ['Late terminal', { ...DEFAULT_SCRIPT, firstTokenMs: 120, cancelAfterMs: 70, latePartialMs: 20 }],
    ['Scripted failure', { ...DEFAULT_SCRIPT, fail: true }],
  ]);
  const provider = new ScriptedStreamingProvider(clock, ({ event }) => scripts.get(event.label) ?? DEFAULT_SCRIPT);
  const runtime = new InferenceScheduler(provider, clock, {
    slots, queue: QUEUE, transport: TRANSPORT, tokensPerTask: TOKENS_PER_TASK, totalTokens: TOTAL_TOKENS,
  }, policy, 4_096);
  const labels = new Map<number, string>();
  const send = (at: number, label: string, request: Partial<InferenceRequest> = {}) => {
    clock.advance(at);
    const id = runtime.ingest({
      source: 'replay', capturedAtMs: at, label, reason: 'Replay fixture',
    }, { channel: 'observation', priority: 1, ttlMs: 500, ...request }, {
      sequence: at, capturedAtMs: at, source: 'fixture', mediaType: 'text/plain', data: 'sample',
    })!;
    labels.set(id, label);
    return id;
  };

  for (let i = 0; i < 8; i += 1) send(i * 10, 'Pixel noise', { dedupeKey: 'pixel' });
  const critical = send(85, 'Critical alert', { channel: 'response', priority: 10, ttlMs: 210 });
  send(90, 'Short deadline', { ttlMs: 85 });

  clock.advance(1_000);
  runtime.newSession();
  const parent = send(1_000, 'Parent finishes');
  send(1_015, 'Depends on successful parent', { channel: 'response', dependsOn: parent });
  const ignored = send(1_600, 'Ignores cancellation');
  send(1_610, 'Depends on superseded parent', { dependsOn: ignored, channel: 'response' });
  send(1_720, 'New observation supersedes previous', { supersede: true, priority: 10 });
  send(2_050, 'Late terminal', { channel: 'response', ttlMs: 40 });
  send(2_095, 'Independent task during cancellation');
  send(2_650, 'Scripted failure');
  send(3_210, 'Transfer burst A', { ttlMs: 1_800 });
  send(3_211, 'Transfer burst B', { ttlMs: 1_800 });
  send(3_212, 'Transfer burst C', { ttlMs: 1_800 });
  send(3_213, 'Transfer burst D', { ttlMs: 1_800 });
  send(3_215, 'Transfer burst E', { channel: 'response', priority: 9, ttlMs: 1_800 });
  clock.advance(5_200);

  const snapshot = runtime.snapshot();
  const { tasks, failures, ...metrics } = evaluate(snapshot.records);
  if (tasks.length !== labels.size || snapshot.attempts.length || snapshot.queued.length) {
    throw new Error('Replay did not record every logical end and drain every attempt');
  }
  return {
    name, policy, slots, ...metrics, peakSlots: snapshot.peakSlots, peakQueue: snapshot.peakQueue,
    critical: tasks.find(({ id }) => id === critical)!,
    usage: {
      bytesDispatched: snapshot.budget.sentBytes,
      tokensSettled: snapshot.budget.settledTokens,
      tokensProvisional: snapshot.budget.provisionalTokens,
    },
    tasks: tasks.map((task) => ({ ...task, event: labels.get(task.id)! })),
    failures: failures.map((failure) => ({ ...failure, event: labels.get(failure.id)! })),
  };
}

export function runRuntimeReplay() {
  return {
    kind: 'simulation',
    description: 'Deterministic scripted inference. These timings do not measure LLM performance.',
    limits: { transport: TRANSPORT, tokensPerTask: TOKENS_PER_TASK, totalTokens: TOTAL_TOKENS, queue: QUEUE },
    variants: VARIANTS.map(replay),
  };
}
