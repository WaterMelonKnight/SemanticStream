import type { BufferedFrame, DataStatus, FrameLookupResult, PixelRegion, RegionImage, TimeRange } from './context-buffer';
import { ContextBuffer } from './context-buffer';
import { ResourceAdmissionController } from './resource-admission';
import type { ResourceAdmissionSnapshot } from './resource-admission';
import type { ResourceBudgetLimits } from './resource-budget';

export type RetrievalMethod =
  | 'getLatestFrame'
  | 'getFrameBySequence'
  | 'getFrameAtTimestamp'
  | 'getFramesBetween'
  | 'getRegion';

export type RetrievalStatus = DataStatus | 'budget-denied';

export type RetrievalBudgetSnapshot = ResourceAdmissionSnapshot;

export interface RetrievalResponseBase {
  readonly requestId: string;
  readonly sessionId: string;
  readonly method: RetrievalMethod;
  readonly status: RetrievalStatus;
  readonly requestedAtMs: number;
  readonly completedAtMs: number;
  readonly deliveredAtMs: number | null;
  readonly latencyMs: number;
  readonly message: string;
  readonly availableRange: TimeRange | null;
  readonly capturedRange: TimeRange | null;
  readonly budget: RetrievalBudgetSnapshot;
}

export interface FrameRetrievalResponse extends RetrievalResponseBase {
  readonly frame: BufferedFrame | null;
  readonly bytes: number;
}

export interface RangeRetrievalResponse extends RetrievalResponseBase {
  readonly frames: readonly BufferedFrame[];
  readonly bytes: number;
  readonly requestedRange: TimeRange;
  readonly missing: ReadonlyArray<{ readonly reason: string; readonly range: TimeRange }>;
  readonly truncated: boolean;
}

export interface RegionRetrievalResponse extends RetrievalResponseBase {
  readonly sourceFrame: {
    readonly sequence: number;
    readonly timestampMs: number;
    readonly width: number;
    readonly height: number;
  } | null;
  readonly region: PixelRegion;
  readonly image: RegionImage | null;
  readonly bytes: number;
}

export type RetrievalResponse = FrameRetrievalResponse | RangeRetrievalResponse | RegionRetrievalResponse;

export interface RetrievalLogEntry {
  readonly requestId: string;
  readonly method: RetrievalMethod;
  readonly requestedAtMs: number;
  readonly completedAtMs: number;
  readonly deliveredAtMs: number | null;
  readonly latencyMs: number;
  readonly status: RetrievalStatus;
  readonly frameCount: number;
  readonly bytes: number;
  readonly message: string;
}

export interface RetrievalStats {
  readonly sessionId: string;
  readonly requests: number;
  readonly available: number;
  readonly partial: number;
  readonly budgetDenied: number;
  readonly failed: number;
  readonly retrievedFrames: number;
  readonly retrievedBytes: number;
  readonly log: readonly RetrievalLogEntry[];
  readonly budget: RetrievalBudgetSnapshot;
  readonly disposed: boolean;
}

export interface ActiveRetrievalConfig {
  readonly sessionId: string;
  readonly realtime: ResourceBudgetLimits;
  readonly retrieval: ResourceBudgetLimits;
  readonly total: ResourceBudgetLimits;
  readonly logCapacity?: number;
}

/**
 * Applies a retrieval-specific budget and a combined real-time + retrieval
 * ledger before returning a buffered frame. The buffer only owns frame copies;
 * this service owns request accounting and request-log retention.
 */
export class ActiveRetrievalService {
  readonly admission: ResourceAdmissionController;
  private readonly logCapacity: number;
  private readonly requests: RetrievalLogEntry[] = [];
  private requestCounter = 0;
  private requestCount = 0;
  private availableCount = 0;
  private partialCount = 0;
  private budgetDeniedCount = 0;
  private failedCount = 0;
  private retrievedFrames = 0;
  private retrievedBytes = 0;
  private disposed = false;

