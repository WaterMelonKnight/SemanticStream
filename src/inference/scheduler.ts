import { RollingResourceBudget } from '../core/resource-budget';
import type { ResourceBudgetLimits } from '../core/resource-budget';
import { BoundedTimeline } from '../core/timeline';
import { OutputCoordinator } from './output';
import { RuntimeMeasurements } from './runtime-metrics';
import { validTokenCount } from './types';
import type {
  ChatMessage, ContextSnapshot, InferenceOrigin, Evidence, InferenceProvider, InferenceRequest, InferenceTask, OutputChannel,
  PartialOutput, ProviderTerminal, RuntimeClock, SchedulingPolicy, StreamEvent, TokenUsage,
} from './types';

type Outcome = 'completed' | 'failed' | 'cancelled' | 'expired' | 'invalidated' | 'rejected';

interface ActiveTask {
  readonly task: InferenceTask;
  readonly clearDeadline: () => void;
  readonly isStillRelevant?: () => boolean;
  waitingFor?: number;
  slot?: number;
  startedAtMs?: number;
  firstOutputAtMs?: number;
  firstTextAtMs?: number;
  requestId?: string;
  providerRequestId?: string;
  upstreamDispatched?: boolean;
  stopRequestedAtMs?: number;
  stoppedAtMs?: number;
  quarantined?: boolean;
  outcome?: Outcome;
}

interface Attempt {
  readonly work: ActiveTask;
  readonly controller: AbortController;
  nextIndex: number;
  stopWatchdog?: () => void;
}

export interface TaskSummary {
  readonly id: number;
  readonly eventId: number;
  readonly ingestedAtMs: number;
  readonly channel: OutputChannel;
  readonly origin?: InferenceOrigin;
  readonly session: number;
  readonly interaction: number;
  readonly context: number;
  readonly contextBytes: number;
  readonly evidence: readonly number[];
  readonly deadlineMs: number;
  readonly slot?: number;
  readonly startedAtMs?: number;
  readonly firstOutputAtMs?: number;
  readonly firstTextAtMs?: number;
  readonly requestId?: string;
  readonly providerRequestId?: string;
  readonly stopRequestedAtMs?: number;
  readonly stoppedAtMs?: number;
  readonly quarantined?: boolean;
}

export interface RuntimeRecord {
  readonly atMs: number;
  readonly kind: 'input' | 'queued' | 'start' | 'output' | 'blocked' | 'end' | 'upstream' | 'request' | 'dispatch' | 'first-text' | 'quarantined';
  readonly reason: string;
  readonly event?: StreamEvent;
  readonly task?: TaskSummary;
  readonly outcome?: Outcome;
  readonly upstreamMs?: number;
  readonly staleOutput?: boolean;
  readonly firstValidOutput?: boolean;
  readonly usage?: TokenUsage;
  readonly usageUnknown?: boolean;
  readonly providerRequestId?: string;
}

export interface RuntimeLimits {
  readonly slots: number;
  readonly queue: number;
  readonly transport: ResourceBudgetLimits;
  readonly totalTokens: number;
  readonly tokensPerTask: number;
  readonly inputTokensPerTask?: number;
  readonly terminalGraceMs?: number;
}

const MAX_EVIDENCE_BYTES = 32_768;
const MAX_EVIDENCE_ITEMS = 3;
const MAX_EVIDENCE_AGE_MS = 3_000;
const MAX_TIMER_MS = 2_147_483_647;
const encoder = new TextEncoder();

function view({
  task, slot, startedAtMs, firstOutputAtMs, firstTextAtMs, requestId, providerRequestId, stopRequestedAtMs, stoppedAtMs, quarantined,
}: ActiveTask): TaskSummary {
  return {
    id: task.id, eventId: task.event.id, ingestedAtMs: task.event.ingestedAtMs, channel: task.channel,
    session: task.sessionVersion, interaction: task.interactionVersion, context: task.contextVersion, contextBytes: task.context.encodedBytes,
    origin: task.event.origin, evidence: task.context.evidence.map(({ sequence }) => sequence),
    deadlineMs: task.deadlineMs, slot, startedAtMs, firstOutputAtMs,
    firstTextAtMs, requestId, providerRequestId, stopRequestedAtMs, stoppedAtMs, quarantined,
  };
}

