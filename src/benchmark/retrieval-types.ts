import type { RetrievalLogEntry } from '../core/active-retrieval';
import type { EvidenceTiming } from './evidence';
import type { SceneSuite } from './types';

export const PHASE2_SCHEMA_VERSION = 3;

export type Phase2StrategyId =
  | 'fixed'
  | 'local'
  | 'local-retrieval'
  | 'local-oracle-retrieval';

export interface Phase2Strategy {
  readonly id: Phase2StrategyId;
  readonly label: string;
  /** True only for the label-driven upper-bound experiment. */
  readonly oracle: boolean;
  readonly cue: string;
}

export interface Phase2Configuration {
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
  readonly retrievalWindowMs: number;
  readonly retrievalMaxFrames: number;
  readonly retrievalMaxBytes: number;
  readonly totalMaxFrames: number;
  readonly totalMaxBytes: number;
  readonly cueIntervalMs: number;
  readonly strategies: readonly Phase2Strategy[];
}

export interface Phase2SceneResult {
  readonly suite: SceneSuite;
  readonly sceneId: string;
  readonly sceneDescription: string;
  readonly strategy: Phase2StrategyId;
  readonly strategyLabel: string;
  readonly oracle: boolean;
  readonly inputs: number;
  readonly observableEvents: number;
  readonly unobservableEvents: number;
  readonly realtimeSent: number;
  readonly retrievalFrames: number;
  readonly retrievalBytes: number;
  readonly totalSent: number;
  readonly totalBytes: number;
  readonly realtimeCapturedEvents: number;
  readonly realtimeRecall: number;
  readonly postCapturedEvents: number;
  readonly postRetrievalRecall: number;
  readonly missedBefore: number;
  readonly missedAfter: number;
  readonly realtimeFirstCaptureLatencyMs: number | null;
  readonly postFirstCaptureLatencyMs: number | null;
  readonly evidenceTiming: EvidenceTiming;
  readonly retrievalAvailable: number;
  readonly retrievalRequests: number;
  readonly retrievalDenied: number;
  readonly retrievalLatencyMeanMs: number | null;
  readonly retrievalLatencyP95Ms: number | null;
  readonly peakCacheBytes: number;
  readonly peakCacheFrames: number;
  readonly evictions: number;
  readonly evictionsByAge: number;
  readonly evictionsByFrames: number;
  readonly evictionsByBytes: number;
  readonly realtimeBudgetViolations: number;
  readonly retrievalBudgetViolations: number;
  readonly totalBudgetViolations: number;
  readonly outsideRealtime: number;
  readonly outsideRetrieval: number;
  readonly missedBeforeIds: readonly string[];
  readonly missedAfterIds: readonly string[];
  readonly inputDigest: string;
  readonly decisionDigest: string;
  readonly retrievalLog: readonly RetrievalLogEntry[];
}

export interface Phase2Aggregate {
  readonly strategy: Phase2StrategyId;
  readonly strategyLabel: string;
  readonly oracle: boolean;
  readonly scenes: number;
  readonly inputs: number;
  readonly observableEvents: number;
  readonly unobservableEvents: number;
  readonly realtimeSent: number;
  readonly retrievalFrames: number;
  readonly retrievalBytes: number;
  readonly totalSent: number;
  readonly totalBytes: number;
  readonly realtimeCapturedEvents: number;
  readonly realtimeRecall: number;
  readonly postCapturedEvents: number;
  readonly postRetrievalRecall: number;
  readonly missedBefore: number;
  readonly missedAfter: number;
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
  readonly outsideRealtime: number;
  readonly outsideRetrieval: number;
}

export interface Phase2SceneSummary {
  readonly id: string;
  readonly suite: SceneSuite;
  readonly description: string;
  readonly frames: number;
  readonly events: number;
}

export interface Phase2SuiteResult {
  readonly scenes: readonly Phase2SceneSummary[];
  readonly results: readonly Phase2SceneResult[];
  readonly aggregates: readonly Phase2Aggregate[];
}

export interface Phase2FocusResult {
  readonly sceneId: string;
  readonly strategy: Phase2StrategyId;
  readonly strategyLabel: string;
  readonly realtimeRecall: number;
  readonly postRetrievalRecall: number;
  readonly retrievalFrames: number;
  readonly retrievalBytes: number;
  readonly missedBeforeIds: readonly string[];
  readonly missedAfterIds: readonly string[];
}

export interface Phase2CueCandidate {
  readonly intervalMs: number;
  readonly postRetrievalRecall: number;
  readonly retrievalFrames: number;
  readonly retrievalDenied: number;
}

export interface Phase2CueSelection {
  readonly intervalMs: number;
  readonly rule: string;
  readonly candidates: readonly Phase2CueCandidate[];
}

export interface Phase2Report {
  readonly schemaVersion: number;
  readonly phase: '2-corrected';
  readonly configuration: Phase2Configuration;
  readonly cueSelection: Phase2CueSelection;
  readonly suites: Readonly<Record<SceneSuite, Phase2SuiteResult>>;
  readonly focus: readonly Phase2FocusResult[];
  readonly notes: readonly string[];
}
