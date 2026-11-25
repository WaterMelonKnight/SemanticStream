import { BudgetController } from '../core/budget';
import { AdaptiveStrategyPolicy } from '../core/local-change';
import type { LocalChangeConfig } from '../core/local-change';
import { SAMPLE_HEIGHT, SAMPLE_WIDTH } from '../core/sample';
import { AdaptiveSamplingPolicy, FixedSamplingPolicy } from '../core/sampling';
import type { PixelSample, SamplingPolicy } from '../core/sampling';
import { Sampler } from '../core/sampler';
import type { FrameDecision } from '../core/metrics';
import type { StreamFrame } from '../core/stream';
import { getScenes } from './fixtures';
import {
  BENCHMARK_FRAME_RATE,
  BENCHMARK_SCHEMA_VERSION,
} from './types';
import type {
  BenchmarkConfiguration,
  BenchmarkFailureCase,
  BenchmarkReport,
  BenchmarkScene,
  BenchmarkStrategyId,
  LocalTuningConfig as LocalTuning,
  SceneSuite,
  SceneSuiteResult,
  SceneSummary,
  StrategyAggregate,
  StrategySceneResult,
  TuningCandidateResult,
} from './types';

export const BENCHMARK_BUDGET_WINDOW_MS = 5_000;
export const BENCHMARK_FRAME_LIMIT = 20;
export const BENCHMARK_TIMING = { minimumIntervalMs: 125, maximumSilenceMs: 1_500 };
export const BENCHMARK_GLOBAL_THRESHOLD = 1.5;
export const BENCHMARK_DEFAULT_LOCAL: LocalTuning = {
  threshold: 2.5,
  blockWidth: 8,
  blockHeight: 8,
  minChangedBlocks: 1,
};
export const BENCHMARK_STRATEGIES: ReadonlyArray<{ id: BenchmarkStrategyId; label: string }> = [
  { id: 'fixed', label: 'Fixed · 4 fps' },
  { id: 'global', label: 'Adaptive · global RGB' },
  { id: 'local', label: 'Adaptive · local blocks' },
  { id: 'hybrid', label: 'Adaptive · hybrid' },
];

const TUNING_CANDIDATES: readonly LocalTuning[] = [
  { threshold: 1.5, blockWidth: 8, blockHeight: 8, minChangedBlocks: 1 },
  { threshold: 2.5, blockWidth: 8, blockHeight: 8, minChangedBlocks: 1 },
  { threshold: 4, blockWidth: 8, blockHeight: 8, minChangedBlocks: 1 },
  { threshold: 1.5, blockWidth: 12, blockHeight: 12, minChangedBlocks: 1 },
  { threshold: 2.5, blockWidth: 12, blockHeight: 12, minChangedBlocks: 1 },
  { threshold: 4, blockWidth: 12, blockHeight: 12, minChangedBlocks: 1 },
];

interface Delivery {
  readonly sequence: number;
  readonly timestampMs: number;
}

interface SceneEvaluation {
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
}

function toLocalConfig(config: LocalTuning): LocalChangeConfig {
  return {
    sampleWidth: SAMPLE_WIDTH,
    sampleHeight: SAMPLE_HEIGHT,
    blockWidth: config.blockWidth,
    blockHeight: config.blockHeight,
    threshold: config.threshold,
    minChangedBlocks: config.minChangedBlocks,
  };
}

function createPolicy(strategy: BenchmarkStrategyId, local: LocalTuning): SamplingPolicy<PixelSample> {
  const localConfig = toLocalConfig(local);
  switch (strategy) {
    case 'fixed':
      return new FixedSamplingPolicy(250);
    case 'global':
      return new AdaptiveSamplingPolicy(BENCHMARK_GLOBAL_THRESHOLD);
    case 'local':
      return new AdaptiveStrategyPolicy({
        strategy: 'local',
        globalThreshold: BENCHMARK_GLOBAL_THRESHOLD,
        local: localConfig,
      });
    case 'hybrid':
      return new AdaptiveStrategyPolicy({
        strategy: 'hybrid',
        globalThreshold: BENCHMARK_GLOBAL_THRESHOLD,
        local: localConfig,
      });
  }
}

