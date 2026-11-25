import { RollingResourceBudget } from '../core/resource-budget';
import type { ResourceBudgetLimits } from '../core/resource-budget';
import { BoundedTimeline } from '../core/timeline';
import { OutputCoordinator } from './output';
import type {
  ContextSnapshot, Evidence, InferenceProvider, InferenceRequest, InferenceTask, OutputChannel,
  PartialOutput, ProviderTerminal, RuntimeClock, SchedulingPolicy, StreamEvent,
} from './types';

type Outcome = 'completed' | 'failed' | 'cancelled' | 'expired' | 'invalidated' | 'rejected';

interface ActiveTask {
  readonly task: InferenceTask;
  readonly clearDeadline: () => void;
  waitingFor?: number;
  slot?: number;
  startedAtMs?: number;
  firstOutputAtMs?: number;
  outcome?: Outcome;
}

interface Attempt {
  readonly work: ActiveTask;
  readonly controller: AbortController;
  nextIndex: number;
}

export interface TaskSummary {
  readonly id: number;
  readonly eventId: number;
  readonly channel: OutputChannel;
  readonly session: number;
  readonly interaction: number;
  readonly context: number;
  readonly evidence: readonly number[];
  readonly deadlineMs: number;
  readonly slot?: number;
  readonly startedAtMs?: number;
  readonly firstOutputAtMs?: number;
}

export interface RuntimeRecord {
  readonly atMs: number;
  readonly kind: 'input' | 'queued' | 'start' | 'output' | 'blocked' | 'end' | 'upstream';
  readonly reason: string;
  readonly event?: StreamEvent;
  readonly task?: TaskSummary;
  readonly outcome?: Outcome;
}

export interface RuntimeLimits {
  readonly slots: number;
  readonly queue: number;
  readonly transport: ResourceBudgetLimits;
  readonly totalTokens: number;
  readonly tokensPerTask: number;
}

const MAX_EVIDENCE_BYTES = 32_768;
const MAX_EVIDENCE_ITEMS = 3;
const MAX_EVIDENCE_AGE_MS = 3_000;
const MAX_TIMER_MS = 2_147_483_647;
const encoder = new TextEncoder();

function view({ task, slot, startedAtMs, firstOutputAtMs }: ActiveTask): TaskSummary {
  return {
    id: task.id, eventId: task.event.id, channel: task.channel,
    session: task.sessionVersion, interaction: task.interactionVersion, context: task.contextVersion,
    evidence: task.context.evidence.map(({ sequence }) => sequence),
    deadlineMs: task.deadlineMs, slot, startedAtMs, firstOutputAtMs,
  };
}

/** One scheduler owns the endpoint slots across session/interaction changes. */
export class InferenceScheduler {
  private readonly journal: BoundedTimeline<RuntimeRecord>;
  private readonly output = new OutputCoordinator();
  private readonly transport: RollingResourceBudget;
  private readonly queue: ActiveTask[] = [];
  private readonly attempts = new Map<number, Attempt>();
  private evidence: readonly { item: Evidence; bytes: number }[] = [];
  private readonly limits: RuntimeLimits;
  private policy: SchedulingPolicy;
  private slots: number;
  private session = 1;
  private interaction = 1;
  private eventId = 0;
  private taskId = 0;
  private contextVersion = 0;
  private reservedTokens = 0;
  private settledTokens = 0;
  private provisionalTokens = 0;
  private sentBytes = 0;
  private peakQueue = 0;
  private peakSlots = 0;
  private batchDepth = 0;
  private pumping = false;

  constructor(
    private readonly provider: InferenceProvider,
    private readonly clock: RuntimeClock,
    limits: RuntimeLimits,
    policy: SchedulingPolicy,
    journalSize = 160,
  ) {
    for (const value of [limits.slots, limits.queue, limits.totalTokens, limits.tokensPerTask]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('Runtime caps must be positive integers');
    }
    this.limits = { ...limits };
    this.slots = limits.slots;
    this.policy = policy;
    this.transport = new RollingResourceBudget(limits.transport);
    this.journal = new BoundedTimeline(journalSize);
  }

