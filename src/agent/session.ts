import { SamplingSession } from '../app/sampling-session';
import { SAMPLE_HEIGHT, SAMPLE_WIDTH } from '../core/sample';
import type { PixelSample } from '../core/sampling';
import type { StreamFrame, StreamSource } from '../core/stream';
import { BoundedTimeline } from '../core/timeline';
import { DecisionEngine } from '../decision/engine';
import { RuleBasedDecisionProvider } from '../decision/rule-provider';
import type { TaskDefinition } from '../decision/types';
import { InferenceScheduler } from '../inference/scheduler';
import type { InferenceOrigin, RuntimeClock, SchedulingPolicy, StreamEvent } from '../inference/types';
import type { CostView } from '../observability/cost';
import { observeInference } from '../observability/inference';
import { TelemetryHub } from '../observability/telemetry';
import type { TelemetrySource } from '../observability/types';
import { LatestFrameQueue } from '../perception/queue';
import type { DetectorModelSpec, ObjectDetectorProvider } from '../perception/provider';
import { DetectionTrigger } from '../perception/scheduler';
import { mapModelBoxToSource } from '../perception/geometry';
import { ObjectTrackingSystem } from '../perception/tracking/system';
import type { ObjectTrackingSystemConfig } from '../perception/tracking/system';
import { normalizedCategory } from '../perception/tracking/tracker';
import type { EvidenceResolution, FrameEvidenceRef, ObjectEvent } from '../perception/tracking/types';
import type { DetectionRequest, ObjectObservation, SourceKind, SourceTransform } from '../perception/types';
import { isImportant, rulePolicy } from './policy';
import type { AgentDecisionProvider, AgentInput, AgentTask, PolicyDecision, TaskStatus } from './policy';
import type { AgentProvider } from './provider';

export interface FrameAdapter<T> {
  sample(frame: T): PixelSample;
  detection(frame: T): { pixels: ArrayBuffer; transform: SourceTransform };
  metadata?(frame: T): { mediaTimeMs: number | null; phase?: string };
}

export interface AgentSessionOptions<T> {
  readonly runtimeInstanceId: string;
  readonly clock: RuntimeClock;
  readonly frames: FrameAdapter<T>;
  readonly provider: AgentProvider;
  readonly policy?: AgentDecisionProvider;
  readonly scheduling?: SchedulingPolicy;
  readonly tracking?: ObjectTrackingSystemConfig;
  readonly visualBudget?: number;
}

interface DetectionWork {
  readonly request: DetectionRequest;
  readonly pixels: ArrayBuffer;
}
type Detector = { adapter: ObjectDetectorProvider; source: TelemetrySource; ready: boolean; queue: LatestFrameQueue<DetectionWork> };

interface DecisionRow extends PolicyDecision {
  readonly id: string;
  readonly sessionId: string;
  readonly label: string;
  readonly consumedAtMs: number;
  readonly producedAtMs: number;
  readonly taskId?: number;
  readonly capturedAtMs?: number;
  readonly event?: ObjectEvent;
}

const EVENT_FRESH_MS = 2_500;
const GAP_FRESH_MS = 5_000;
const QUEUE_COOLDOWN_MS = 1_500;