  constructor(
    private readonly buffer: ContextBuffer,
    private readonly config: ActiveRetrievalConfig,
    private readonly now: () => number = () => performance.now(),
  ) {
    if (!config.sessionId) throw new RangeError('Session ID must be nonempty.');
    if (config.sessionId !== buffer.sessionId) {
      throw new RangeError('Retrieval service and buffer must use the same session ID.');
    }
    if (config.retrieval.windowMs !== config.total.windowMs) {
      throw new RangeError('Retrieval and total resource windows must match.');
    }
    this.admission = new ResourceAdmissionController({
      realtime: config.realtime,
      retrieval: config.retrieval,
      total: config.total,
    });
    this.logCapacity = config.logCapacity ?? 40;
    if (!Number.isSafeInteger(this.logCapacity) || this.logCapacity < 1) {
      throw new RangeError('Retrieval log capacity must be a positive integer.');
    }
  }

  get sessionId(): string {
    return this.config.sessionId;
  }

  setRealtimeFrameLimit(maxFrames: number): void {
    this.admission.setRealtimeFrameLimit(maxFrames);
  }

  setTotalFrameLimit(maxFrames: number): void {
    this.admission.setTotalFrameLimit(maxFrames);
  }

  getLatestFrame(sessionId: string): FrameRetrievalResponse {
    return this.frameRequest('getLatestFrame', sessionId, () => this.buffer.getLatestFrame(sessionId));
  }

  getFrameBySequence(sessionId: string, sequence: number): FrameRetrievalResponse {
    return this.frameRequest('getFrameBySequence', sessionId, () => this.buffer.getFrameBySequence(sessionId, sequence));
  }

  getFrameAtTimestamp(sessionId: string, timestampMs: number, toleranceMs?: number): FrameRetrievalResponse {
    return this.frameRequest(
      'getFrameAtTimestamp',
      sessionId,
      () => this.buffer.getFrameAtTimestamp(sessionId, timestampMs, toleranceMs),
    );
  }

  getFramesBetween(
    sessionId: string,
    startMs: number,
    endMs: number,
    options: { readonly maxFrames?: number } = {},
  ): RangeRetrievalResponse {
    const startedAt = this.requestStart();
    const requestId = this.nextRequestId();
    const failureBase = () => this.responseBase(requestId, sessionId, 'getFramesBetween', startedAt);
    if (this.disposed) return this.rangeFailure(failureBase(), startMs, endMs, 'disposed', 'The retrieval service is disposed.');
    if (sessionId !== this.config.sessionId) {
      return this.rangeFailure(failureBase(), startMs, endMs, 'wrong-session', 'The request belongs to a different buffer session.');
    }
    const result = this.buffer.getFramesBetween(sessionId, startMs, endMs, options);
    const baseAfter = this.responseBase(requestId, sessionId, 'getFramesBetween', startedAt);
    if (result.status === 'available' || result.status === 'partial') {
      const delivery = this.deliver(baseAfter.completedAtMs, result.frames.length, result.byteCount);
      if (!delivery) {
        const denied = this.rangeFailure(baseAfter, startMs, endMs, 'budget-denied', 'Retrieval budget or total resource budget is exhausted.');
        this.record(denied, 0, 0);
        return denied;
      }
      const response: RangeRetrievalResponse = {
        ...baseAfter,
        ...delivery,
        status: result.status,
        message: result.message,
        frames: result.frames,
        bytes: result.byteCount,
        requestedRange: result.requestedRange,
        missing: result.missing,
        truncated: result.truncated,
      };
      this.record(response, result.frames.length, result.byteCount);
      return response;
    }
    const response: RangeRetrievalResponse = {
      ...baseAfter,
      status: result.status,
      message: result.message,
      frames: [],
      bytes: 0,
      requestedRange: result.requestedRange,
      missing: result.missing,
      truncated: false,
    };
    this.record(response, 0, 0);
    return response;
  }

