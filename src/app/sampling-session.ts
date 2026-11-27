import { ActiveRetrievalService } from '../core/active-retrieval';
import { BudgetController } from '../core/budget';
import { ContextBuffer } from '../core/context-buffer';
import type { PixelRegion } from '../core/context-buffer';
import { AdaptiveStrategyPolicy } from '../core/local-change';
import type { AdaptiveStrategy } from '../core/local-change';
import type { FrameDecision, MetricsSnapshot } from '../core/metrics';
import { RollingRate } from '../core/rate';
import { SAMPLE_HEIGHT, SAMPLE_WIDTH } from '../core/sample';
import { Sampler } from '../core/sampler';
import { FixedSamplingPolicy } from '../core/sampling';
import type { PixelSample } from '../core/sampling';
import type { ContextSink, StreamFrame } from '../core/stream';
import { BoundedTimeline } from '../core/timeline';
import { proposesRealtimeDelivery } from '../decision/actions';
import { DecisionScheduler } from '../decision/engine';
import type { DecisionEngine, ScheduledDecision } from '../decision/engine';
import { DecisionFeatureExtractor } from '../decision/features';
import { decisionBudget, decisionCache } from '../decision/snapshot';
import type { RecentDecision, TaskDefinition } from '../decision/types';

const BUDGET_WINDOW_MS = 5_000;
const DELIVERY_TIMING = { minimumIntervalMs: 125, maximumSilenceMs: 1_500 };
export const TIMELINE_CAPACITY = 150;
const RATE_WINDOW_MS = 2_000;
const RETRIEVAL_FRAME_LIMIT = 6;
const DECISION_INTERVAL_MS = 100;

export type SamplingMode = 'adaptive' | 'fixed';

export interface TimelineEntry {
  readonly sequence: number;
  readonly timestampMs: number;
  readonly mediaTimeMs: number | null;
  readonly adaptive: FrameDecision;
  readonly fixed: FrameDecision;
}


interface SessionSettings {
  readonly threshold: number;
  readonly budget: number;
  readonly adaptiveStrategy: AdaptiveStrategy;
  readonly localThreshold: number;
  readonly blockWidth: number;
  readonly blockHeight: number;
  readonly task: TaskDefinition;
}

export interface SessionSnapshot {
  readonly adaptive: MetricsSnapshot;
  readonly fixed: MetricsSnapshot;
  readonly rates: {
    readonly input: number;
    readonly adaptiveSent: number;
    readonly fixedSent: number;
  };
}

interface SessionMetadata {
  readonly mediaTimeMs: number | null;
  readonly phase?: string;
}

/** Owns synchronous sampling, evidence and asynchronous decision applicability for one visual session. */
export class SamplingSession<T> {
  readonly timeline = new BoundedTimeline<TimelineEntry>(TIMELINE_CAPACITY);
  private readonly context: ContextBuffer;
  private readonly retrieval: ActiveRetrievalService;
  private readonly inputRate = new RollingRate(RATE_WINDOW_MS, 600);
  private readonly adaptiveSendRate = new RollingRate(RATE_WINDOW_MS, 200);
  private readonly fixedSendRate = new RollingRate(RATE_WINDOW_MS, 200);
  private readonly adaptivePolicy: AdaptiveStrategyPolicy;
  private readonly fixedBudget: BudgetController;
  private readonly samplers: Record<SamplingMode, Sampler<T, PixelSample>>;
  private readonly scheduler: DecisionScheduler;
  private readonly recent = new BoundedTimeline<RecentDecision>(20);
  private task: TaskDefinition;
  private features: DecisionFeatureExtractor;
  private blockWidth: number;
  private blockHeight: number;
  private localThreshold: number;
  private baseline: PixelSample | null = null;
  private repeatedChangeCount = 0;
  private repeatedRoiChangeCount = 0;
  private budgetDeniedCount = 0;
  private disposed = false;

