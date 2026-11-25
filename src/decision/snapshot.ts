import type { ContextBufferStats, TimeRange } from '../core/context-buffer';
import type { ResourceAdmissionSnapshot } from '../core/resource-admission';
import type { DecisionState } from './types';

export function decisionBudget(snapshot: ResourceAdmissionSnapshot): DecisionState['budget'] {
  const frames = ({ maxFrames, usedFrames, reservedFrames }: ResourceAdmissionSnapshot['total']) =>
    Math.max(0, maxFrames - usedFrames - reservedFrames);
  const bytes = ({ maxBytes, usedBytes, reservedBytes }: ResourceAdmissionSnapshot['total']) =>
    Math.max(0, maxBytes - usedBytes - reservedBytes);
  return {
    realtimeRemainingFrames: frames(snapshot.realtime),
    realtimeRemainingBytes: bytes(snapshot.realtime),
    retrievalRemainingFrames: frames(snapshot.retrieval),
    retrievalRemainingBytes: bytes(snapshot.retrieval),
    totalRemainingFrames: frames(snapshot.total),
    totalRemainingBytes: bytes(snapshot.total),
  };
}

function range(startMs: number | null, endMs: number | null): TimeRange | null {
  return startMs === null || endMs === null ? null : { startMs, endMs };
}

export function decisionCache(stats: ContextBufferStats): DecisionState['cache'] {
  return {
    availableRange: range(stats.oldestTimestampMs, stats.latestTimestampMs),
    capturedRange: range(stats.firstCapturedTimestampMs, stats.lastCapturedTimestampMs),
    frameCount: stats.frameCount,
    byteCount: stats.byteCount,
  };
}