/** Single owner of source, visual evidence, semantic state, policy and inference scope. */
export class AgentSession<T> {
  readonly telemetry = new TelemetryHub(400, 120, 150);
  readonly state: ObjectTrackingSystem;
  readonly runtimeInstanceId: string;
  private readonly rows = new BoundedTimeline<DecisionRow>(140);
  private eventWatermark = 0;
  private readonly recentlyDispatched = new Map<string, number>();
  private readonly trigger = new DetectionTrigger({ mode: 'adaptive', targetFps: 4, periodicMs: 1_500, changeThreshold: 1 });
  private readonly rules = new RuleBasedDecisionProvider();
  private readonly decisionEngine: DecisionEngine;
  private readonly clock: RuntimeClock;
  private readonly policy: AgentDecisionProvider;
  private readonly runtimes = new WeakMap<AgentProvider, InferenceScheduler>();
  private sampling: SamplingSession<T> | undefined;
  private runtime: InferenceScheduler;
  private binding: AgentProvider;
  private detector: Detector | undefined;
  private source: (StreamSource<T> & { dispose?(): void }) | undefined;
  private sourceKind: SourceKind = 'demo';
  private generation = 0;
  private revision = 0;
  private interaction = 0;
  private eventSerial = 0;
  private requestSerial = 0;
  private taskChangedAt = 0;
  private task: AgentTask = { type: 'monitor' };
  private status: TaskStatus = 'active';
  private gatewayCost?: { view: CostView; atMs: number };
  private captureCount = 0;
  private detectorState: 'off' | 'loading' | 'ready' | 'error' = 'off';

  constructor(private readonly options: AgentSessionOptions<T>) {
    this.clock = options.clock;
    this.runtimeInstanceId = options.runtimeInstanceId;
    this.policy = options.policy ?? rulePolicy;
    this.binding = options.provider;
    this.runtime = this.runtimeFor(this.binding);
    this.decisionEngine = new DecisionEngine(this.rules, this.rules, { now: () => this.clock.now() });
    this.state = new ObjectTrackingSystem(this.sessionId, {
      ...options.tracking, clock: () => this.clock.now(),
      evidenceResolver: { resolve: (lookup) => this.inspectEvidence(lookup, lookup.trackId, lookup.atMs) },
    });
    this.resetSource();
  }

  get sessionId(): string { return this.runtimeInstanceId + ':s' + this.generation; }

  private runtimeFor(binding: AgentProvider): InferenceScheduler {
    const previous = this.runtimes.get(binding);
    if (previous) return previous;
    if (!binding.capabilities.supportsText || !binding.capabilities.supportsStreaming
      || binding.capabilities.readiness !== 'ready' || binding.limits.slots > binding.capabilities.maxConcurrency) {
      throw new Error('Provider capabilities do not support this text session');
    }
    const scheduler = new InferenceScheduler(binding.adapter, this.clock, binding.limits, this.options.scheduling ?? 'context-aware');
    observeInference(scheduler, this.telemetry, binding.source, this.runtimeInstanceId);
    this.runtimes.set(binding, scheduler);
    return scheduler;
  }

  setProvider(binding: AgentProvider): void {
    const next = this.runtimeFor(binding);
    if (next === this.runtime) return;
    this.runtime.newSession();
    this.runtime = next;
    this.binding = binding;
    this.gatewayCost = undefined;
    this.resetSource();
  }

  setGatewayCost(view: CostView | undefined): void {
    this.gatewayCost = view ? { view, atMs: this.clock.now() } : undefined;
    if (!view) return;
    const { atMs } = this.gatewayCost!;
    for (const [name, value] of [
      ['settled_nano_usd', view.settledNanoUsd], ['reserved_nano_usd', view.reservedNanoUsd],
      ['provisional_nano_usd', view.provisionalNanoUsd],
    ] as const) this.telemetry.gauge(atMs, 'cost', name, value, 'nanoUSD', 'real', this.identity());
  }

  async useSource(source: StreamSource<T> & { dispose?(): void }, kind: SourceKind): Promise<void> {
    this.stopSource();
    this.source = source;
    this.sourceKind = kind;
    this.resetSource();
    try {
      await source.start((frame) => { if (this.source === source && this.sampling) this.capture(frame); });
    } catch (error) {
      if (this.source !== source) return;
      this.stopSource();
      this.resetSource();
      throw error;
    }
  }

