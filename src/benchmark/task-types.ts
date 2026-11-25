import type { DecisionAction } from '../decision/types';
import type { Phase2SceneResult } from './retrieval-types';
import { intersection } from './evidence';
import type { EvidenceTiming } from './evidence';
import type { BenchmarkScene, SceneSuite } from './types';

export const PHASE3_SCHEMA_VERSION = 4;

export type TaskStrategyId = 'fixed' | 'local' | 'local-retrieval' | 'task-aware';

export interface TaskStrategy {
  readonly id: TaskStrategyId;
  readonly label: string;
  readonly baseline: boolean;
}

export interface TaskConfig {
  readonly taskId: string;
  readonly category: string;
  readonly priority: string;
  readonly roi: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null;
}

export interface TaskSceneResult {
  readonly suite: SceneSuite;
  readonly sceneId: string;
  readonly sceneDescription: string;
  readonly strategy: TaskStrategyId;
  readonly strategyLabel: string;
  readonly task: TaskConfig;
  readonly inputs: number;
  readonly observableEvents: number;
  readonly roiObservableEvents: number;
  readonly realtimeSent: number;
  readonly retrievalFrames: number;
  readonly retrievalBytes: number;
  readonly totalSent: number;
  readonly totalBytes: number;
  readonly realtimeCapturedEvents: number;
  readonly realtimeRecall: number;
  readonly postCapturedEvents: number;
  readonly postRetrievalRecall: number;
  readonly roiRealtimeCapturedEvents: number;
  readonly roiRealtimeRecall: number;
  readonly roiPostCapturedEvents: number;
  readonly roiPostRetrievalRecall: number;
  readonly missedBefore: number;
  readonly missedAfter: number;
  readonly roiMissedBefore: number;
  readonly roiMissedAfter: number;
  readonly realtimeFirstCaptureLatencyMs: number | null;
  readonly postFirstCaptureLatencyMs: number | null;
  readonly evidenceTiming: EvidenceTiming;
  readonly retrievalAvailable: number;
  readonly retrievalRequests: number;
  readonly retrievalDenied: number;
  readonly retrievalLatencyMeanMs: number | null;
  readonly peakCacheBytes: number;
  readonly peakCacheFrames: number;
  readonly evictions: number;
  readonly realtimeBudgetViolations: number;
  readonly retrievalBudgetViolations: number;
  readonly totalBudgetViolations: number;
  readonly decisionRequests: number;
  readonly decisionFallbacks: number;
  readonly decisionLatencyMeanMs: number | null;
  readonly decisionLatencyP95Ms: number | null;
  readonly actions: Readonly<Record<DecisionAction, number>>;
  readonly missedBeforeIds: readonly string[];
  readonly missedAfterIds: readonly string[];
  readonly decisionDigest: string;
}

export interface TaskAggregate {
  readonly strategy: TaskStrategyId;
  readonly strategyLabel: string;
  readonly scenes: number;
  readonly inputs: number;
  readonly observableEvents: number;
  readonly roiObservableEvents: number;
  readonly realtimeSent: number;
  readonly retrievalFrames: number;
  readonly retrievalBytes: number;
  readonly totalSent: number;
  readonly totalBytes: number;
  readonly realtimeCapturedEvents: number;
  readonly realtimeRecall: number;
  readonly postCapturedEvents: number;
  readonly postRetrievalRecall: number;
  readonly roiRealtimeCapturedEvents: number;
  readonly roiRealtimeRecall: number;
  readonly roiPostCapturedEvents: number;
  readonly roiPostRetrievalRecall: number;
  readonly missedBefore: number;
  readonly missedAfter: number;
  readonly evidenceTiming: EvidenceTiming;
  readonly retrievalAvailable: number;
  readonly retrievalRequests: number;
  readonly retrievalDenied: number;
  readonly retrievalLatencyMeanMs: number | null;
  readonly peakCacheBytes: number;
  readonly peakCacheFrames: number;
  readonly evictions: number;
  readonly realtimeBudgetViolations: number;
  readonly retrievalBudgetViolations: number;
  readonly totalBudgetViolations: number;
  readonly decisionRequests: number;
  readonly decisionFallbacks: number;
  readonly decisionLatencyMeanMs: number | null;
  readonly actions: Readonly<Record<DecisionAction, number>>;
}

export interface TaskSceneSummary {
  readonly id: string;
  readonly suite: SceneSuite;
  readonly description: string;
  readonly task: TaskConfig;
  readonly frames: number;
  readonly events: number;
}

export interface TaskSuiteResult {
  readonly scenes: readonly TaskSceneSummary[];
  readonly results: readonly TaskSceneResult[];
  readonly aggregates: readonly TaskAggregate[];
}