function hashString(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function inputDigest(scene: BenchmarkScene): string {
  return hashString(scene.frames.map((frame) => `${frame.sequence}:${frame.timestampMs}`).join('|'));
}

function decisionDigest(decisions: readonly FrameDecision[], deliveries: readonly Delivery[]): string {
  return hashString(decisions.join('') + '|' + deliveries.map((delivery) => `${delivery.sequence}@${delivery.timestampMs}`).join(','));
}

function mean(values: readonly number[]): number {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

function percentile(values: readonly number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

function inEvent(timestampMs: number, event: { readonly startMs: number; readonly endMs: number }): boolean {
  return timestampMs >= event.startMs && timestampMs < event.endMs;
}

function inAnyEvent(timestampMs: number, events: readonly { readonly startMs: number; readonly endMs: number }[]): boolean {
  return events.some((event) => inEvent(timestampMs, event));
}

export function countBudgetViolations(
  timestamps: readonly number[],
  frameLimit: number,
  windowMs: number,
): number {
  const recent: number[] = [];
  let violations = 0;
  for (const timestamp of [...timestamps].sort((left, right) => left - right)) {
    while (recent.length && timestamp >= recent[0] + windowMs) recent.shift();
    if (recent.length >= frameLimit) violations += 1;
    recent.push(timestamp);
  }
  return violations;
}

export function evaluateScene(
  scene: BenchmarkScene,
  deliveries: readonly Delivery[],
  processingMs: readonly number[],
): SceneEvaluation {
  const observable = scene.events.filter((event) =>
    scene.frames.some((frame) => inEvent(frame.timestampMs, event)));
  const unobservable = scene.events.filter((event) => !observable.includes(event));
  const captured: Array<{ event: (typeof scene.events)[number]; latencyMs: number }> = [];
  const missedEventIds: string[] = [];

  for (const event of observable) {
    const firstDelivery = deliveries.find((delivery) => inEvent(delivery.timestampMs, event));
    if (firstDelivery) captured.push({ event, latencyMs: firstDelivery.timestampMs - event.startMs });
    else missedEventIds.push(event.id);
  }

  const latencies = captured.map((entry) => entry.latencyMs);
  return {
    inputs: scene.frames.length,
    sent: deliveries.length,
    events: scene.events.length,
    observableEvents: observable.length,
    capturedEvents: captured.length,
    missedEvents: missedEventIds.length,
    unobservableEvents: unobservable.length,
    recall: observable.length ? captured.length / observable.length : 0,
    meanFirstCaptureLatencyMs: latencies.length ? mean(latencies) : null,
    maxFirstCaptureLatencyMs: latencies.length ? Math.max(...latencies) : null,
    sentOutsideEvents: deliveries.filter((delivery) => !inAnyEvent(delivery.timestampMs, scene.events)).length,
    meanProcessingMs: mean(processingMs),
    p95ProcessingMs: percentile(processingMs, 0.95),
    budgetViolations: countBudgetViolations(
      deliveries.map((delivery) => delivery.timestampMs),
      BENCHMARK_FRAME_LIMIT,
      BENCHMARK_BUDGET_WINDOW_MS,
    ),
    missedEventIds,
    unobservableEventIds: unobservable.map((event) => event.id),
  };
}

export function runStrategyOnScene(
  scene: BenchmarkScene,
  strategy: BenchmarkStrategyId,
  local: LocalTuning = BENCHMARK_DEFAULT_LOCAL,
): StrategySceneResult {
  const sampler = new Sampler<null, PixelSample>(
    createPolicy(strategy, local),
    new BudgetController(BENCHMARK_BUDGET_WINDOW_MS, BENCHMARK_FRAME_LIMIT),
    BENCHMARK_TIMING,
    { accept: () => true },
  );
  const deliveries: Delivery[] = [];
  const decisions: FrameDecision[] = [];
  const processingMs: number[] = [];

  for (const replayFrame of scene.frames) {
    const frame: StreamFrame<null> = {
      sequence: replayFrame.sequence,
      timestampMs: replayFrame.timestampMs,
      payload: null,
    };
    const startedAt = performance.now();
    const decision = sampler.process(frame, replayFrame.sample, 0);
    processingMs.push(performance.now() - startedAt);
    decisions.push(decision);
    if (decision === 'sent') {
      deliveries.push({ sequence: replayFrame.sequence, timestampMs: replayFrame.timestampMs });
    }
  }

  const evaluation = evaluateScene(scene, deliveries, processingMs);
  const label = BENCHMARK_STRATEGIES.find((entry) => entry.id === strategy)?.label ?? strategy;
  return {
    suite: scene.suite,
    sceneId: scene.id,
    sceneDescription: scene.description,
    strategy,
    strategyLabel: label,
    ...evaluation,
    inputDigest: inputDigest(scene),
    decisionDigest: decisionDigest(decisions, deliveries),
  };
}

export function aggregateStrategy(
  results: readonly StrategySceneResult[],
  strategy: BenchmarkStrategyId,
): StrategyAggregate {
  const selected = results.filter((result) => result.strategy === strategy);
  const inputs = selected.reduce((total, result) => total + result.inputs, 0);
  const sent = selected.reduce((total, result) => total + result.sent, 0);
  const events = selected.reduce((total, result) => total + result.events, 0);
  const observableEvents = selected.reduce((total, result) => total + result.observableEvents, 0);
  const capturedEvents = selected.reduce((total, result) => total + result.capturedEvents, 0);
  const missedEvents = selected.reduce((total, result) => total + result.missedEvents, 0);
  const unobservableEvents = selected.reduce((total, result) => total + result.unobservableEvents, 0);
  const sentOutsideEvents = selected.reduce((total, result) => total + result.sentOutsideEvents, 0);
  const budgetViolations = selected.reduce((total, result) => total + result.budgetViolations, 0);
  const latencyTotal = selected.reduce(
    (total, result) => total + (result.meanFirstCaptureLatencyMs ?? 0) * result.capturedEvents,
    0,
  );
  const maxLatency = selected
    .map((result) => result.maxFirstCaptureLatencyMs)
    .filter((value): value is number => value !== null);
  const label = BENCHMARK_STRATEGIES.find((entry) => entry.id === strategy)?.label ?? strategy;

  return {
    strategy,
    strategyLabel: label,
    scenes: selected.length,
    inputs,
    sent,
    events,
    observableEvents,
    capturedEvents,
    missedEvents,
    unobservableEvents,
    recall: observableEvents ? capturedEvents / observableEvents : 0,
    meanFirstCaptureLatencyMs: capturedEvents ? latencyTotal / capturedEvents : null,
    maxFirstCaptureLatencyMs: maxLatency.length ? Math.max(...maxLatency) : null,
    sentOutsideEvents,
    meanProcessingMs: inputs
      ? selected.reduce((total, result) => total + result.meanProcessingMs * result.inputs, 0) / inputs
      : 0,
    budgetViolations,
  };
}

function aggregateAll(results: readonly StrategySceneResult[]): StrategyAggregate[] {
  return BENCHMARK_STRATEGIES.map((strategy) => aggregateStrategy(results, strategy.id));
}

function sceneSummary(scene: BenchmarkScene): SceneSummary {
  return {
    id: scene.id,
    suite: scene.suite,
    description: scene.description,
    frames: scene.frames.length,
    durationMs: scene.frames.length ? scene.frames[scene.frames.length - 1].timestampMs + 1_000 / BENCHMARK_FRAME_RATE : 0,
    events: scene.events,
  };
}

function runSuite(scenes: readonly BenchmarkScene[], local: LocalTuning): SceneSuiteResult {
  const results: StrategySceneResult[] = [];
  for (const scene of scenes) {
    for (const strategy of BENCHMARK_STRATEGIES) {
      results.push(runStrategyOnScene(scene, strategy.id, local));
    }
  }
  return {
    scenes: scenes.map(sceneSummary),
    results,
    aggregates: aggregateAll(results),
  };
}

function tuningScore(local: StrategyAggregate, hybrid: StrategyAggregate): number {
  // Worst-case recall first, then total recall, then fewer sends outside
  // labeled events. Processing time is reported but not used to select.
  return (
    Math.min(local.recall, hybrid.recall) * 10
    + local.recall
    + hybrid.recall
    - 0.001 * (local.sentOutsideEvents + hybrid.sentOutsideEvents)
  );
}

function runTuningCandidates(scenes: readonly BenchmarkScene[]): TuningCandidateResult[] {
  return TUNING_CANDIDATES.map((config) => {
    const results: StrategySceneResult[] = [];
    for (const scene of scenes) {
      results.push(runStrategyOnScene(scene, 'local', config));
      results.push(runStrategyOnScene(scene, 'hybrid', config));
    }
    const local = aggregateStrategy(results, 'local');
    const hybrid = aggregateStrategy(results, 'hybrid');
    return { config, local, hybrid, score: tuningScore(local, hybrid) };
  });
}

export function selectTuningCandidate(candidates: readonly TuningCandidateResult[]): LocalTuning {
  const ranked = [...candidates].sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    const leftOutside = left.local.sentOutsideEvents + left.hybrid.sentOutsideEvents;
    const rightOutside = right.local.sentOutsideEvents + right.hybrid.sentOutsideEvents;
    if (leftOutside !== rightOutside) return leftOutside - rightOutside;
    const leftSent = left.local.sent + left.hybrid.sent;
    const rightSent = right.local.sent + right.hybrid.sent;
    if (leftSent !== rightSent) return leftSent - rightSent;
    if (left.config.threshold !== right.config.threshold) return left.config.threshold - right.config.threshold;
    return left.config.blockWidth - right.config.blockWidth;
  });
  return ranked[0]?.config ?? BENCHMARK_DEFAULT_LOCAL;
}

function buildFailureCases(suites: Record<SceneSuite, SceneSuiteResult>): BenchmarkFailureCase[] {
  const failures: BenchmarkFailureCase[] = [];
  for (const suite of ['tuning', 'evaluation'] as const) {
    for (const result of suites[suite].results) {
      const scene = suites[suite].scenes.find((entry) => entry.id === result.sceneId);
      if (!scene) continue;
      for (const eventId of result.missedEventIds) {
        const event = scene.events.find((entry) => entry.id === eventId);
        if (event) {
          failures.push({
            suite,
            sceneId: result.sceneId,
            eventId,
            eventKind: event.kind,
            strategy: result.strategy,
            reason: 'missed',
          });
        }
      }
    }
  }
  return failures;
}

export function runBenchmark(): BenchmarkReport {
  const tuningScenes = getScenes('tuning');
  const evaluationScenes = getScenes('evaluation');
  const candidates = runTuningCandidates(tuningScenes);
  const selected = selectTuningCandidate(candidates);

  const suites: Record<SceneSuite, SceneSuiteResult> = {
    tuning: runSuite(tuningScenes, selected),
    evaluation: runSuite(evaluationScenes, selected),
  };

  const configuration: BenchmarkConfiguration = {
    sampleWidth: SAMPLE_WIDTH,
    sampleHeight: SAMPLE_HEIGHT,
    frameRate: BENCHMARK_FRAME_RATE,
    budgetWindowMs: BENCHMARK_BUDGET_WINDOW_MS,
    frameLimit: BENCHMARK_FRAME_LIMIT,
    minimumIntervalMs: BENCHMARK_TIMING.minimumIntervalMs,
    maximumSilenceMs: BENCHMARK_TIMING.maximumSilenceMs,
    globalThreshold: BENCHMARK_GLOBAL_THRESHOLD,
    selectedLocal: selected,
    strategies: BENCHMARK_STRATEGIES,
  };

  return {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    phase: '1B',
    configuration,
    selection: {
      local: selected,
      rule: 'Only the tuning suite selects parameters: maximize worst-case local/hybrid recall, then total recall, then minimize sends outside labeled events, then total sends.',
      candidates,
    },
    suites,
    failureCases: buildFailureCases(suites),
    notes: [
      'Recall counts an event as captured when at least one delivered frame timestamp falls inside its labeled window. It does not measure whether a model understood the event.',
      'Event labels and regions are consumed only by the evaluator after replay. Sampling policies receive only the current sample and their own prior accepted sample.',
      'All strategies replay the same frame samples, timestamps, budget window, frame limit, minimum interval, and silence refresh.',
      'Events entirely inside a capture gap are reported separately and excluded from the recall denominator.',
      'Processing time is measured wall-clock time and varies between runs; sub-millisecond values are near timer resolution and should be read as relative diagnostics. Frame decisions and replay inputs are deterministic.',
      'The evaluation suite is held out from parameter selection.',
    ],
  };
}