/** One scheduler owns the endpoint slots across session/interaction changes. */
export class InferenceScheduler {
  private readonly journal: BoundedTimeline<RuntimeRecord>;
  private readonly measurements = new RuntimeMeasurements();
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
  private settledInputTokens = 0;
  private settledOutputTokens = 0;
  private unknownUsageCount = 0;
  private reservationOverrun = false;
  private conversation: readonly ChatMessage[] = [];
  private sentBytes = 0;
  private peakQueue = 0;
  private peakSlots = 0;
  private batchDepth = 0;
  private pumping = false;
  private readonly listeners = new Set<(record: RuntimeRecord) => void>();

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
    if (!validTokenCount(limits.inputTokensPerTask ?? 0) || !validTokenCount(limits.tokensPerTask)
      || !Number.isInteger(limits.terminalGraceMs ?? 45_000) || (limits.terminalGraceMs ?? 45_000) < 1
      || (limits.terminalGraceMs ?? 45_000) > MAX_TIMER_MS) throw new RangeError('Invalid inference reservation or grace period');
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
      origin: input.origin && Object.freeze({ ...input.origin }),
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
    const label = event.source === 'scenario' ? 'Synthetic monitor event: ' + event.label : event.label;
    const current: ChatMessage = Object.freeze({
      role: 'user', content: request.structuredText
        ? request.structuredText.slice(0, 790) + '\n\n' + label.slice(0, 210)
        : request.textContext ? request.textContext.slice(0, 300) + '\n\n' + label : label,
    });
    const history = request.channel === 'response' && event.source === 'user' ? this.conversation : [];
    const messages = Object.freeze([...history, current]);
    const context: ContextSnapshot = Object.freeze({
      version: ++this.contextVersion,
      evidence: Object.freeze(this.evidence.map(({ item }) => item)),
      messages,
      encodedBytes: messages.reduce((total, message) => total + encoder.encode(message.content).byteLength, 0)
        + this.evidence.reduce((total, { bytes }) => total + bytes, 0),
    });
    const { channel, priority, dependsOn, supersede, ttlMs } = request;
    const task: InferenceTask = Object.freeze({
      id: ++this.taskId, event, channel, priority, dependsOn, dedupeKey: request.dedupeKey?.slice(0, 80),
      sessionVersion: this.session, interactionVersion: this.interaction,
      context, contextVersion: context.version, deadlineMs: now + ttlMs, tokenLimit: this.limits.tokensPerTask,
      tokenReservation: this.limits.tokensPerTask + (this.limits.inputTokensPerTask ?? 0),
    });