export interface TaskReport {
  readonly schemaVersion: number;
  readonly phase: '3A-corrected';
  readonly configuration: {
    readonly sampleWidth: number;
    readonly sampleHeight: number;
    readonly frameRate: number;
    readonly budgetWindowMs: number;
    readonly realtimeFrameLimit: number;
    readonly minimumIntervalMs: number;
    readonly maximumSilenceMs: number;
    readonly localThreshold: number;
    readonly localBlockWidth: number;
    readonly localBlockHeight: number;
    readonly bufferMaxAgeMs: number;
    readonly bufferMaxFrames: number;
    readonly bufferMaxBytes: number;
    readonly retrievalMaxFrames: number;
    readonly retrievalMaxBytes: number;
    readonly totalMaxFrames: number;
    readonly totalMaxBytes: number;
    readonly decisionIntervalMs: number;
    readonly strategies: readonly TaskStrategy[];
  };
  readonly suites: Readonly<Record<SceneSuite, TaskSuiteResult>>;
  readonly notes: readonly string[];
}

export function taskConfigFor(task: { id: string; category: string; priority: string; roi: TaskConfig['roi'] }): TaskConfig {
  return {
    taskId: task.id,
    category: task.category,
    priority: task.priority,
    roi: task.roi,
  };
}

export function emptyActionCounts(): Record<DecisionAction, number> {
  return {
    SEND_FRAME: 0,
    SEND_PREVIEW: 0,
    DROP: 0,
    WAIT: 0,
    REQUEST_HISTORY: 0,
    REQUEST_REGION: 0,
    ESCALATE: 0,
  };
}

export function taskResultFromPhase2(
  scene: BenchmarkScene,
  task: TaskConfig,
  result: Phase2SceneResult,
): TaskSceneResult {
  const observable = scene.events.filter((event) =>
    scene.frames.some((frame) => frame.timestampMs >= event.startMs && frame.timestampMs < event.endMs));
  const roiEvents = task.roi
    ? observable.filter((event) => intersection(event.region, task.roi!) !== null)
    : [];
  const missedBefore = new Set(result.missedBeforeIds);
  const missedAfter = new Set(result.missedAfterIds);
  const capturedBefore = observable.filter((event) => !missedBefore.has(event.id));
  const capturedAfter = observable.filter((event) => !missedAfter.has(event.id));
  const roiCapturedBefore = roiEvents.filter((event) => !missedBefore.has(event.id));
  const roiCapturedAfter = roiEvents.filter((event) => !missedAfter.has(event.id));
  return {
    suite: result.suite,
    sceneId: result.sceneId,
    sceneDescription: result.sceneDescription,
    strategy: result.strategy === 'fixed' ? 'fixed' : result.strategy === 'local' ? 'local' : 'local-retrieval',
    strategyLabel: result.strategy === 'fixed' ? 'A · Fixed 4 fps' : result.strategy === 'local' ? 'B · Adaptive local' : 'C · Local + retrieval',
    task,
    inputs: result.inputs,
    observableEvents: observable.length,
    roiObservableEvents: roiEvents.length,
    realtimeSent: result.realtimeSent,
    retrievalFrames: result.retrievalFrames,
    retrievalBytes: result.retrievalBytes,
    totalSent: result.totalSent,
    totalBytes: result.totalBytes,
    realtimeCapturedEvents: capturedBefore.length,
    realtimeRecall: observable.length ? capturedBefore.length / observable.length : 0,
    postCapturedEvents: capturedAfter.length,
    postRetrievalRecall: observable.length ? capturedAfter.length / observable.length : 0,
    roiRealtimeCapturedEvents: roiCapturedBefore.length,
    roiRealtimeRecall: roiEvents.length ? roiCapturedBefore.length / roiEvents.length : 0,
    roiPostCapturedEvents: roiCapturedAfter.length,
    roiPostRetrievalRecall: roiEvents.length ? roiCapturedAfter.length / roiEvents.length : 0,
    missedBefore: result.missedBefore,
    missedAfter: result.missedAfter,
    roiMissedBefore: roiEvents.length - roiCapturedBefore.length,
    roiMissedAfter: roiEvents.length - roiCapturedAfter.length,
    realtimeFirstCaptureLatencyMs: result.realtimeFirstCaptureLatencyMs,
    postFirstCaptureLatencyMs: result.postFirstCaptureLatencyMs,
    evidenceTiming: result.evidenceTiming,
    retrievalAvailable: result.retrievalAvailable,
    retrievalRequests: result.retrievalRequests,
    retrievalDenied: result.retrievalDenied,
    retrievalLatencyMeanMs: result.retrievalLatencyMeanMs,
    peakCacheBytes: result.peakCacheBytes,
    peakCacheFrames: result.peakCacheFrames,
    evictions: result.evictions,
    realtimeBudgetViolations: result.realtimeBudgetViolations,
    retrievalBudgetViolations: result.retrievalBudgetViolations,
    totalBudgetViolations: result.totalBudgetViolations,
    decisionRequests: 0,
    decisionFallbacks: 0,
    decisionLatencyMeanMs: null,
    decisionLatencyP95Ms: null,
    actions: emptyActionCounts(),
    missedBeforeIds: result.missedBeforeIds,
    missedAfterIds: result.missedAfterIds,
    decisionDigest: result.decisionDigest,
  };
}
