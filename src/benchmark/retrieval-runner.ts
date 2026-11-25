import { ActiveRetrievalService } from '../core/active-retrieval';
import { ContextBuffer } from '../core/context-buffer';
import type { FrameDecision } from '../core/metrics';
import { SAMPLE_HEIGHT, SAMPLE_WIDTH } from '../core/sample';
import type { PixelSample } from '../core/sampling';
import { Sampler } from '../core/sampler';
import type { StreamFrame } from '../core/stream';
import { aggregateEvidenceTiming, countResourceViolations, evaluateEvidence } from './evidence';
import type { EvidenceDelivery } from './evidence';
import { getScenes } from './fixtures';
import {
  BENCHMARK_DEFAULT_LOCAL,
  BENCHMARK_FRAME_LIMIT,
  BENCHMARK_TIMING,
  BENCHMARK_BUDGET_WINDOW_MS,
  createPolicy,
} from './runner';
import { BENCHMARK_FRAME_RATE } from './types';
import type { BenchmarkScene } from './types';
import {
  PHASE2_SCHEMA_VERSION,
} from './retrieval-types';
import type {
  Phase2Aggregate,
  Phase2Configuration,
  Phase2FocusResult,
  Phase2Report,
  Phase2SceneResult,
  Phase2SceneSummary,
  Phase2Strategy,
  Phase2StrategyId,
  Phase2SuiteResult,
} from './retrieval-types';

export const PHASE2_SAMPLE_BYTES = SAMPLE_WIDTH * SAMPLE_HEIGHT * 4;
export const PHASE2_BUFFER_MAX_AGE_MS = 3_000;
export const PHASE2_BUFFER_MAX_FRAMES = 90;
export const PHASE2_BUFFER_MAX_BYTES = 3_000_000;
export const PHASE2_RETRIEVAL_WINDOW_MS = 5_000;
export const PHASE2_REALTIME_MAX_BYTES = 1_000_000;
export const PHASE2_RETRIEVAL_MAX_FRAMES = 6;
export const PHASE2_RETRIEVAL_MAX_BYTES = 2_000_000;
export const PHASE2_TOTAL_MAX_FRAMES = BENCHMARK_FRAME_LIMIT + PHASE2_RETRIEVAL_MAX_FRAMES;
export const PHASE2_TOTAL_MAX_BYTES = 4_000_000;
export const PHASE2_CUE_INTERVAL_MS = 500;
export const PHASE2_CUE_CANDIDATES = [400, 500, 600, 750, 1_000] as const;

export const PHASE2_STRATEGIES: readonly Phase2Strategy[] = [
  { id: 'fixed', label: 'A · Fixed 4 fps', oracle: false, cue: 'none' },
  { id: 'local', label: 'B · Adaptive local', oracle: false, cue: 'none' },
  { id: 'local-retrieval', label: 'C · Local + cue retrieval', oracle: false, cue: 'budget-denied frames, selected minimum spacing' },
  { id: 'local-oracle-retrieval', label: 'Oracle · local + label-timed retrieval', oracle: true, cue: 'event midpoint labels; upper bound only' },
];

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

function decisionDigest(
  decisions: readonly FrameDecision[],
  realtime: readonly EvidenceDelivery[],
  retrieval: readonly EvidenceDelivery[],
): string {
  return hashString(
    decisions.join('')
    + '|'
    + realtime.map((delivery) => `${delivery.sequence}@${delivery.capturedAtMs}`).join(',')
    + '|'
    + retrieval.map((delivery) => `${delivery.sequence}@${delivery.capturedAtMs}:${delivery.deliveredAtMs}:${delivery.bytes}`).join(','),
  );
}

