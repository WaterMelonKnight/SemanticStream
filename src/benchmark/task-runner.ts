import { ActiveRetrievalService } from '../core/active-retrieval';
import { BudgetController } from '../core/budget';
import { ContextBuffer } from '../core/context-buffer';
import type { PixelSample, SamplingPolicy } from '../core/sampling';
import { SAMPLE_HEIGHT, SAMPLE_WIDTH } from '../core/sample';
import { Sampler } from '../core/sampler';
import type { StreamFrame } from '../core/stream';
import { DecisionEngine } from '../decision/engine';
import { DecisionFeatureExtractor } from '../decision/features';
import { RuleBasedDecisionProvider } from '../decision/rule-provider';
import type { DecisionAction, DecisionState, RecentDecision, TaskDefinition } from '../decision/types';
import {
  BENCHMARK_FRAME_LIMIT,
  BENCHMARK_BUDGET_WINDOW_MS,
  BENCHMARK_TIMING,
  BENCHMARK_DEFAULT_LOCAL,
  countBudgetViolations,
  evaluateScene,
} from './runner';
import {
  PHASE2_BUFFER_MAX_AGE_MS,
  PHASE2_BUFFER_MAX_BYTES,
  PHASE2_BUFFER_MAX_FRAMES,
  PHASE2_RETRIEVAL_MAX_BYTES,
  PHASE2_RETRIEVAL_MAX_FRAMES,
  PHASE2_SAMPLE_BYTES,
  PHASE2_TOTAL_MAX_BYTES,
  PHASE2_TOTAL_MAX_FRAMES,
  runPhase2StrategyOnScene,
} from './retrieval-runner';
import { getTaskScenes, getTaskForScene } from './task-fixtures';
import type { TaskAggregate, TaskConfig, TaskReport, TaskSceneResult, TaskSceneSummary, TaskSuiteResult } from './task-types';
import { emptyActionCounts, taskConfigFor, taskResultFromPhase2 } from './task-types';
import { getScenes } from './fixtures';
import type { BenchmarkScene } from './types';

export const TASK_DECISION_INTERVAL_MS = 100;
export const TASK_STRATEGIES = [
  { id: 'fixed', label: 'A · Fixed 4 fps', baseline: true },
  { id: 'local', label: 'B · Adaptive local', baseline: true },
  { id: 'local-retrieval', label: 'C · Local + retrieval', baseline: true },
  { id: 'task-aware', label: 'D · Task-aware Rule Decision', baseline: false },
] as const;

interface Delivery {
  readonly sequence: number;
  readonly timestampMs: number;
  readonly bytes: number;
}

const FULL_FRAME = { x: 0, y: 0, width: SAMPLE_WIDTH, height: SAMPLE_HEIGHT };

class GatePolicy implements SamplingPolicy<PixelSample> {
  allow = false;
  wantsFrame(): boolean {
    return this.allow;
  }
}

function intersects(
  region: { x: number; y: number; width: number; height: number },
  roi: { x: number; y: number; width: number; height: number },
): boolean {
  return region.x < roi.x + roi.width
    && region.x + region.width > roi.x
    && region.y < roi.y + roi.height
    && region.y + region.height > roi.y;
}