  getRegion(
    sessionId: string,
    locator: { readonly sequence: number } | { readonly timestampMs: number; readonly toleranceMs?: number },
    region: PixelRegion,
  ): RegionRetrievalResponse {
    const startedAt = this.requestStart();
    const requestId = this.nextRequestId();
    const failureBase = () => this.responseBase(requestId, sessionId, 'getRegion', startedAt);
    if (this.disposed) {
      return this.regionFailure(failureBase(), region, 'disposed', 'The retrieval service is disposed.');
    }
    if (sessionId !== this.config.sessionId) {
      return this.regionFailure(failureBase(), region, 'wrong-session', 'The request belongs to a different buffer session.');
    }
    const result = this.buffer.getRegion(sessionId, locator, region);
    const baseAfter = this.responseBase(requestId, sessionId, 'getRegion', startedAt);
    if (result.status === 'available' && result.image) {
      const delivery = this.deliver(baseAfter.completedAtMs, 1, result.image.byteSize);
      if (!delivery) {
        const denied = this.regionFailure(baseAfter, region, 'budget-denied', 'Retrieval budget or total resource budget is exhausted.');
        this.record(denied, 0, 0);
        return denied;
      }
      const response: RegionRetrievalResponse = {
        ...baseAfter,
        ...delivery,
        status: 'available',
        message: result.message,
        sourceFrame: result.sourceFrame,
        region: result.region,
        image: result.image,
        bytes: result.image.byteSize,
      };
      this.record(response, 1, result.image.byteSize);
      return response;
    }
    const response: RegionRetrievalResponse = {
      ...baseAfter,
      status: result.status,
      message: result.message,
      sourceFrame: result.sourceFrame,
      region: result.region,
      image: null,
      bytes: 0,
    };
    this.record(response, 0, 0);
    return response;
  }

  stats(): RetrievalStats {
    const now = this.now();
    return {
      sessionId: this.config.sessionId,
      requests: this.requestCount,
      available: this.availableCount,
      partial: this.partialCount,
      budgetDenied: this.budgetDeniedCount,
      failed: this.failedCount,
      retrievedFrames: this.retrievedFrames,
      retrievedBytes: this.retrievedBytes,
      log: [...this.requests],
      budget: this.budgetSnapshot(now),
      disposed: this.disposed,
    };
  }

  dispose(): void {
    this.buffer.dispose();
    this.requests.length = 0;
    this.disposed = true;
  }

  private frameRequest(
    method: 'getLatestFrame' | 'getFrameBySequence' | 'getFrameAtTimestamp',
    sessionId: string,
    lookup: () => FrameLookupResult,
  ): FrameRetrievalResponse {
    const startedAt = this.requestStart();
    const requestId = this.nextRequestId();
    const failureBase = () => this.responseBase(requestId, sessionId, method, startedAt);
    if (this.disposed) return this.frameFailure(failureBase(), 'disposed', 'The retrieval service is disposed.');
    if (sessionId !== this.config.sessionId) {
      return this.frameFailure(failureBase(), 'wrong-session', 'The request belongs to a different buffer session.');
    }

    const result = lookup();
    const baseAfter = this.responseBase(requestId, sessionId, method, startedAt);
    if (result.status !== 'available' || !result.frame) {
      const response = this.frameFailure(baseAfter, result.status, result.message);
      this.record(response, 0, 0);
      return response;
    }
    const delivery = this.deliver(baseAfter.completedAtMs, 1, result.frame.byteSize);
    if (!delivery) {
      const denied = this.frameFailure(baseAfter, 'budget-denied', 'Retrieval budget or total resource budget is exhausted.');
      this.record(denied, 0, 0);
      return denied;
    }
    const response: FrameRetrievalResponse = {
      ...baseAfter,
      ...delivery,
      status: 'available',
      message: result.message,
      frame: result.frame,
      bytes: result.frame.byteSize,
    };
    this.record(response, 1, result.frame.byteSize);
    return response;
  }