  ingest(
    input: Omit<StreamEvent, 'id' | 'sessionVersion' | 'ingestedAtMs'>,
    request?: InferenceRequest,
    evidence?: Evidence,
  ): number | undefined {
    const now = this.clock.now();
    if (request && (!Number.isFinite(request.priority) || !Number.isFinite(request.ttlMs)
      || request.ttlMs <= 0 || request.ttlMs > MAX_TIMER_MS)) {
      throw new RangeError('Task priority and timer delay must be finite and the delay must fit a timer');
    }
    const event: StreamEvent = Object.freeze({
      source: input.source, capturedAtMs: input.capturedAtMs,
      label: input.label.slice(0, 500), reason: input.reason.slice(0, 200),
      id: ++this.eventId, sessionVersion: this.session, ingestedAtMs: now,
    });
    this.record('input', event.reason, undefined, event);
    this.evidence = this.evidence.filter(({ item }) => now - item.capturedAtMs <= MAX_EVIDENCE_AGE_MS);
    if (evidence && evidence.data.length <= MAX_EVIDENCE_BYTES) {
      const bytes = encoder.encode(evidence.data).byteLength;
      if (bytes <= MAX_EVIDENCE_BYTES && evidence.capturedAtMs <= now
        && now - evidence.capturedAtMs <= MAX_EVIDENCE_AGE_MS) {
        const item = Object.freeze({
          source: evidence.source.slice(0, 64), mediaType: evidence.mediaType.slice(0, 64),
          sequence: evidence.sequence, capturedAtMs: evidence.capturedAtMs, data: evidence.data,
        });
        this.evidence = [...this.evidence, { item, bytes }].slice(-MAX_EVIDENCE_ITEMS);
      }
    }
    if (!request) return;
    const context: ContextSnapshot = Object.freeze({
      version: ++this.contextVersion,
      evidence: Object.freeze(this.evidence.map(({ item }) => item)),
      encodedBytes: this.evidence.reduce((total, { bytes }) => total + bytes, encoder.encode(event.label).byteLength),
    });
    const { channel, priority, dependsOn, supersede, ttlMs } = request;
    const task: InferenceTask = Object.freeze({
      id: ++this.taskId, event, channel, priority, dependsOn, dedupeKey: request.dedupeKey?.slice(0, 80),
      sessionVersion: this.session, interactionVersion: this.interaction,
      context, contextVersion: context.version, deadlineMs: now + ttlMs, tokenLimit: this.limits.tokensPerTask,
    });

    this.batch(() => {
      if (supersede) this.retire('Channel superseded', channel);
      const active = this.active();
      const reject = (reason: string) => this.record('end', reason, { task, clearDeadline() {} }, undefined, 'rejected');
      if (dependsOn !== undefined && !active.some((work) => work.task.id === dependsOn)) {
        reject('Dependency unavailable');
        return;
      }
      if (this.policy === 'context-aware' && task.dedupeKey !== undefined && active.some(({ task: other }) =>
        other.channel === task.channel && other.dedupeKey === task.dedupeKey)) {
        reject('Repeated event coalesced');
        return;
      }
      if (this.queue.length >= this.limits.queue) {
        const required = new Set<number>();
        let parent = dependsOn;
        while (parent !== undefined) {
          required.add(parent);
          parent = active.find(({ task }) => task.id === parent)?.waitingFor;
        }
        const lowest = this.queue.filter(({ task }) => !required.has(task.id))
          .sort((a, b) => this.compare(a, b)).at(-1);
        if (this.policy !== 'context-aware' || !lowest || priority <= lowest.task.priority) {
          reject('Queue full');
          return;
        }
        this.finish(lowest, 'invalidated', 'Displaced by higher priority');
      }
      const work: ActiveTask = {
        task, waitingFor: dependsOn,
        clearDeadline: this.clock.after(Math.max(0, task.deadlineMs - this.clock.now()), () => {
          this.batch(() => this.finish(work, 'expired', 'Deadline expired'));
        }),
      };
      this.queue.push(work);
      this.record('queued', dependsOn === undefined ? 'Admitted' : 'Waiting for dependency #' + dependsOn, work);
    });
    return task.id;
  }

  interrupt(): void {
    this.batch(() => {
      this.interaction += 1;
      this.retire('User interrupted', undefined, 'cancelled');
    });
  }

  newSession(policy = this.policy, slots = this.slots): void {
    if (!Number.isSafeInteger(slots) || slots < 1 || slots > this.limits.slots) {
      throw new RangeError('Selected slot count exceeds endpoint capacity');
    }
    this.batch(() => {
      this.session += 1;
      this.interaction += 1;
      this.policy = policy;
      this.slots = slots;
      this.evidence = [];
      this.retire('Session changed');
    });
  }

  snapshot() {
    return {
      records: this.journal.toArray(),
      outputs: this.output.snapshot(),
      queued: this.queue.map(view),
      attempts: [...this.attempts.values()].map(({ work }) => ({ ...view(work), outcome: work.outcome })),
      slots: this.slots,
      peakSlots: this.peakSlots,
      peakQueue: this.peakQueue,
      budget: {
        sentBytes: this.sentBytes,
        rolling: this.transport.used(this.clock.now()),
        rollingLimits: this.transport.limits,
        tokenLimit: this.limits.totalTokens,
        settledTokens: this.settledTokens,
        reservedTokens: this.reservedTokens,
        provisionalTokens: this.provisionalTokens,
      },
    };
  }

  private active(): ActiveTask[] {
    return [...this.queue, ...[...this.attempts.values()].map(({ work }) => work)].filter((work) => !work.outcome);
  }

  private retire(reason: string, channel?: OutputChannel, outcome: Outcome = 'invalidated'): void {
    this.output.retire(channel);
    for (const work of this.active()) {
      if (channel === undefined || work.task.channel === channel) this.finish(work, outcome, reason);
    }
  }

