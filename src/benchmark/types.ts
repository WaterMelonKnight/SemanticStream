import type { PixelSample } from '../core/sampling';

export const BENCHMARK_SCHEMA_VERSION = 1;
export const BENCHMARK_FRAME_RATE = 30;
export const BENCHMARK_DURATION_MS = 6_000;

export type SceneSuite = 'tuning' | 'evaluation';

export type EventKind =
  | 'local-text'
  | 'brief'
  | 'low-contrast'
  | 'slow-change'
  | 'pause-hidden';

export interface BlockRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface EventAnnotation {
  readonly id: string;
  readonly kind: EventKind;
  readonly startMs: number;
  readonly endMs: number;
  readonly region: BlockRegion;
  readonly description: string;
  /** Display-only label drawn by the fixture; never read by a sampling policy. */
  readonly text?: string;
}

export interface ReplayFrame {
  readonly sequence: number;
  readonly timestampMs: number;
  readonly sample: PixelSample;
}

export interface BenchmarkScene {
  readonly id: string;
  readonly suite: SceneSuite;
  readonly description: string;
  readonly frames: readonly ReplayFrame[];
  readonly events: readonly EventAnnotation[];
}

export type BenchmarkStrategyId = 'fixed' | 'global' | 'local' | 'hybrid';

export interface LocalTuningConfig {
  readonly threshold: number;
  readonly blockWidth: number;
  readonly blockHeight: number;
  readonly minChangedBlocks: number;
}

export interface BenchmarkConfiguration {
  readonly sampleWidth: number;
  readonly sampleHeight: number;
  readonly frameRate: number;
  readonly budgetWindowMs: number;
  readonly frameLimit: number;
  readonly minimumIntervalMs: number;
  readonly maximumSilenceMs: number;
  readonly globalThreshold: number;
  readonly selectedLocal: LocalTuningConfig;
  readonly strategies: ReadonlyArray<{ readonly id: BenchmarkStrategyId; readonly label: string }>;
}

export interface StrategySceneResult {
  readonly suite: SceneSuite;
  readonly sceneId: string;
  readonly sceneDescription: string;
  readonly strategy: BenchmarkStrategyId;
  readonly strategyLabel: string;
  readonly inputs: number;
  readonly sent: number;
  readonly events: number;
  readonly observableEvents: number;
  readonly capturedEvents: number;
  readonly missedEvents: number;
  readonly unobservableEvents: number;
  readonly recall: number;
  readonly meanFirstCaptureLatencyMs: number | null;
  readonly maxFirstCaptureLatencyMs: number | null;
  readonly sentOutsideEvents: number;
  readonly meanProcessingMs: number;
  readonly p95ProcessingMs: number;
  readonly budgetViolations: number;
  readonly missedEventIds: readonly string[];
  readonly unobservableEventIds: readonly string[];
  readonly inputDigest: string;
  readonly decisionDigest: string;
}

export interface StrategyAggregate {
  readonly strategy: BenchmarkStrategyId;
  readonly strategyLabel: string;
  readonly scenes: number;
  readonly inputs: number;
  readonly sent: number;
  readonly events: number;
  readonly observableEvents: number;
  readonly capturedEvents: number;
  readonly missedEvents: number;
  readonly unobservableEvents: number;
  readonly recall: number;
  readonly meanFirstCaptureLatencyMs: number | null;
  readonly maxFirstCaptureLatencyMs: number | null;
  readonly sentOutsideEvents: number;
  readonly meanProcessingMs: number;
  readonly budgetViolations: number;
}

export interface TuningCandidateResult {
  readonly config: LocalTuningConfig;
  readonly local: StrategyAggregate;
  readonly hybrid: StrategyAggregate;
  readonly score: number;
}

export interface BenchmarkSelection {
  readonly local: LocalTuningConfig;
  readonly rule: string;
  readonly candidates: readonly TuningCandidateResult[];
}

export interface SceneSummary {
  readonly id: string;
  readonly suite: SceneSuite;
  readonly description: string;
  readonly frames: number;
  readonly durationMs: number;
  readonly events: readonly EventAnnotation[];
}

export interface SceneSuiteResult {
  readonly scenes: readonly SceneSummary[];
  readonly results: readonly StrategySceneResult[];
  readonly aggregates: readonly StrategyAggregate[];
}

export interface BenchmarkFailureCase {
  readonly suite: SceneSuite;
  readonly sceneId: string;
  readonly eventId: string;
  readonly eventKind: EventKind;
  readonly strategy: BenchmarkStrategyId;
  readonly reason: 'missed' | 'unobservable';
}

export interface BenchmarkReport {
  readonly schemaVersion: number;
  readonly phase: '1B';
  readonly configuration: BenchmarkConfiguration;
  readonly selection: BenchmarkSelection;
  readonly suites: Readonly<Record<SceneSuite, SceneSuiteResult>>;
  readonly failureCases: readonly BenchmarkFailureCase[];
  readonly notes: readonly string[];
}