  private requestStart(): number {
    const startedAt = this.now();
    if (!Number.isFinite(startedAt)) throw new RangeError('Retrieval request time must be finite.');
    return startedAt;
  }

  private responseBase(
    requestId: string,
    sessionId: string,
    method: RetrievalMethod,
    startedAt: number,
  ): RetrievalResponseBase {
    const completedAtMs = this.now();
    if (!Number.isFinite(completedAtMs) || completedAtMs < startedAt) {
      throw new RangeError('Retrieval completion time must be finite and at or after request start.');
    }
    const bufferStats = sessionId === this.sessionId ? this.buffer.stats() : null;
    return {
      requestId,
      sessionId,
      method,
      status: 'nonexistent',
      requestedAtMs: startedAt,
      completedAtMs,
      deliveredAtMs: null,
      latencyMs: completedAtMs - startedAt,
      message: '',
      availableRange: bufferStats?.oldestTimestampMs == null
        ? null
        : { startMs: bufferStats.oldestTimestampMs, endMs: bufferStats.latestTimestampMs ?? bufferStats.oldestTimestampMs },
      capturedRange: bufferStats?.firstCapturedTimestampMs == null
        ? null
        : { startMs: bufferStats.firstCapturedTimestampMs, endMs: bufferStats.lastCapturedTimestampMs ?? bufferStats.firstCapturedTimestampMs },
      budget: this.budgetSnapshot(completedAtMs),
    };
  }

  private frameFailure(
    base: RetrievalResponseBase,
    status: RetrievalStatus,
    message: string,
  ): FrameRetrievalResponse {
    return { ...base, status, message, frame: null, bytes: 0 };
  }

  private rangeFailure(
    base: RetrievalResponseBase,
    startMs: number,
    endMs: number,
    status: RetrievalStatus,
    message: string,
  ): RangeRetrievalResponse {
    return {
      ...base,
      status,
      message,
      frames: [],
      bytes: 0,
      requestedRange: { startMs, endMs },
      missing: [],
      truncated: false,
    };
  }

  private regionFailure(
    base: RetrievalResponseBase,
    region: PixelRegion,
    status: RetrievalStatus,
    message: string,
  ): RegionRetrievalResponse {
    return {
      ...base,
      status,
      message,
      sourceFrame: null,
      region,
      image: null,
      bytes: 0,
    };
  }

  private deliver(deliveredAtMs: number, frames: number, bytes: number) {
    const hold = this.admission.reserveRetrieval(deliveredAtMs, frames, bytes);
    if (!hold) return null;
    hold.commit(deliveredAtMs);
    return { deliveredAtMs, budget: this.budgetSnapshot(deliveredAtMs) };
  }

  private budgetSnapshot(now: number): RetrievalBudgetSnapshot {
    return this.admission.snapshot(now);
  }

  private record(response: RetrievalResponse, frameCount: number, bytes: number): void {
    this.requestCount += 1;
    if (response.status === 'available') this.availableCount += 1;
    else if (response.status === 'partial') this.partialCount += 1;
    else if (response.status === 'budget-denied') this.budgetDeniedCount += 1;
    else this.failedCount += 1;
    this.retrievedFrames += frameCount;
    this.retrievedBytes += bytes;
    this.requests.push({
      requestId: response.requestId,
      method: response.method,
      requestedAtMs: response.requestedAtMs,
      completedAtMs: response.completedAtMs,
      deliveredAtMs: response.deliveredAtMs,
      latencyMs: response.latencyMs,
      status: response.status,
      frameCount,
      bytes,
      message: response.message,
    });
    if (this.requests.length > this.logCapacity) this.requests.shift();
  }

  private nextRequestId(): string {
    this.requestCounter += 1;
    return `retrieval-${this.requestCounter}`;
  }
}