  /** A video seek keeps the decoder and replaces both runtime and evidence generations. */
  resetSource(): void {
    this.runtime.newSession();
    this.generation += 1;
    this.interaction += 1;
    this.captureCount = 0;
    this.trigger.reset();
    this.state.reset(this.sessionId);
    this.eventWatermark = 0;
    this.recentlyDispatched.clear();
    this.sampling?.dispose();
    this.sampling = new SamplingSession(this.sessionId, { fixed: { accept: () => true }, adaptive: { accept: () => true } }, {
      threshold: 2.5, budget: this.options.visualBudget ?? 20, adaptiveStrategy: 'hybrid',
      localThreshold: 4, blockWidth: 8, blockHeight: 8, task: this.samplingTask(),
    }, this.decisionEngine, () => {}, () => this.clock.now());
  }

  suspend(): void {
    this.stopSource();
    this.disableDetector();
    this.runtime.newSession();
    this.generation += 1;
    this.interaction += 1;
    this.state.reset(this.sessionId);
    this.sampling?.dispose();
    this.sampling = undefined;
    this.gatewayCost = undefined;
    this.telemetry.event(this.clock.now(), 'runtime', 'suspended', this.binding.source, this.identity());
  }

  private stopSource(): void {
    const old = this.source;
    this.source = undefined;
    if (old?.dispose) old.dispose();
    else old?.stop();
  }