  private finish(work: ActiveTask, outcome: Outcome, reason: string): void {
    if (work.outcome) return;
    work.outcome = outcome;
    work.clearDeadline();
    const index = this.queue.indexOf(work);
    if (index >= 0) this.queue.splice(index, 1);
    this.output.finish(work.task, outcome === 'completed');
    this.record('end', reason, work, undefined, outcome);
    for (const dependent of [...this.queue]) {
      if (dependent.waitingFor !== work.task.id) continue;
      if (outcome === 'completed') dependent.waitingFor = undefined;
      else this.finish(dependent, 'invalidated', 'Dependency did not complete');
    }
    this.attempts.get(work.task.id)?.controller.abort();
  }

  private compare(a: ActiveTask, b: ActiveTask): number {
    return b.task.priority - a.task.priority || a.task.deadlineMs - b.task.deadlineMs || a.task.id - b.task.id;
  }

  private batch(action: () => void): void {
    this.batchDepth += 1;
    try {
      action();
    } finally {
      this.batchDepth -= 1;
      this.pump();
    }
  }

  private pump(): void {
    if (this.pumping || this.batchDepth) return;
    this.pumping = true;
    try {
      while (this.attempts.size < this.slots) {
        const ready = this.queue.filter((work) => work.waitingFor === undefined);
        if (this.policy === 'context-aware') ready.sort((a, b) => this.compare(a, b));
        const work = ready[0];
        if (!work) break;
        this.dispatch(work);
      }
    } finally {
      this.peakQueue = Math.max(this.peakQueue, this.queue.length);
      this.pumping = false;
    }
  }

  private dispatch(work: ActiveTask): void {
    const { task } = work;
    const now = this.clock.now();
    if (now >= task.deadlineMs) {
      this.finish(work, 'expired', 'Deadline expired before dispatch');
      return;
    }
    const exposure = this.reservedTokens + this.settledTokens + this.provisionalTokens;
    if (task.tokenLimit > this.limits.totalTokens - exposure) {
      this.finish(work, 'rejected', 'Cumulative token budget exhausted');
      return;
    }
    const transfer = this.transport.reserve(now, 1, task.context.encodedBytes);
    if (!transfer) {
      this.finish(work, 'rejected', 'Rolling request/byte budget exhausted');
      return;
    }
    this.queue.splice(this.queue.indexOf(work), 1);
    work.startedAtMs = now;
    const occupied = new Set([...this.attempts.values()].map(({ work: running }) => running.slot));
    let slot = 1;
    while (occupied.has(slot)) slot += 1;
    work.slot = slot;
    const attempt: Attempt = { work, controller: new AbortController(), nextIndex: 0 };
    this.attempts.set(task.id, attempt);
    this.peakSlots = Math.max(this.peakSlots, this.attempts.size);
    this.reservedTokens += task.tokenLimit;
    // Charge the local dispatch once. A provider can report zero usage without refunding transport.
    transfer.commit(now);
    this.sentBytes += task.context.encodedBytes;
    this.record('start', this.policy === 'fifo' ? 'Oldest ready task' : 'Priority, then earliest deadline', work);
    try {
      this.provider.start(task, attempt.controller.signal, {
        partial: (chunk) => this.partial(attempt, chunk),
        terminal: (receipt) => this.batch(() => this.terminal(attempt, receipt)),
      });
    } catch {
      this.finish(work, 'failed', 'Dispatch threw without reliable terminal evidence');
    }
  }

  private partial(attempt: Attempt, chunk: PartialOutput): void {
    const { work } = attempt;
    const { task } = work;
    const now = this.clock.now();
    const active = this.attempts.get(task.id) === attempt && !work.outcome;
    const accepted = this.output.partial(task, chunk, attempt.nextIndex, active, this.session, this.interaction, now);
    if (chunk.index === attempt.nextIndex) attempt.nextIndex += 1;
    if (accepted) {
      work.firstOutputAtMs ??= now;
      this.record('output', 'Authorized partial', work);
    } else {
      this.record('blocked', active ? 'Writer, deadline or chunk check' : 'Task no longer eligible', work);
    }
  }

  private terminal(attempt: Attempt, receipt: ProviderTerminal): void {
    const { work } = attempt;
    const { task } = work;
    if (this.attempts.get(task.id) !== attempt) return;
    if (receipt.status !== 'completed' && receipt.status !== 'failed' && receipt.status !== 'cancelled') return;

    this.attempts.delete(task.id);
    this.reservedTokens -= task.tokenLimit;
    const { tokens } = receipt;
    const known = tokens !== null && Number.isSafeInteger(tokens) && tokens >= 0;
    if (known) this.settledTokens += tokens;
    else this.provisionalTokens += task.tokenLimit;
    this.record('upstream', receipt.status + (known ? ' · ' + tokens + ' tokens' : ' · usage unknown'), work);
    if (this.clock.now() >= task.deadlineMs) this.finish(work, 'expired', 'Terminal arrived at or after deadline');
    else this.finish(work, receipt.status, receipt.reason?.slice(0, 200) ?? 'Upstream ' + receipt.status);
  }

  private record(
    kind: RuntimeRecord['kind'], reason: string, work?: ActiveTask, event?: StreamEvent, outcome?: Outcome,
  ): void {
    this.journal.push({ atMs: this.clock.now(), kind, reason, task: work && view(work), event, outcome });
  }
}