  constructor(
    private readonly sessionId: string,
    sinks: Readonly<Record<SamplingMode, ContextSink<T>>>,
    settings: SessionSettings,
    engine: DecisionEngine,
    private readonly onDecision: (decision: ScheduledDecision) => void,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.task = structuredClone(settings.task);
    this.blockWidth = settings.blockWidth;
    this.blockHeight = settings.blockHeight;
    this.localThreshold = settings.localThreshold;
    this.features = this.createFeatures();
    this.scheduler = new DecisionScheduler(engine, DECISION_INTERVAL_MS, 2 * DECISION_INTERVAL_MS, now);
    this.context = new ContextBuffer({
      sessionId, maxAgeMs: 3_000, maxFrames: 90, maxBytes: 3_000_000,
    });
    this.retrieval = new ActiveRetrievalService(this.context, {
      sessionId,
      realtime: { windowMs: BUDGET_WINDOW_MS, maxFrames: settings.budget, maxBytes: 1_000_000 },
      retrieval: { windowMs: BUDGET_WINDOW_MS, maxFrames: RETRIEVAL_FRAME_LIMIT, maxBytes: 2_000_000 },
      total: {
        windowMs: BUDGET_WINDOW_MS, maxFrames: settings.budget + RETRIEVAL_FRAME_LIMIT, maxBytes: 4_000_000,
      },
    }, now);
    this.adaptivePolicy = new AdaptiveStrategyPolicy({
      strategy: settings.adaptiveStrategy,
      globalThreshold: settings.threshold,
      taskGate: () => proposesRealtimeDelivery(this.scheduler.applicable(this.now())?.action),
      local: {
        sampleWidth: SAMPLE_WIDTH,
        sampleHeight: SAMPLE_HEIGHT,
        blockWidth: settings.blockWidth,
        blockHeight: settings.blockHeight,
        threshold: settings.localThreshold,
        minChangedBlocks: 1,
      },
    });
    this.fixedBudget = new BudgetController(BUDGET_WINDOW_MS, settings.budget);
    this.samplers = {
      adaptive: new Sampler(
        this.adaptivePolicy, this.retrieval.admission, DELIVERY_TIMING, sinks.adaptive,
        now, SAMPLE_WIDTH * SAMPLE_HEIGHT * 4, now,
      ),
      fixed: new Sampler<T, PixelSample>(new FixedSamplingPolicy(250), this.fixedBudget, DELIVERY_TIMING, sinks.fixed, now, 0, now),
    };
  }

  /** The sample is immutable after calling process. The source payload is consumed synchronously. */
  process(frame: StreamFrame<T>, sample: PixelSample, metadata: SessionMetadata = { mediaTimeMs: null }) {
    if (this.disposed) throw new Error('Cannot process frames in a disposed sampling session.');
    const preparationMs = Math.max(0, this.now() - frame.timestampMs);
    this.context.offer({
      ...metadata,
      sequence: frame.sequence, timestampMs: frame.timestampMs,
      width: SAMPLE_WIDTH, height: SAMPLE_HEIGHT, pixels: sample,
    });
    const adaptive = this.samplers.adaptive.process(frame, sample, preparationMs);
    const fixed = this.samplers.fixed.process(frame, sample, preparationMs);

    this.inputRate.record(frame.timestampMs);
    if (adaptive === 'sent') this.adaptiveSendRate.record(this.samplers.adaptive.lastDeliveredAtMs!);
    if (fixed === 'sent') this.fixedSendRate.record(this.samplers.fixed.lastDeliveredAtMs!);
    this.timeline.push({
      sequence: frame.sequence, timestampMs: frame.timestampMs, mediaTimeMs: metadata.mediaTimeMs, adaptive, fixed,
    });

    return {
      decisions: { adaptive, fixed },
      adaptiveSelection: adaptive === 'sent' ? this.samplers.adaptive.lastSelection : null,
      decision: this.observe(sample, adaptive),
    };
  }

  get adaptiveStrategy(): AdaptiveStrategy {
    return this.adaptivePolicy.activeStrategy;
  }

  setAdaptiveStrategy(strategy: AdaptiveStrategy): void {
    if (strategy === this.adaptiveStrategy) return;
    this.adaptivePolicy.setStrategy(strategy);
    this.invalidateDecisions();
  }

  setTask(task: TaskDefinition): void {
    this.task = structuredClone(task);
    this.invalidateDecisions();
  }

  setThreshold(threshold: number): void {
    this.adaptivePolicy.setGlobalThreshold(threshold);
  }

  setLocalThreshold(threshold: number): void {
    this.adaptivePolicy.setLocalThreshold(threshold);
    this.localThreshold = threshold;
    this.features = this.createFeatures();
    this.invalidateDecisions();
  }

  setBlockSize(blockWidth: number, blockHeight: number): void {
    this.adaptivePolicy.setBlockSize(blockWidth, blockHeight);
    this.blockWidth = blockWidth;
    this.blockHeight = blockHeight;
    this.features = this.createFeatures();
    this.invalidateDecisions();
  }