    this.batch(() => {
      if (request.supersedeLowerPriority) {
        for (const other of this.active()) {
          if (other.task.channel === channel && other.task.priority < priority) {
            this.finish(other, 'invalidated', 'Superseded by a higher priority event');
          }
        }
      }
      if (supersede) this.retire('Channel superseded', channel);
      const active = this.active();
      const reject = (reason: string) => this.record('end', reason, { task, clearDeadline() {} }, undefined, 'rejected');
      if (this.quarantinedSlots() >= this.slots) {
        reject('All endpoint slots quarantined');
        return;
      }
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
        task, waitingFor: dependsOn, isStillRelevant: request.isStillRelevant,
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
      this.conversation = [];
      this.retire('Session changed');
    });
  }

  snapshot() {
    return {
      sessionVersion: this.session,
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
        settledInputTokens: this.settledInputTokens,
        settledOutputTokens: this.settledOutputTokens,
        unknownUsageCount: this.unknownUsageCount,
        reservationOverrun: this.reservationOverrun,
        quarantinedSlots: this.quarantinedSlots(),
      },
    };
  }

  /** Observers consume diagnostics synchronously. Listener failures cannot alter admission. */
  subscribe(listener: (record: RuntimeRecord) => void): () => void {
    if (this.listeners.size >= 16) throw new RangeError('Too many inference record listeners');
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  requestMeasurements(session?: number) {
    return this.measurements.snapshot(session);
  }

  private active(): ActiveTask[] {
    return [...this.queue, ...[...this.attempts.values()].map(({ work }) => work)].filter((work) => !work.outcome);
  }

  private quarantinedSlots(): number {
    return [...this.attempts.values()].filter(({ work }) => work.quarantined).length;
  }

  private quarantine(attempt: Attempt, reason: string): void {
    const { work } = attempt;
    if (this.attempts.get(work.task.id) !== attempt || work.quarantined) return;
    work.quarantined = true;
    attempt.stopWatchdog?.();
    this.record('quarantined', reason, work);
    this.finish(work, 'failed', reason);
    if (this.quarantinedSlots() >= this.slots) {
      for (const pending of [...this.queue]) this.finish(pending, 'rejected', 'All endpoint slots quarantined');
    }
  }

  private retire(reason: string, channel?: OutputChannel, outcome: Outcome = 'invalidated'): void {
    const requestedAt = this.clock.now();
    this.output.retire(channel);
    for (const work of this.active()) {
      if (channel === undefined || work.task.channel === channel) this.finish(work, outcome, reason, requestedAt);
    }
  }

  private finish(work: ActiveTask, outcome: Outcome, reason: string, requestedAt = this.clock.now()): void {
    if (work.outcome) return;
    work.outcome = outcome;
    work.clearDeadline();
    const index = this.queue.indexOf(work);
    if (index >= 0) this.queue.splice(index, 1);
    const attempt = this.attempts.get(work.task.id);
    if (attempt) work.stopRequestedAtMs = requestedAt;
    const text = this.output.finish(work.task, outcome === 'completed');
    if (attempt) work.stoppedAtMs = this.clock.now();
    if (text && work.task.channel === 'response' && work.task.event.source === 'user') {
      this.conversation = [
        ...this.conversation.slice(-4),
        Object.freeze({ role: 'user', content: work.task.event.label }),
        Object.freeze({ role: 'assistant', content: text.slice(0, 700) }),
      ];
    }
    this.record('end', reason, work, undefined, outcome);
    for (const dependent of [...this.queue]) {
      if (dependent.waitingFor !== work.task.id) continue;
      if (outcome === 'completed') dependent.waitingFor = undefined;
      else this.finish(dependent, 'invalidated', 'Dependency did not complete');
    }
    if (attempt && !work.quarantined) {
      attempt.stopWatchdog = this.clock.after(this.limits.terminalGraceMs ?? 45_000, () =>
        this.batch(() => this.quarantine(attempt, 'Reliable upstream terminal not received')));
    }
    attempt?.controller.abort();
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
    if (work.isStillRelevant && !work.isStillRelevant()) {
      this.finish(work, 'invalidated', 'Event is no longer relevant at dispatch');
      return;
    }
    const exposure = this.reservedTokens + this.settledTokens + this.provisionalTokens;
    if (this.reservationOverrun || task.tokenReservation > this.limits.totalTokens - exposure) {
      this.finish(work, 'rejected', this.reservationOverrun ? 'Provider exceeded the token reservation'
        : 'Cumulative token budget exhausted');
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
    this.reservedTokens += task.tokenReservation;
    // Charge the local dispatch once. A provider can report zero usage without refunding transport.
    transfer.commit(now);
    this.sentBytes += task.context.encodedBytes;
    this.record('start', this.policy === 'fifo' ? 'Oldest ready task' : 'Priority, then earliest deadline', work);
    try {
      this.provider.start(task, attempt.controller.signal, {
        partial: (chunk) => this.partial(attempt, chunk),
        terminal: (receipt) => this.batch(() => this.terminal(attempt, receipt)),
        requested: (requestId) => {
          if (this.attempts.get(task.id) !== attempt || work.requestId !== undefined) return;
          work.requestId = requestId.slice(0, 128);
          this.record('request', 'Started gateway request', work);
        },
        dispatched: (requestId) => {
          if (this.attempts.get(task.id) !== attempt || work.upstreamDispatched) return;
          work.requestId ??= requestId.slice(0, 128);
          work.upstreamDispatched = true;
          this.record('dispatch', 'Gateway reports upstream dispatch', work);
        },
        unconfirmed: (reason) => this.batch(() => this.quarantine(attempt, reason.slice(0, 200))),
      });
    } catch {
      this.quarantine(attempt, 'Dispatch threw without reliable terminal evidence');
    }
  }

  private partial(attempt: Attempt, chunk: PartialOutput): void {
    const { work } = attempt;
    const { task } = work;
    const now = this.clock.now();
    const current = this.attempts.get(task.id) === attempt;
    if (current && work.firstTextAtMs === undefined && chunk.index === attempt.nextIndex && chunk.text) {
      work.firstTextAtMs = now;
      work.providerRequestId = chunk.providerRequestId?.slice(0, 128);
      this.record('first-text', 'First text received', work, undefined, undefined, { upstreamMs: chunk.upstreamFirstTextMs });
    }
    const active = current && !work.outcome;
    const decision = this.output.partial(task, chunk, attempt.nextIndex, active, this.session, this.interaction, now);
    if (chunk.index === attempt.nextIndex) attempt.nextIndex += 1;
    if (decision === 'authorized') {
      const firstValidOutput = work.firstOutputAtMs === undefined;
      work.firstOutputAtMs ??= now;
      this.record('output', 'Authorized partial', work, undefined, undefined, { firstValidOutput });
    } else {
      const reason = decision === 'stale' ? 'Stale task, writer or deadline'
        : decision === 'full' ? 'Visible output cap reached' : 'Invalid or out-of-order partial';
      this.record('blocked', reason, work, undefined, undefined, { staleOutput: decision === 'stale' });
    }
  }

  private terminal(attempt: Attempt, receipt: ProviderTerminal): void {
    const { work } = attempt;
    const { task } = work;
    if (this.attempts.get(task.id) !== attempt) return;
    if (receipt.status !== 'completed' && receipt.status !== 'failed' && receipt.status !== 'cancelled') return;

    this.attempts.delete(task.id);
    attempt.stopWatchdog?.();
    this.reservedTokens -= task.tokenReservation;
    const { tokens } = receipt;
    const known = validTokenCount(tokens);
    const usage = receipt.usage && validTokenCount(receipt.usage.inputTokens)
      && validTokenCount(receipt.usage.outputTokens)
      && receipt.usage.inputTokens + receipt.usage.outputTokens === tokens ? receipt.usage : undefined;
    if (known) {
      this.settledTokens += tokens;
      this.settledInputTokens += usage?.inputTokens ?? 0;
      this.settledOutputTokens += usage?.outputTokens ?? 0;
      if (tokens > task.tokenReservation || (usage && (usage.outputTokens > task.tokenLimit
        || (this.limits.inputTokensPerTask !== undefined && usage.inputTokens > this.limits.inputTokensPerTask)))) {
        this.reservationOverrun = true;
      }
    } else {
      this.provisionalTokens += task.tokenReservation;
      this.unknownUsageCount += 1;
    }
    this.record('upstream', receipt.status + (known ? ' · ' + tokens + ' tokens' : ' · usage unknown'), work,
      undefined, undefined, {
        usage, usageUnknown: !known, upstreamMs: receipt.upstreamElapsedMs, providerRequestId: receipt.providerRequestId,
      });
    if (this.clock.now() >= task.deadlineMs) this.finish(work, 'expired', 'Terminal arrived at or after deadline');
    else this.finish(work, receipt.status, receipt.reason?.slice(0, 200) ?? 'Upstream ' + receipt.status);
  }

  private record(
    kind: RuntimeRecord['kind'], reason: string, work?: ActiveTask, event?: StreamEvent, outcome?: Outcome,
    details?: Pick<RuntimeRecord, 'upstreamMs' | 'usage' | 'usageUnknown' | 'providerRequestId' | 'staleOutput' | 'firstValidOutput'>,
  ): void {
    const row = { ...details, atMs: this.clock.now(), kind, reason, task: work && view(work), event, outcome };
    this.journal.push(row);
    this.measurements.record(row);
    for (const listener of this.listeners) {
      try { listener(row); } catch { /* Diagnostics must not interrupt the lifecycle. */ }
    }
  }
}