  setTask(task: AgentTask): void {
    if (task.type === 'region') {
      const { x, y, width, height } = task.region;
      if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0
        || x + width > 1.00000001 || y + height > 1.00000001) throw new RangeError('ROI must be inside the image');
      this.task = { ...task, category: normalizedCategory(task.category ?? ''), region: { ...task.region } };
    } else if (task.type === 'object') {
      this.task = { ...task, category: normalizedCategory(task.category ?? ''), trackId: task.trackId?.trim().slice(0, 160) };
    } else this.task = { ...task };
    this.state.setRegion(this.task.type === 'region' ? this.task.region : undefined);
    this.sampling?.setTask(this.samplingTask());
    this.setTaskStatus('active');
  }

  setTaskStatus(status: TaskStatus): void {
    this.status = status;
    this.revision += 1;
    this.taskChangedAt = this.clock.now();
    this.recentlyDispatched.clear();
    this.interrupt();
  }

  interrupt(): void {
    this.interaction += 1;
    this.runtime.interrupt();
  }

  async enableDetector(adapter: ObjectDetectorProvider, spec: DetectorModelSpec, source: TelemetrySource = 'real'): Promise<boolean> {
    this.disableDetector();
    const current: Detector = { adapter, source, ready: false, queue: new LatestFrameQueue() };
    this.detector = current;
    this.detectorState = 'loading';
    const stop = this.clock.after(30_000, () => { if (this.detector === current) this.failDetector(); });
    try {
      await adapter.load(spec);
      if (this.detector !== current) return false;
      current.ready = true;
      this.detectorState = 'ready';
      this.trigger.reset();
      return true;
    } catch {
      if (this.detector === current) this.failDetector();
      return false;
    } finally { stop(); }
  }

  disableDetector(): void {
    const old = this.detector;
    this.detector = undefined;
    this.detectorState = 'off';
    old?.queue.clear();
    old?.adapter.dispose();
  }

  private failDetector(): void {
    this.disableDetector();
    this.detectorState = 'error';
    this.telemetry.event(this.clock.now(), 'perception', 'detector_failed', 'unavailable', this.identity());
  }

  private samplingTask(): TaskDefinition {
    const r = this.task.type === 'region' ? this.task.region : undefined;
    const roi = r ? {
      x: Math.floor(r.x * SAMPLE_WIDTH), y: Math.floor(r.y * SAMPLE_HEIGHT),
      width: Math.max(1, Math.floor((r.x + r.width) * SAMPLE_WIDTH) - Math.floor(r.x * SAMPLE_WIDTH)),
      height: Math.max(1, Math.floor((r.y + r.height) * SAMPLE_HEIGHT) - Math.floor(r.y * SAMPLE_HEIGHT)),
    } : null;
    return { id: 'agent-' + this.task.type, label: this.task.type, category: 'motion-monitoring', priority: 'normal', roi };
  }

  private capture(frame: StreamFrame<T>): void {
    this.captureCount += 1;
    const selected = this.sampling!.process(frame, this.options.frames.sample(frame.payload), this.options.frames.metadata?.(frame.payload));
    const detector = this.detector;
    if (selected.decisions.adaptive !== 'sent' || !detector?.ready
      || !this.trigger.shouldSubmit(frame.timestampMs, 100).submit) return;
    try {
      const { pixels, transform } = this.options.frames.detection(frame.payload);
      const request: DetectionRequest = {
        requestId: ++this.requestSerial, sessionId: this.sessionId, frameSequence: frame.sequence,
        capturedAtMs: frame.timestampMs, submittedAtMs: this.clock.now(), width: transform.modelWidth,
        height: transform.modelHeight, transform, sourceKind: this.sourceKind,
      };
      this.trigger.markSubmitted(frame.timestampMs, 100);
      this.telemetry.event(frame.timestampMs, 'runtime', 'captured', detector.source, { ...this.identity(), frameSequence: frame.sequence });
      const busy = detector.queue.inFlight;
      const work = { request, pixels };
      const { dropped } = detector.queue.tryEnqueue(work);
      if (dropped) this.telemetry.counter(this.clock.now(), 'perception', 'frames_coalesced', dropped, detector.source, this.identity());
      if (!busy) void this.detect(detector, work);
    } catch { this.failDetector(); }
  }

  private async detect(detector: Detector, { request, pixels }: DetectionWork): Promise<void> {
    const stop = this.clock.after(10_000, () => { if (this.detector === detector) this.failDetector(); });
    try {
      const batch = await detector.adapter.detect(request, pixels);
      if (this.detector !== detector || request.sessionId !== this.sessionId || batch.sessionId !== request.sessionId
        || batch.requestId !== request.requestId || batch.frameSequence !== request.frameSequence) return;
      const completed = this.clock.now();
      const { transform } = request;
      const detections = batch.detections.map((detection): ObjectObservation => ({
        sessionId: request.sessionId, frameSequence: request.frameSequence,
        capturedAtMs: request.capturedAtMs, submittedAtMs: request.submittedAtMs, completedAtMs: completed,
        detectorId: detector.adapter.id, modelVersion: detector.adapter.version,
        categoryId: detection.categoryId, categoryName: detection.categoryName, score: detection.score,
        box: mapModelBoxToSource(detection.box, transform),
        evidence: {
          sourceKind: request.sourceKind, frameSequence: request.frameSequence, capturedAtMs: request.capturedAtMs,
          frameRef: request.sessionId + ':' + request.frameSequence,
          input: { width: request.width, height: request.height, scale: transform.scale, offsetX: transform.offsetX, offsetY: transform.offsetY },
        },
      })).filter((observation) => observation.box.width > 0 && observation.box.height > 0);
      const identity = { ...this.identity(), frameSequence: request.frameSequence };
      this.telemetry.histogram(completed, 'perception', 'inference_ms', batch.inferenceMs, 'ms', detector.source, identity);
      this.telemetry.event(completed, 'perception', 'detection', detector.source, identity);
      const result = this.state.process({
        sessionId: request.sessionId, frameSequence: request.frameSequence, capturedAtMs: request.capturedAtMs,
        completedAtMs: completed, observedAtMs: completed, frameWidth: transform.sourceWidth, frameHeight: transform.sourceHeight,
        status: 'ok', detections,
      });
      this.telemetry.histogram(this.clock.now(), 'tracking', 'tracking_ms', result.trackingMs, 'ms', detector.source, identity);
      this.telemetry.histogram(this.clock.now(), 'events', 'event_processing_ms', result.eventMs, 'ms', detector.source, identity);
      this.telemetry.event(this.clock.now(), 'tracking', 'batch', detector.source, identity, { status: result.frame.status });
      for (const event of result.events) this.acceptSemanticEvent(event);
    } catch {
      if (this.detector === detector) this.failDetector();
    } finally {
      stop();
      if (this.detector === detector) {
        detector.queue.complete();
        const next = detector.queue.takePending();
        if (next?.request.sessionId === this.sessionId) void this.detect(detector, next);
        else detector.queue.complete();
      }
    }
  }

  acceptSemanticEvent(event: ObjectEvent): void {
    const now = this.clock.now();
    const prefix = this.sessionId + ':e';
    const serial = event.eventId.startsWith(prefix) ? Number(event.eventId.slice(prefix.length)) : NaN;
    if (!this.sampling || event.sessionId !== this.sessionId || event.evidence.sessionId !== this.sessionId
      || !Number.isSafeInteger(serial) || serial <= this.eventWatermark
      || ![event.producedAtMs, event.observedAtMs, event.evidence.capturedAtMs].every(Number.isFinite)
      || event.evidence.capturedAtMs > event.observedAtMs || event.observedAtMs > event.producedAtMs
      || event.producedAtMs > now || event.producedAtMs < this.taskChangedAt) {
      this.telemetry.counter(now, 'events', 'stale_or_duplicate', 1, this.detector?.source ?? 'unavailable', {
        runtimeInstanceId: this.runtimeInstanceId, sessionId: event.sessionId, eventId: event.eventId,
      });
      return;
    }
    this.eventWatermark = serial;
    const current = this.state.getObjectById(event.trackId);
    this.decide({ kind: 'object', event, current }, event.eventType + ' · ' + event.categoryName, event.eventId);
  }

  monitor(critical: boolean): void {
    this.decide({ kind: 'monitor', critical }, critical
      ? 'Synthetic monitor alert: database replica offline' : 'Synthetic monitor: ordinary load change');
  }

  summarize(): void { this.decide({ kind: 'summary' }, 'Summarize current tracked objects and recent events.'); }
  ask(question: string): void {
    if (question.trim()) this.decide({ kind: 'question' }, question.trim().slice(0, 210));
  }

  private decide(input: AgentInput, label: string, id = this.sessionId + ':a' + ++this.eventSerial): void {
    if (!this.sampling) return;
    const now = this.clock.now();
    const event = input.kind === 'object' ? input.event : undefined;
    const producedAtMs = event?.producedAtMs ?? now;
    const observedAtMs = event?.observedAtMs ?? now;
    const oldEvidence = event && (event.eventType.includes('LOST') || event.eventType === 'OBJECT_EXPIRED');
    const fresh = now - producedAtMs <= EVENT_FRESH_MS && now - observedAtMs <= EVENT_FRESH_MS
      && (!event || oldEvidence || now - event.evidence.capturedAtMs <= GAP_FRESH_MS);
    const key = event ? event.trackId + ':' + event.eventType : input.kind;
    const state = this.runtime.snapshot();
    const { budget } = state;
    const cost = this.gatewayCost;
    const gatewayOK = this.binding.capabilities.executionLocation !== 'gateway'
      || Boolean(cost && now - cost.atMs < 12_000 && cost.view.admission.ledgerOpen && cost.view.admission.costSufficient
        && cost.view.admission.requestCapacity && (cost.view.admission.slotCapacity || state.attempts.length > 0));
    const budgetAvailable = gatewayOK && !budget.reservationOverrun
      && budget.tokenLimit - budget.settledTokens - budget.provisionalTokens - budget.reservedTokens
        >= this.binding.limits.tokensPerTask + (this.binding.limits.inputTokensPerTask ?? 0)
      && budget.rolling.frames < budget.rollingLimits.maxFrames && budget.rolling.bytes < budget.rollingLimits.maxBytes
      && budget.quarantinedSlots < state.slots;
    const identity = { ...this.identity(), eventId: id, frameSequence: event?.evidence.frameSequence };
    const source = event ? this.detector?.source ?? 'unavailable' : input.kind === 'monitor' ? 'fixture' : this.binding.source;
    this.telemetry.event(producedAtMs, 'events', 'semantic_event', source, identity,
      { type: event?.eventType ?? input.kind });
    const decision = this.policy.decide({
      input, task: structuredClone(this.task), status: this.status, fresh,
      cooling: now - (this.recentlyDispatched.get(key) ?? -Infinity) < QUEUE_COOLDOWN_MS,
      saturated: state.queued.length >= this.binding.limits.queue,
      budgetAvailable,
    });
    this.telemetry.histogram(this.clock.now(), 'decision', 'consume_ms', this.clock.now() - now, 'ms', source, identity);
    this.telemetry.event(this.clock.now(), 'decision', 'event_policy', source, identity, { action: decision.action });
    let taskId: number | undefined;
    if (decision.action === 'RETRIEVE' && event) {
      const result = this.retrieveEvent(event);
      this.telemetry.event(this.clock.now(), 'context', 'local_review', source, identity, { status: result.status });
      this.telemetry.counter(this.clock.now(), 'decision', 'calls_suppressed', 1, source, identity);
    } else if (fresh && (decision.action === 'RESPOND' || decision.action === 'ESCALATE')) {
      const single = input.kind === 'question' || input.kind === 'summary';
      const priority = single ? 30 : decision.action === 'ESCALATE' ? 20 : 5;
      const origin: InferenceOrigin = {
        ...this.identity(), eventId: id, producedAtMs, sourceGeneration: this.generation,
        taskRevision: this.revision, interactionVersion: this.interaction,
      };
      const streamSource: StreamEvent['source'] = single ? 'user' : input.kind === 'monitor' ? 'scenario' : 'semantic';
      const structuredText = this.textContext(input, now);
      taskId = this.runtime.ingest({ source: streamSource, capturedAtMs: event?.evidence.capturedAtMs ?? now, label,
        reason: decision.reason, origin }, {
        channel: single ? 'response' : 'observation', priority,
        ttlMs: this.binding.deadlineMs, supersede: single, supersedeLowerPriority: !single && isImportant(input),
        dedupeKey: !single && !isImportant(input) ? key : undefined,
        structuredText,
        isStillRelevant: () => this.sessionId === origin.sessionId && this.revision === origin.taskRevision
          && this.interaction === origin.interactionVersion
          && (single || (this.clock.now() - producedAtMs <= EVENT_FRESH_MS
            && (!event || this.state.getObjectById(event.trackId)?.trackingState === event.currentState))),
      });
      this.recentlyDispatched.set(key, now);
      if (this.recentlyDispatched.size > 128) this.recentlyDispatched.delete(this.recentlyDispatched.keys().next().value!);
    } else {
      this.telemetry.counter(this.clock.now(), 'decision', 'calls_suppressed', 1, source, identity);
    }
    this.rows.push({ ...decision, id, label, sessionId: this.sessionId, consumedAtMs: now,
      producedAtMs, capturedAtMs: event?.evidence.capturedAtMs, taskId, event });
  }

  private textContext(input: AgentInput, at: number): string {
    const event = input.kind === 'object' ? input.event : undefined;
    const selected = event ? [input.kind === 'object' ? input.current : undefined] : [...this.state.getTrackedObjects()].sort((a, b) => b.lastObservationAtMs - a.lastObservationAtMs).slice(0, 4);
    const objects = selected.flatMap((track) => track ? [{
      id: track.trackId.slice(-50), category: track.categoryName.slice(0, 30), state: track.trackingState,
      score: +track.confidence.toFixed(2), associationUncertain: track.associationUncertain,
    }] : []);
    const details = event && {
      type: event.eventType, id: event.eventId.slice(-45), detectorScore: +event.confidence.toFixed(2),
      captured: Math.round(event.evidence.capturedAtMs), confirmed: Math.round(event.stateChangedAtMs),
      produced: Math.round(event.producedAtMs), consumed: Math.round(at), uncertain: event.associationUncertain,
      evidence: this.inspectEvidence(event.evidence, event.trackId, at).status,
      history: this.state.getObjectHistory(event.trackId, { fromMs: at - 60_000, toMs: at }).slice(-3)
        .map((point) => [Math.round(point.atMs), point.trackingState]),
    };
    const context = {
      task: this.task.type,
      target: this.task.type === 'object' ? (this.task.trackId || this.task.category)?.slice(-50)
        : this.task.type === 'region' ? [this.task.region.x, this.task.region.y, this.task.region.width, this.task.region.height]
          .map((value) => +value.toFixed(3)) : undefined,
      event: details, objects,
      recent: event ? undefined : this.state.getObjectEvents().slice(-3).map((item) => item.eventType),
      evidenceMode: 'text metadata only; no image sent',
      caveat: 'image coordinates; expiry is not physical removal',
    };
    while (JSON.stringify(context).length > 790 && objects.length > 1) objects.pop();
    while (JSON.stringify(context).length > 790 && details?.history.length) details.history.shift();
    if (JSON.stringify(context).length > 790) return JSON.stringify({ ...context, objects: [] });
    return JSON.stringify(context);
  }

  private inspectEvidence(ref: FrameEvidenceRef, trackId: string, at: number): EvidenceResolution {
    const status = ref.sessionId !== this.sessionId ? 'wrong-session'
      : ref.capturedAtMs > at || ref.frameRef !== ref.sessionId + ':' + ref.frameSequence ? 'unavailable'
        : this.sampling?.inspectFrame(ref.sessionId, ref.frameSequence, ref.capturedAtMs);
    const normalized = status === 'available' || status === 'evicted' || status === 'wrong-session' ? status : 'unavailable';
    return { status: normalized, sessionId: ref.sessionId, trackId, requestedAtMs: at,
      capturedAtMs: ref.capturedAtMs, frameSequence: ref.frameSequence, evidenceRef: ref.frameRef, message: normalized };
  }

  retrieveEvent(event: ObjectEvent) {
    const checked = this.inspectEvidence(event.evidence, event.trackId, Math.min(event.producedAtMs, this.clock.now()));
    if (checked.status !== 'available') return { status: checked.status, frame: null };
    return this.sampling!.retrieveFrame(event.evidence.frameSequence);
  }

  retrieveLatest(sessionId = this.sessionId) {
    return this.sampling?.retrieveLatest(sessionId) ?? { status: sessionId === this.sessionId ? 'unavailable' : 'wrong-session', frame: null };
  }

  retrieveAt(timestampMs: number, sessionId = this.sessionId) {
    if (!Number.isFinite(timestampMs)) return { status: 'unavailable', frame: null };
    return this.sampling?.retrieveAtOrBefore(Math.min(timestampMs, this.clock.now()), sessionId)
      ?? { status: sessionId === this.sessionId ? 'unavailable' : 'wrong-session', frame: null };
  }

  private identity() { return { runtimeInstanceId: this.runtimeInstanceId, sessionId: this.sessionId }; }

  snapshot() {
    return {
      ...this.identity(), sourceGeneration: this.generation, taskRevision: this.revision, interactionVersion: this.interaction,
      task: structuredClone(this.task), status: this.status, detector: this.detectorState,
      provider: this.binding.capabilities, source: this.binding.source, captureCount: this.captureCount,
      objects: this.state.diagnostics(), decisions: this.rows.toArray(), runtime: this.runtime.snapshot(),
      measurements: this.runtime.requestMeasurements(), visual: this.sampling?.snapshot(), evidence: this.sampling?.evidence(),
      cost: this.gatewayCost && this.clock.now() - this.gatewayCost.atMs < 12_000 ? this.gatewayCost.view : undefined,
    };
  }
}