function hashString(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function mean(values: readonly number[]): number {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

function percentile(values: readonly number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

function countResourceViolations(
  events: readonly { timestampMs: number; bytes: number }[],
  maxFrames: number,
  maxBytes: number,
  windowMs: number,
): number {
  const recent: Array<{ timestampMs: number; bytes: number }> = [];
  let violations = 0;
  for (const event of [...events].sort((left, right) => left.timestampMs - right.timestampMs)) {
    while (recent.length && event.timestampMs >= recent[0].timestampMs + windowMs) recent.shift();
    const bytes = recent.reduce((total, entry) => total + entry.bytes, 0);
    if (recent.length + 1 > maxFrames || bytes + event.bytes > maxBytes) violations += 1;
    recent.push({ timestampMs: event.timestampMs, bytes: event.bytes });
  }
  return violations;
}

function taskConfig(task: TaskDefinition): TaskConfig {
  return taskConfigFor(task);
}

function budgetState(service: ActiveRetrievalService, timestampMs: number): DecisionState['budget'] {
  const snapshot = service.admission.snapshot(timestampMs);
  return {
    realtimeRemainingFrames: Math.max(0, snapshot.realtime.maxFrames - snapshot.realtime.usedFrames),
    realtimeRemainingBytes: Math.max(0, snapshot.realtime.maxBytes - snapshot.realtime.usedBytes),
    retrievalRemainingFrames: Math.max(0, snapshot.retrieval.maxFrames - snapshot.retrieval.usedFrames),
    retrievalRemainingBytes: Math.max(0, snapshot.retrieval.maxBytes - snapshot.retrieval.usedBytes),
    totalRemainingFrames: Math.max(0, snapshot.total.maxFrames - snapshot.total.usedFrames),
    totalRemainingBytes: Math.max(0, snapshot.total.maxBytes - snapshot.total.usedBytes),
  };
}

function cacheState(buffer: ContextBuffer): DecisionState['cache'] {
  const stats = buffer.stats();
  return {
    availableRange: stats.oldestTimestampMs === null
      ? null
      : { startMs: stats.oldestTimestampMs, endMs: stats.latestTimestampMs ?? stats.oldestTimestampMs },
    capturedRange: stats.firstCapturedTimestampMs === null
      ? null
      : { startMs: stats.firstCapturedTimestampMs, endMs: stats.lastCapturedTimestampMs ?? stats.firstCapturedTimestampMs },
    frameCount: stats.frameCount,
    byteCount: stats.byteCount,
  };
}

export async function runTaskAwareScene(scene: BenchmarkScene): Promise<TaskSceneResult> {
  const task = getTaskForScene(scene.id);
  const sessionId = `phase3:${scene.id}:task-aware`;
  const buffer = new ContextBuffer({
    sessionId,
    maxAgeMs: PHASE2_BUFFER_MAX_AGE_MS,
    maxFrames: PHASE2_BUFFER_MAX_FRAMES,
    maxBytes: PHASE2_BUFFER_MAX_BYTES,
  });
  const replayClock = { now: 0 };
  const service = new ActiveRetrievalService(buffer, {
    sessionId,
    realtime: { windowMs: 5_000, maxFrames: BENCHMARK_FRAME_LIMIT, maxBytes: 1_000_000 },
    retrieval: { windowMs: 5_000, maxFrames: PHASE2_RETRIEVAL_MAX_FRAMES, maxBytes: PHASE2_RETRIEVAL_MAX_BYTES },
    total: { windowMs: 5_000, maxFrames: PHASE2_TOTAL_MAX_FRAMES, maxBytes: PHASE2_TOTAL_MAX_BYTES },
    logCapacity: 200,
  }, () => replayClock.now);
  const gate = new GatePolicy();
  const sampler = new Sampler<null, PixelSample>(
    gate,
    new BudgetController(BENCHMARK_BUDGET_WINDOW_MS, BENCHMARK_FRAME_LIMIT),
    BENCHMARK_TIMING,
    { accept: () => true },
    undefined,
    service.admission,
    PHASE2_SAMPLE_BYTES,
  );
  const provider = new RuleBasedDecisionProvider({
    globalThreshold: 1.5,
    localThreshold: BENCHMARK_DEFAULT_LOCAL.threshold,
    roiThreshold: BENCHMARK_DEFAULT_LOCAL.threshold,
    repeatSuppressionCount: 3,
    lowRealtimeFrames: 2,
  });
  const engine = new DecisionEngine(provider, provider, { timeoutMs: 50 });
  const extractor = new DecisionFeatureExtractor({
    sampleWidth: SAMPLE_WIDTH,
    sampleHeight: SAMPLE_HEIGHT,
    blockWidth: BENCHMARK_DEFAULT_LOCAL.blockWidth,
    blockHeight: BENCHMARK_DEFAULT_LOCAL.blockHeight,
    blockThreshold: BENCHMARK_DEFAULT_LOCAL.threshold,
    minChangedBlocks: BENCHMARK_DEFAULT_LOCAL.minChangedBlocks,
  });
  const realtimeDeliveries: Delivery[] = [];
  const retrievalDeliveries: Delivery[] = [];
  const decisionLatencies: number[] = [];
  const retrievalLatencies: number[] = [];
  const actions = emptyActionCounts();
  const recentDecisions: RecentDecision[] = [];
  let realtimeBytes = 0;
  let retrievalBytes = 0;
  let peakCacheBytes = 0;
  let peakCacheFrames = 0;
  let lastAccepted: PixelSample | null = null;
  let lastDecisionAt = -Infinity;
  let repeatedChangeCount = 0;
  let repeatedRoiChangeCount = 0;
  let budgetDeniedCount = 0;
  let decisionRequests = 0;
  let decisionFallbacks = 0;
  const decisionDigestParts: string[] = [];

  for (const replayFrame of scene.frames) {
    replayClock.now = replayFrame.timestampMs;
    buffer.offer({
      sequence: replayFrame.sequence,
      timestampMs: replayFrame.timestampMs,
      mediaTimeMs: replayFrame.timestampMs,
      width: SAMPLE_WIDTH,
      height: SAMPLE_HEIGHT,
      pixels: replayFrame.sample,
      phase: scene.id,
    });
    const stats = buffer.stats();
    if (stats.byteCount > peakCacheBytes) peakCacheBytes = stats.byteCount;
    if (stats.frameCount > peakCacheFrames) peakCacheFrames = stats.frameCount;

    const baseline = lastAccepted ?? replayFrame.sample;
    const features = extractor.analyze(baseline, replayFrame.sample, task.roi);
    if (features.localPercent >= BENCHMARK_DEFAULT_LOCAL.threshold) repeatedChangeCount += 1;
    else repeatedChangeCount = 0;
    if (features.roiPercent !== null && features.roiPercent >= BENCHMARK_DEFAULT_LOCAL.threshold) repeatedRoiChangeCount += 1;
    else repeatedRoiChangeCount = 0;

    if (replayFrame.timestampMs - lastDecisionAt >= TASK_DECISION_INTERVAL_MS || lastDecisionAt === -Infinity) {
      lastDecisionAt = replayFrame.timestampMs;
      const state: DecisionState = {
        sessionId,
        timestampMs: replayFrame.timestampMs,
        task,
        change: {
          globalPercent: features.globalPercent,
          localPercent: features.localPercent,
          changedBlocks: features.changedBlocks,
          totalBlocks: features.totalBlocks,
        },
        roi: task.roi === null || features.roiPercent === null
          ? null
          : { region: task.roi, changePercent: features.roiPercent },
        recent: {
          repeatedChangeCount,
          repeatedRoiChangeCount,
          budgetDeniedCount,
          recentDecisions: [...recentDecisions],
        },
        budget: budgetState(service, replayFrame.timestampMs),
        cache: cacheState(buffer),
      };
      const startedAt = performance.now();
      const decision = await engine.decide(state);
      decisionLatencies.push(performance.now() - startedAt);
      decisionRequests += 1;
      if (decision.degraded) decisionFallbacks += 1;
      actions[decision.action] += 1;
      recentDecisions.push({ timestampMs: replayFrame.timestampMs, action: decision.action, reason: decision.reason });
      if (recentDecisions.length > 20) recentDecisions.shift();
      decisionDigestParts.push(`${replayFrame.timestampMs}:${decision.action}`);
      gate.allow = decision.action === 'SEND_FRAME' || decision.action === 'SEND_PREVIEW';

      if (decision.action === 'REQUEST_HISTORY' || decision.action === 'ESCALATE') {
        const requestStarted = performance.now();
        const target = Math.max(0, replayFrame.timestampMs - 250);
        const response = service.getFrameAtTimestamp(sessionId, target, 150);
        retrievalLatencies.push(performance.now() - requestStarted);
        if (response.status === 'available' && response.frame) {
          retrievalDeliveries.push({
            sequence: response.frame.sequence,
            timestampMs: response.frame.timestampMs,
            bytes: response.bytes,
          });
          retrievalBytes += response.bytes;
        }
      } else if (decision.action === 'REQUEST_REGION') {
        const requestStarted = performance.now();
        const response = service.getRegion(sessionId, { timestampMs: replayFrame.timestampMs }, task.roi ?? FULL_FRAME);
        retrievalLatencies.push(performance.now() - requestStarted);
        if (response.status === 'available' && response.sourceFrame) {
          retrievalDeliveries.push({
            sequence: response.sourceFrame.sequence,
            timestampMs: response.sourceFrame.timestampMs,
            bytes: response.bytes,
          });
          retrievalBytes += response.bytes;
        }
      }
    }

    const frame: StreamFrame<null> = {
      sequence: replayFrame.sequence,
      timestampMs: replayFrame.timestampMs,
      payload: null,
    };
    const decision = sampler.process(frame, replayFrame.sample, 0);
    if (decision === 'sent') {
      realtimeDeliveries.push({ sequence: replayFrame.sequence, timestampMs: replayFrame.timestampMs, bytes: PHASE2_SAMPLE_BYTES });
      realtimeBytes += PHASE2_SAMPLE_BYTES;
      lastAccepted = replayFrame.sample;
    } else if (decision === 'budget') {
      budgetDeniedCount += 1;
    }
    gate.allow = false;
  }

  const realtimeEvaluation = evaluateScene(scene, realtimeDeliveries, []);
  const combinedEvaluation = evaluateScene(scene, [...realtimeDeliveries, ...retrievalDeliveries], []);
  const observable = scene.events.filter((event) =>
    scene.frames.some((frame) => frame.timestampMs >= event.startMs && frame.timestampMs < event.endMs));
  const roiEvents = task.roi ? observable.filter((event) => intersects(event.region, task.roi!)) : [];
  const missedBefore = new Set(realtimeEvaluation.missedEventIds);
  const missedAfter = new Set(combinedEvaluation.missedEventIds);
  const capturedBefore = observable.filter((event) => !missedBefore.has(event.id));
  const capturedAfter = observable.filter((event) => !missedAfter.has(event.id));
  const roiCapturedBefore = roiEvents.filter((event) => !missedBefore.has(event.id));
  const roiCapturedAfter = roiEvents.filter((event) => !missedAfter.has(event.id));
  const realtimeEvents = realtimeDeliveries.map((delivery) => ({ timestampMs: delivery.timestampMs, bytes: delivery.bytes }));
  const retrievalEvents = retrievalDeliveries.map((delivery) => ({ timestampMs: delivery.timestampMs, bytes: delivery.bytes }));
  const serviceStats = service.stats();
  const bufferStats = buffer.stats();
  const result: TaskSceneResult = {
    suite: scene.suite,
    sceneId: scene.id,
    sceneDescription: scene.description,
    strategy: 'task-aware',
    strategyLabel: 'D · Task-aware Rule Decision',
    task: taskConfig(task),
    inputs: scene.frames.length,
    observableEvents: observable.length,
    roiObservableEvents: roiEvents.length,
    realtimeSent: realtimeDeliveries.length,
    retrievalFrames: retrievalDeliveries.length,
    retrievalBytes,
    totalSent: realtimeDeliveries.length + retrievalDeliveries.length,
    totalBytes: realtimeBytes + retrievalBytes,
    realtimeCapturedEvents: capturedBefore.length,
    realtimeRecall: observable.length ? capturedBefore.length / observable.length : 0,
    postCapturedEvents: capturedAfter.length,
    postRetrievalRecall: observable.length ? capturedAfter.length / observable.length : 0,
    roiRealtimeCapturedEvents: roiCapturedBefore.length,
    roiRealtimeRecall: roiEvents.length ? roiCapturedBefore.length / roiEvents.length : 0,
    roiPostCapturedEvents: roiCapturedAfter.length,
    roiPostRetrievalRecall: roiEvents.length ? roiCapturedAfter.length / roiEvents.length : 0,
    missedBefore: realtimeEvaluation.missedEvents,
    missedAfter: combinedEvaluation.missedEvents,
    roiMissedBefore: roiEvents.length - roiCapturedBefore.length,
    roiMissedAfter: roiEvents.length - roiCapturedAfter.length,
    realtimeFirstCaptureLatencyMs: realtimeEvaluation.meanFirstCaptureLatencyMs,
    postFirstCaptureLatencyMs: combinedEvaluation.meanFirstCaptureLatencyMs,
    retrievalRequests: serviceStats.requests,
    retrievalDenied: serviceStats.budgetDenied,
    retrievalLatencyMeanMs: retrievalLatencies.length ? mean(retrievalLatencies) : null,
    peakCacheBytes,
    peakCacheFrames,
    evictions: bufferStats.evictionCount,
    realtimeBudgetViolations: countBudgetViolations(realtimeDeliveries.map((delivery) => delivery.timestampMs), BENCHMARK_FRAME_LIMIT, BENCHMARK_BUDGET_WINDOW_MS),
    retrievalBudgetViolations: countResourceViolations(retrievalEvents, PHASE2_RETRIEVAL_MAX_FRAMES, PHASE2_RETRIEVAL_MAX_BYTES, 5_000),
    totalBudgetViolations: countResourceViolations([...realtimeEvents, ...retrievalEvents], PHASE2_TOTAL_MAX_FRAMES, PHASE2_TOTAL_MAX_BYTES, 5_000),
    decisionRequests,
    decisionFallbacks,
    decisionLatencyMeanMs: decisionLatencies.length ? mean(decisionLatencies) : null,
    decisionLatencyP95Ms: decisionLatencies.length ? percentile(decisionLatencies, 0.95) : null,
    actions,
    missedBeforeIds: realtimeEvaluation.missedEventIds,
    missedAfterIds: combinedEvaluation.missedEventIds,
    decisionDigest: hashString(decisionDigestParts.join('|') + '|' + realtimeDeliveries.map((delivery) => delivery.sequence).join(',')),
  };
  service.dispose();
  return result;
}

export function aggregateTaskResults(results: readonly TaskSceneResult[], strategy: TaskSceneResult['strategy']): TaskAggregate {
  const selected = results.filter((result) => result.strategy === strategy);
  const sum = (key: keyof TaskSceneResult): number =>
    selected.reduce((total, result) => total + (typeof result[key] === 'number' ? result[key] as number : 0), 0);
  const observable = sum('observableEvents');
  const roiObservable = sum('roiObservableEvents');
  const realtimeCaptured = sum('realtimeCapturedEvents');
  const postCaptured = sum('postCapturedEvents');
  const roiRealtimeCaptured = sum('roiRealtimeCapturedEvents');
  const roiPostCaptured = sum('roiPostCapturedEvents');
  const decisionRequests = sum('decisionRequests');
  const decisionLatencyTotal = selected.reduce(
    (total, result) => total + (result.decisionLatencyMeanMs ?? 0) * result.decisionRequests,
    0,
  );
  const retrievalRequests = sum('retrievalRequests');
  const retrievalLatencyTotal = selected.reduce(
    (total, result) => total + (result.retrievalLatencyMeanMs ?? 0) * result.retrievalRequests,
    0,
  );
  const info = TASK_STRATEGIES.find((entry) => entry.id === strategy);
  const actions = emptyActionCounts();
  for (const result of selected) {
    for (const action of Object.keys(actions) as DecisionAction[]) actions[action] += result.actions[action];
  }
  return {
    strategy,
    strategyLabel: info?.label ?? strategy,
    scenes: selected.length,
    inputs: sum('inputs'),
    observableEvents: observable,
    roiObservableEvents: roiObservable,
    realtimeSent: sum('realtimeSent'),
    retrievalFrames: sum('retrievalFrames'),
    retrievalBytes: sum('retrievalBytes'),
    totalSent: sum('totalSent'),
    totalBytes: sum('totalBytes'),
    realtimeCapturedEvents: realtimeCaptured,
    realtimeRecall: observable ? realtimeCaptured / observable : 0,
    postCapturedEvents: postCaptured,
    postRetrievalRecall: observable ? postCaptured / observable : 0,
    roiRealtimeCapturedEvents: roiRealtimeCaptured,
    roiRealtimeRecall: roiObservable ? roiRealtimeCaptured / roiObservable : 0,
    roiPostCapturedEvents: roiPostCaptured,
    roiPostRetrievalRecall: roiObservable ? roiPostCaptured / roiObservable : 0,
    missedBefore: sum('missedBefore'),
    missedAfter: sum('missedAfter'),
    retrievalRequests,
    retrievalDenied: sum('retrievalDenied'),
    retrievalLatencyMeanMs: retrievalRequests ? retrievalLatencyTotal / retrievalRequests : null,
    peakCacheBytes: Math.max(0, ...selected.map((result) => result.peakCacheBytes)),
    peakCacheFrames: Math.max(0, ...selected.map((result) => result.peakCacheFrames)),
    evictions: sum('evictions'),
    realtimeBudgetViolations: sum('realtimeBudgetViolations'),
    retrievalBudgetViolations: sum('retrievalBudgetViolations'),
    totalBudgetViolations: sum('totalBudgetViolations'),
    decisionRequests,
    decisionFallbacks: sum('decisionFallbacks'),
    decisionLatencyMeanMs: decisionRequests ? decisionLatencyTotal / decisionRequests : null,
    actions,
  };
}

function sceneSummary(scene: BenchmarkScene): TaskSceneSummary {
  const task = getTaskForScene(scene.id);
  return {
    id: scene.id,
    suite: scene.suite,
    description: scene.description,
    task: taskConfig(task),
    frames: scene.frames.length,
    events: scene.events.length,
  };
}

export async function runTaskBenchmark(): Promise<TaskReport> {
  const scenes = [...getScenes('evaluation'), ...getTaskScenes()];
  const results: TaskSceneResult[] = [];
  for (const scene of scenes) {
    const task = getTaskForScene(scene.id);
    const config = taskConfig(task);
    results.push(taskResultFromPhase2(scene, config, runPhase2StrategyOnScene(scene, 'fixed')));
    results.push(taskResultFromPhase2(scene, config, runPhase2StrategyOnScene(scene, 'local')));
    results.push(taskResultFromPhase2(scene, config, runPhase2StrategyOnScene(scene, 'local-retrieval')));
    results.push(await runTaskAwareScene(scene));
  }
  const suite: TaskSuiteResult = {
    scenes: scenes.map(sceneSummary),
    results,
    aggregates: TASK_STRATEGIES.map((strategy) => aggregateTaskResults(results, strategy.id)),
  };
  return {
    schemaVersion: 3,
    phase: '3A',
    configuration: {
      sampleWidth: SAMPLE_WIDTH,
      sampleHeight: SAMPLE_HEIGHT,
      frameRate: 30,
      budgetWindowMs: BENCHMARK_BUDGET_WINDOW_MS,
      realtimeFrameLimit: BENCHMARK_FRAME_LIMIT,
      minimumIntervalMs: BENCHMARK_TIMING.minimumIntervalMs,
      maximumSilenceMs: BENCHMARK_TIMING.maximumSilenceMs,
      localThreshold: BENCHMARK_DEFAULT_LOCAL.threshold,
      localBlockWidth: BENCHMARK_DEFAULT_LOCAL.blockWidth,
      localBlockHeight: BENCHMARK_DEFAULT_LOCAL.blockHeight,
      bufferMaxAgeMs: PHASE2_BUFFER_MAX_AGE_MS,
      bufferMaxFrames: PHASE2_BUFFER_MAX_FRAMES,
      bufferMaxBytes: PHASE2_BUFFER_MAX_BYTES,
      retrievalMaxFrames: PHASE2_RETRIEVAL_MAX_FRAMES,
      retrievalMaxBytes: PHASE2_RETRIEVAL_MAX_BYTES,
      totalMaxFrames: PHASE2_TOTAL_MAX_FRAMES,
      totalMaxBytes: PHASE2_TOTAL_MAX_BYTES,
      decisionIntervalMs: TASK_DECISION_INTERVAL_MS,
      strategies: TASK_STRATEGIES.map((strategy) => ({ ...strategy })),
    },
    suites: { tuning: { scenes: [], results: [], aggregates: [] }, evaluation: suite },
    notes: [
      'Task ROIs are authored task declarations. They are not generated from evaluator event labels; labels are used only after replay to compute ROI recall.',
      'The task-aware strategy uses one heuristic decision per 100 ms and the same Sampler, rolling budget, admission controller, and bounded buffer as the baselines.',
      'Decision scores are rule weights, not calibrated probabilities. The provider cannot alter budgets or bypass admission.',
      'The fallback provider is deterministic and is counted separately when a provider times out or returns an invalid action.',
      'All strategies use the same total frames/bytes budget, retrieval sub-budget, cache bounds, and time constraints.',
      'Recall means a frame was delivered inside a labeled window. It does not measure model understanding or task success.',
      'A frame never captured cannot be recovered. The task-aware strategy cannot override the fixed silence-refresh behavior of the shared Sampler.',
    ],
  };
}