  setBudget(frameLimit: number): void {
    if (!Number.isSafeInteger(frameLimit + RETRIEVAL_FRAME_LIMIT)) {
      throw new RangeError('Combined frame limit must be a safe integer.');
    }
    this.fixedBudget.setLimit(frameLimit);
    this.retrieval.setRealtimeFrameLimit(frameLimit);
    this.retrieval.setTotalFrameLimit(frameLimit + RETRIEVAL_FRAME_LIMIT);
  }

  invalidateDecisions(): void {
    this.scheduler.invalidate();
    this.recent.clear();
    this.repeatedChangeCount = 0;
    this.repeatedRoiChangeCount = 0;
    this.budgetDeniedCount = 0;
  }

  dispose(): void {
    this.disposed = true;
    this.scheduler.reset();
    this.retrieval.dispose();
    this.recent.clear();
    this.timeline.clear();
  }

  inspectFrame(sessionId: string, sequence: number, capturedAtMs: number) {
    return this.context.inspectFrame(sessionId, sequence, capturedAtMs);
  }

  retrieveLatest(sessionId = this.sessionId) {
    return this.retrieval.getLatestFrame(sessionId);
  }

  retrieveAtOrBefore(timestampMs: number, sessionId = this.sessionId) {
    return this.retrieval.getFrameAtOrBefore(sessionId, timestampMs);
  }

  retrieveFrame(sequence: number) {
    return this.retrieval.getFrameBySequence(this.sessionId, sequence);
  }

  retrieveRegion(sequence: number, region: PixelRegion) {
    return this.retrieval.getRegion(this.sessionId, { sequence }, region);
  }

  evidence() {
    return { buffer: this.context.stats(), retrieval: this.retrieval.stats() };
  }

  snapshot(): SessionSnapshot {
    const nowMs = this.now();
    return {
      adaptive: this.samplers.adaptive.snapshot(),
      fixed: this.samplers.fixed.snapshot(),
      rates: {
        input: this.inputRate.perSecond(nowMs),
        adaptiveSent: this.adaptiveSendRate.perSecond(nowMs),
        fixedSent: this.fixedSendRate.perSecond(nowMs),
      },
    };
  }

  private createFeatures(): DecisionFeatureExtractor {
    return new DecisionFeatureExtractor({
      sampleWidth: SAMPLE_WIDTH,
      sampleHeight: SAMPLE_HEIGHT,
      blockWidth: this.blockWidth,
      blockHeight: this.blockHeight,
      blockThreshold: this.localThreshold,
      minChangedBlocks: 4,
    });
  }

  private async observe(sample: PixelSample, adaptive: FrameDecision): Promise<ScheduledDecision | null> {
    const { roi } = this.task;
    const features = this.features.analyze(this.baseline ?? sample, sample, roi);
    this.repeatedChangeCount = features.localPercent >= this.localThreshold ? this.repeatedChangeCount + 1 : 0;
    this.repeatedRoiChangeCount = features.roiPercent !== null && features.roiPercent >= this.localThreshold
      ? this.repeatedRoiChangeCount + 1 : 0;
    if (adaptive === 'budget') this.budgetDeniedCount += 1;
    if (adaptive === 'sent') {
      this.scheduler.invalidateContext();
      this.baseline = sample;
    }
    const observedAtMs = this.now();
    const decision = await this.scheduler.evaluate({
      sessionId: this.sessionId,
      timestampMs: observedAtMs,
      task: this.task,
      change: {
        globalPercent: features.globalPercent,
        localPercent: features.localPercent,
        changedBlocks: features.changedBlocks,
        totalBlocks: features.totalBlocks,
      },
      roi: roi && features.roiPercent !== null ? { region: roi, changePercent: features.roiPercent } : null,
      recent: {
        repeatedChangeCount: this.repeatedChangeCount,
        repeatedRoiChangeCount: this.repeatedRoiChangeCount,
        budgetDeniedCount: this.budgetDeniedCount,
        recentDecisions: this.recent.toArray(),
      },
      budget: decisionBudget(this.retrieval.admission.snapshot(observedAtMs)),
      cache: decisionCache(this.context.stats()),
    });
    if (!decision || this.scheduler.latest !== decision) return null;
    this.recent.push({ timestampMs: decision.completedAtMs, action: decision.action, reason: decision.reason });
    this.onDecision(decision);
    return decision;
  }
}