function mean(values: readonly number[]): number {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

function percentile(values: readonly number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

function inAnyEvent(timestampMs: number, scene: BenchmarkScene): boolean {
  return scene.events.some((event) => timestampMs >= event.startMs && timestampMs < event.endMs);
}

function retrievalLatencyStats(latencies: readonly number[]): {
  mean: number | null;
  p95: number | null;
} {
  return latencies.length
    ? { mean: mean(latencies), p95: percentile(latencies, 0.95) }
    : { mean: null, p95: null };
}

function strategyPolicy(id: Phase2StrategyId) {
  return id === 'fixed' ? 'fixed' : 'local';
}

function retrievalConfig(sessionId: string, oracle: boolean) {
  return {
    sessionId,
    realtime: {
      windowMs: PHASE2_RETRIEVAL_WINDOW_MS,
      maxFrames: BENCHMARK_FRAME_LIMIT,
      maxBytes: PHASE2_REALTIME_MAX_BYTES,
    },
    retrieval: oracle
      ? { windowMs: PHASE2_RETRIEVAL_WINDOW_MS, maxFrames: 10_000, maxBytes: 100_000_000 }
      : {
          windowMs: PHASE2_RETRIEVAL_WINDOW_MS,
          maxFrames: PHASE2_RETRIEVAL_MAX_FRAMES,
          maxBytes: PHASE2_RETRIEVAL_MAX_BYTES,
        },
    total: oracle
      ? { windowMs: PHASE2_RETRIEVAL_WINDOW_MS, maxFrames: 10_000, maxBytes: 100_000_000 }
      : {
          windowMs: PHASE2_RETRIEVAL_WINDOW_MS,
          maxFrames: PHASE2_TOTAL_MAX_FRAMES,
          maxBytes: PHASE2_TOTAL_MAX_BYTES,
        },
    logCapacity: 200,
  };
}

export function runPhase2StrategyOnScene(
  scene: BenchmarkScene,
  strategy: Phase2StrategyId,
  cueIntervalMs = PHASE2_CUE_INTERVAL_MS,
): Phase2SceneResult {
  const strategyInfo = PHASE2_STRATEGIES.find((entry) => entry.id === strategy) as Phase2Strategy;
  const sessionId = `phase2:${scene.id}:${strategy}`;
  const buffer = new ContextBuffer({
    sessionId,
    maxAgeMs: PHASE2_BUFFER_MAX_AGE_MS,
    maxFrames: PHASE2_BUFFER_MAX_FRAMES,
    maxBytes: PHASE2_BUFFER_MAX_BYTES,
  });
  const replayClock = { now: 0 };
  const service = new ActiveRetrievalService(
    buffer,
    retrievalConfig(sessionId, strategyInfo.oracle),
    () => replayClock.now,
  );
  const sampler = new Sampler<null, PixelSample>(
    createPolicy(strategyPolicy(strategy), BENCHMARK_DEFAULT_LOCAL),
    service.admission,
    BENCHMARK_TIMING,
    { accept: () => true },
    undefined,
    PHASE2_SAMPLE_BYTES,
    () => replayClock.now,
  );

  const realtimeDeliveries: EvidenceDelivery[] = [];
  const retrievalDeliveries: EvidenceDelivery[] = [];
  const decisions: FrameDecision[] = [];
  const retrievalLatencies: number[] = [];
  let realtimeBytes = 0;
  let retrievalBytes = 0;
  let peakCacheBytes = 0;
  let peakCacheFrames = 0;
  let lastCueTimestampMs = -Infinity;
  const oracleQueries = strategyInfo.oracle
    ? scene.events.map((event) => ({
        event,
        atMs: (event.startMs + event.endMs) / 2,
        done: false,
      }))
    : [];

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
    const bufferStats = buffer.stats();
    if (bufferStats.byteCount > peakCacheBytes) peakCacheBytes = bufferStats.byteCount;
    if (bufferStats.frameCount > peakCacheFrames) peakCacheFrames = bufferStats.frameCount;

    const frame: StreamFrame<null> = {
      sequence: replayFrame.sequence,
      timestampMs: replayFrame.timestampMs,
      payload: null,
    };
    const decision = sampler.process(frame, replayFrame.sample, 0);
    decisions.push(decision);

    if (decision === 'sent') {
      realtimeDeliveries.push({
        sequence: replayFrame.sequence, capturedAtMs: replayFrame.timestampMs,
        deliveredAtMs: sampler.lastDeliveredAtMs!, bytes: PHASE2_SAMPLE_BYTES,
      });
      realtimeBytes += PHASE2_SAMPLE_BYTES;
    }

    if (strategy === 'local-retrieval' && decision === 'budget'
      && replayFrame.timestampMs - lastCueTimestampMs >= cueIntervalMs) {
      lastCueTimestampMs = replayFrame.timestampMs;
      const response = service.getLatestFrame(sessionId);
      retrievalLatencies.push(response.latencyMs);
      if (response.status === 'available' && response.frame && response.deliveredAtMs !== null) {
        retrievalDeliveries.push({
          sequence: response.frame.sequence,
          capturedAtMs: response.frame.timestampMs,
          deliveredAtMs: response.deliveredAtMs,
          bytes: response.bytes,
        });
        retrievalBytes += response.bytes;
      }
    }

    if (strategyInfo.oracle) {
      for (const query of oracleQueries) {
        if (query.done || replayFrame.timestampMs < query.atMs) continue;
        query.done = true;
        const response = service.getFrameAtTimestamp(sessionId, query.atMs, 100);
        retrievalLatencies.push(response.latencyMs);
        if (response.status === 'available' && response.frame && response.deliveredAtMs !== null) {
          retrievalDeliveries.push({
            sequence: response.frame.sequence,
            capturedAtMs: response.frame.timestampMs,
            deliveredAtMs: response.deliveredAtMs,
            bytes: response.bytes,
          });
          retrievalBytes += response.bytes;
        }
      }
    }
  }

  const realtimeEvaluation = evaluateEvidence(scene, realtimeDeliveries);
  const combinedEvaluation = evaluateEvidence(scene, realtimeDeliveries, retrievalDeliveries);
  const serviceStats = service.stats();
  const bufferStats = buffer.stats();
  const latency = retrievalLatencyStats(retrievalLatencies);
  const realtimeBudgetViolations = countResourceViolations(
    realtimeDeliveries, BENCHMARK_FRAME_LIMIT, PHASE2_REALTIME_MAX_BYTES,
    BENCHMARK_BUDGET_WINDOW_MS,
  );
  const retrievalBudgetViolations = countResourceViolations(
    retrievalDeliveries,
    PHASE2_RETRIEVAL_MAX_FRAMES,
    PHASE2_RETRIEVAL_MAX_BYTES,
    PHASE2_RETRIEVAL_WINDOW_MS,
  );
  const totalBudgetViolations = countResourceViolations(
    [...realtimeDeliveries, ...retrievalDeliveries],
    PHASE2_TOTAL_MAX_FRAMES,
    PHASE2_TOTAL_MAX_BYTES,
    PHASE2_RETRIEVAL_WINDOW_MS,
  );

  const result: Phase2SceneResult = {
    suite: scene.suite,
    sceneId: scene.id,
    sceneDescription: scene.description,
    strategy,
    strategyLabel: strategyInfo.label,
    oracle: strategyInfo.oracle,
    inputs: scene.frames.length,
    observableEvents: realtimeEvaluation.observableEvents,
    unobservableEvents: scene.events.length - realtimeEvaluation.observableEvents,
    realtimeSent: realtimeDeliveries.length,
    retrievalFrames: retrievalDeliveries.length,
    retrievalBytes,
    totalSent: realtimeDeliveries.length + retrievalDeliveries.length,
    totalBytes: realtimeBytes + retrievalBytes,
    realtimeCapturedEvents: realtimeEvaluation.capturedEvents,
    realtimeRecall: realtimeEvaluation.recall,
    postCapturedEvents: combinedEvaluation.capturedEvents,
    postRetrievalRecall: combinedEvaluation.recall,
    missedBefore: realtimeEvaluation.missedEvents,
    missedAfter: combinedEvaluation.missedEvents,
    realtimeFirstCaptureLatencyMs: realtimeEvaluation.meanFirstCaptureLatencyMs,
    postFirstCaptureLatencyMs: combinedEvaluation.meanFirstCaptureLatencyMs,
    evidenceTiming: combinedEvaluation.timing,
    retrievalAvailable: serviceStats.available + serviceStats.partial,
    retrievalRequests: serviceStats.requests,
    retrievalDenied: serviceStats.budgetDenied,
    retrievalLatencyMeanMs: latency.mean,
    retrievalLatencyP95Ms: latency.p95,
    peakCacheBytes,
    peakCacheFrames,
    evictions: bufferStats.evictionCount,
    evictionsByAge: bufferStats.evictedByReason.age,
    evictionsByFrames: bufferStats.evictedByReason.frames,
    evictionsByBytes: bufferStats.evictedByReason.bytes,
    realtimeBudgetViolations,
    retrievalBudgetViolations,
    totalBudgetViolations,
    outsideRealtime: realtimeDeliveries.filter((delivery) => !inAnyEvent(delivery.capturedAtMs, scene)).length,
    outsideRetrieval: retrievalDeliveries.filter((delivery) => !inAnyEvent(delivery.capturedAtMs, scene)).length,
    missedBeforeIds: realtimeEvaluation.missedEventIds,
    missedAfterIds: combinedEvaluation.missedEventIds,
    inputDigest: inputDigest(scene),
    decisionDigest: decisionDigest(decisions, realtimeDeliveries, retrievalDeliveries),
    retrievalLog: serviceStats.log,
  };
  service.dispose();
  return result;
}

export function aggregatePhase2(
  results: readonly Phase2SceneResult[],
  strategy: Phase2StrategyId,
): Phase2Aggregate {
  const selected = results.filter((result) => result.strategy === strategy);
  const sum = (key: keyof Phase2SceneResult): number =>
    selected.reduce((total, result) => total + (typeof result[key] === 'number' ? result[key] as number : 0), 0);
  const observable = sum('observableEvents');
  const realtimeCaptured = sum('realtimeCapturedEvents');
  const postCaptured = sum('postCapturedEvents');
  const capturedRequests = selected.reduce((total, result) => total + result.retrievalRequests, 0);
  const latencyTotal = selected.reduce(
    (total, result) => total + (result.retrievalLatencyMeanMs ?? 0) * result.retrievalRequests,
    0,
  );
  const realtimeLatencyTotal = selected.reduce(
    (total, result) => total + (result.realtimeFirstCaptureLatencyMs ?? 0) * result.realtimeCapturedEvents,
    0,
  );
  const postLatencyTotal = selected.reduce(
    (total, result) => total + (result.postFirstCaptureLatencyMs ?? 0) * result.postCapturedEvents,
    0,
  );
  const info = PHASE2_STRATEGIES.find((entry) => entry.id === strategy) as Phase2Strategy;
  return {
    strategy,
    strategyLabel: info.label,
    oracle: info.oracle,
    scenes: selected.length,
    inputs: sum('inputs'),
    observableEvents: observable,
    unobservableEvents: sum('unobservableEvents'),
    realtimeSent: sum('realtimeSent'),
    retrievalFrames: sum('retrievalFrames'),
    retrievalBytes: sum('retrievalBytes'),
    totalSent: sum('totalSent'),
    totalBytes: sum('totalBytes'),
    realtimeCapturedEvents: realtimeCaptured,
    realtimeRecall: observable ? realtimeCaptured / observable : 0,
    postCapturedEvents: postCaptured,
    postRetrievalRecall: observable ? postCaptured / observable : 0,
    missedBefore: sum('missedBefore'),
    missedAfter: sum('missedAfter'),
    realtimeFirstCaptureLatencyMs: realtimeCaptured ? realtimeLatencyTotal / realtimeCaptured : null,
    postFirstCaptureLatencyMs: postCaptured ? postLatencyTotal / postCaptured : null,
    evidenceTiming: aggregateEvidenceTiming(selected),
    retrievalAvailable: sum('retrievalAvailable'),
    retrievalRequests: capturedRequests,
    retrievalDenied: sum('retrievalDenied'),
    retrievalLatencyMeanMs: capturedRequests ? latencyTotal / capturedRequests : null,
    peakCacheBytes: Math.max(0, ...selected.map((result) => result.peakCacheBytes)),
    peakCacheFrames: Math.max(0, ...selected.map((result) => result.peakCacheFrames)),
    evictions: sum('evictions'),
    realtimeBudgetViolations: sum('realtimeBudgetViolations'),
    retrievalBudgetViolations: sum('retrievalBudgetViolations'),
    totalBudgetViolations: sum('totalBudgetViolations'),
    outsideRealtime: sum('outsideRealtime'),
    outsideRetrieval: sum('outsideRetrieval'),
  };
}

function runSuite(scenes: readonly BenchmarkScene[], cueIntervalMs: number): Phase2SuiteResult {
  const results: Phase2SceneResult[] = [];
  for (const scene of scenes) {
    for (const strategy of PHASE2_STRATEGIES) {
      results.push(runPhase2StrategyOnScene(scene, strategy.id, cueIntervalMs));
    }
  }
  return {
    scenes: scenes.map((scene): Phase2SceneSummary => ({
      id: scene.id,
      suite: scene.suite,
      description: scene.description,
      frames: scene.frames.length,
      events: scene.events.length,
    })),
    results,
    aggregates: PHASE2_STRATEGIES.map((strategy) => aggregatePhase2(results, strategy.id)),
  };
}

function buildFocus(results: readonly Phase2SceneResult[]): Phase2FocusResult[] {
  return results
    .filter((result) => result.sceneId === 'eval-background-motion')
    .map((result) => ({
      sceneId: result.sceneId,
      strategy: result.strategy,
      strategyLabel: result.strategyLabel,
      realtimeRecall: result.realtimeRecall,
      postRetrievalRecall: result.postRetrievalRecall,
      retrievalFrames: result.retrievalFrames,
      retrievalBytes: result.retrievalBytes,
      missedBeforeIds: result.missedBeforeIds,
      missedAfterIds: result.missedAfterIds,
    }));
}

export function runPhase2Benchmark(): Phase2Report {
  const tuning = getScenes('tuning');
  const evaluation = getScenes('evaluation');
  const cueCandidates = PHASE2_CUE_CANDIDATES.map((intervalMs) => {
    const results: Phase2SceneResult[] = [];
    for (const scene of tuning) results.push(runPhase2StrategyOnScene(scene, 'local-retrieval', intervalMs));
    const aggregate = aggregatePhase2(results, 'local-retrieval');
    return {
      intervalMs,
      postRetrievalRecall: aggregate.postRetrievalRecall,
      retrievalFrames: aggregate.retrievalFrames,
      retrievalDenied: aggregate.retrievalDenied,
    };
  });
  const selectedCue = [...cueCandidates].sort((left, right) => {
    if (right.postRetrievalRecall !== left.postRetrievalRecall) return right.postRetrievalRecall - left.postRetrievalRecall;
    if (left.retrievalFrames !== right.retrievalFrames) return left.retrievalFrames - right.retrievalFrames;
    if (left.retrievalDenied !== right.retrievalDenied) return left.retrievalDenied - right.retrievalDenied;
    return left.intervalMs - right.intervalMs;
  })[0];
  const selectedCueInterval = selectedCue?.intervalMs ?? PHASE2_CUE_INTERVAL_MS;
  const tuningResult = runSuite(tuning, selectedCueInterval);
  const evaluationResult = runSuite(evaluation, selectedCueInterval);
  const configuration: Phase2Configuration = {
    sampleWidth: SAMPLE_WIDTH,
    sampleHeight: SAMPLE_HEIGHT,
    frameRate: BENCHMARK_FRAME_RATE,
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
    retrievalWindowMs: PHASE2_RETRIEVAL_WINDOW_MS,
    retrievalMaxFrames: PHASE2_RETRIEVAL_MAX_FRAMES,
    retrievalMaxBytes: PHASE2_RETRIEVAL_MAX_BYTES,
    totalMaxFrames: PHASE2_TOTAL_MAX_FRAMES,
    totalMaxBytes: PHASE2_TOTAL_MAX_BYTES,
    cueIntervalMs: selectedCueInterval,
    strategies: PHASE2_STRATEGIES,
  };

  return {
    schemaVersion: PHASE2_SCHEMA_VERSION,
    phase: '2-corrected',
    configuration,
    cueSelection: {
      intervalMs: selectedCueInterval,
      rule: 'Only the tuning suite selects the cue interval: maximize post-retrieval recall, then minimize retrieval frames and denials; the evaluation suite is held out.',
      candidates: cueCandidates,
    },
    suites: {
      tuning: tuningResult,
      evaluation: evaluationResult,
    },
    focus: buildFocus(evaluationResult.results),
    notes: [
      'A is the fixed baseline. B is the Phase 1B adaptive local baseline. C uses a real-time budget-denial cue to request the latest buffered frame; it does not read event labels.',
      'The oracle strategy uses event midpoint labels to request a frame. It is an upper-bound experiment only, is not evidence of autonomous discovery, and bypasses the production retrieval budget.',
      'Retrieval requests are charged to a separate retrieval budget and to a combined real-time + retrieval budget. The buffer is bounded by age, bytes, and frames.',
      'Events with no captured input frame cannot be recovered from the buffer. Retrieval can only return frames that were actually stored and are still retained.',
      'Evidence coverage uses capture inside the labeled window. Deadline coverage requires delivery before the window closes. Budget auditing uses delivery time.',
      'Request and delivery timing uses the deterministic replay clock. Synchronous retrieval has zero simulated service time.',
    ],
  };
}
