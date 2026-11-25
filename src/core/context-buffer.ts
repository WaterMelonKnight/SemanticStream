import type { PixelSample } from './sampling';

export interface ContextBufferConfig {
  readonly sessionId: string;
  readonly maxAgeMs: number;
  readonly maxBytes: number;
  readonly maxFrames: number;
  /** Optional decimation; zero stores every offered frame. */
  readonly captureIntervalMs?: number;
}

export interface BufferedFrameInput {
  readonly sequence: number;
  readonly timestampMs: number;
  readonly mediaTimeMs: number | null;
  readonly width: number;
  readonly height: number;
  readonly pixels: PixelSample;
  readonly phase?: string;
}

export interface BufferedFrame extends BufferedFrameInput {
  readonly sessionId: string;
  readonly byteSize: number;
}

export interface TimeRange {
  readonly startMs: number;
  readonly endMs: number;
}

export interface PixelRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface RegionImage {
  readonly width: number;
  readonly height: number;
  readonly pixels: PixelSample;
  readonly byteSize: number;
}

export interface MissingRange {
  readonly reason: 'evicted' | 'before-capture' | 'after-capture';
  readonly range: TimeRange;
}

export type DataStatus =
  | 'available'
  | 'partial'
  | 'evicted'
  | 'not-yet-captured'
  | 'nonexistent'
  | 'wrong-session'
  | 'invalid-range'
  | 'region-invalid'
  | 'disposed';

export interface ContextBufferStats {
  readonly sessionId: string;
  readonly frameCount: number;
  readonly byteCount: number;
  readonly maxAgeMs: number;
  readonly maxBytes: number;
  readonly maxFrames: number;
  readonly captureIntervalMs: number;
  readonly oldestTimestampMs: number | null;
  readonly latestTimestampMs: number | null;
  readonly firstCapturedTimestampMs: number | null;
  readonly lastCapturedTimestampMs: number | null;
  readonly firstCapturedSequence: number | null;
  readonly lastCapturedSequence: number | null;
  readonly storedFrames: number;
  readonly evictionCount: number;
  readonly evictedByReason: Readonly<{ age: number; frames: number; bytes: number }>;
  readonly disposed: boolean;
}

export interface FrameLookupResult {
  readonly status: DataStatus;
  readonly sessionId: string;
  readonly frame: BufferedFrame | null;
  readonly availableRange: TimeRange | null;
  readonly capturedRange: TimeRange | null;
  readonly message: string;
}

export interface FrameRangeLookupResult {
  readonly status: DataStatus;
  readonly sessionId: string;
  readonly frames: readonly BufferedFrame[];
  readonly byteCount: number;
  readonly requestedRange: TimeRange;
  readonly availableRange: TimeRange | null;
  readonly capturedRange: TimeRange | null;
  readonly missing: readonly MissingRange[];
  readonly truncated: boolean;
  readonly message: string;
}

export interface RegionLookupResult {
  readonly status: DataStatus;
  readonly sessionId: string;
  readonly sourceFrame: {
    readonly sequence: number;
    readonly timestampMs: number;
    readonly width: number;
    readonly height: number;
  } | null;
  readonly region: PixelRegion;
  readonly image: RegionImage | null;
  readonly availableRange: TimeRange | null;
  readonly capturedRange: TimeRange | null;
  readonly message: string;
}

function validatePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive integer.`);
  }
}

function validateFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite.`);
}

function copyFrame(frame: BufferedFrame): BufferedFrame {
  return { ...frame, pixels: new Uint8ClampedArray(frame.pixels) };
}

function rangeOrNull(startMs: number | null, endMs: number | null): TimeRange | null {
  return startMs === null || endMs === null ? null : { startMs, endMs };
}

/**
 * A bounded, session-scoped history of owned RGBA frame copies. It stores no
 * Canvas references: the caller's pixels are cloned on offer, and every lookup
 * returns another copy. Eviction is explicit by age, byte budget, or frame
 * budget. Cross-session requests return `wrong-session` rather than data.
 */
export class ContextBuffer {
  private readonly frames: BufferedFrame[] = [];
  private readonly captureIntervalMs: number;
  private byteCount = 0;
  private disposed = false;
  private firstCapturedTimestampMs: number | null = null;
  private lastCapturedTimestampMs: number | null = null;
  private firstCapturedSequence: number | null = null;
  private lastCapturedSequence: number | null = null;
  private storedFrames = 0;
  private evictionCount = 0;
  private readonly evictedByReason = { age: 0, frames: 0, bytes: 0 };
  private lastOfferedTimestampMs = -Infinity;

  constructor(private readonly config: ContextBufferConfig) {
    if (!config.sessionId) throw new RangeError('Session ID must be nonempty.');
    if (!Number.isFinite(config.maxAgeMs) || config.maxAgeMs <= 0) {
      throw new RangeError('Buffer max age must be positive and finite.');
    }
    validatePositiveInteger(config.maxBytes, 'Buffer max bytes');
    validatePositiveInteger(config.maxFrames, 'Buffer max frames');
    const interval = config.captureIntervalMs ?? 0;
    if (!Number.isFinite(interval) || interval < 0) {
      throw new RangeError('Capture interval must be nonnegative and finite.');
    }
    this.captureIntervalMs = interval;
  }

  get sessionId(): string {
    return this.config.sessionId;
  }

  /** Returns true when the frame was stored; false when decimation skipped it. */
  offer(input: BufferedFrameInput): boolean {
    this.assertActive();
    validateFinite(input.timestampMs, 'Frame timestamp');
    if (input.timestampMs < this.lastOfferedTimestampMs) {
      throw new RangeError('Frame timestamps must be nondecreasing within a buffer session.');
    }
    validatePositiveInteger(input.sequence, 'Frame sequence');
    validatePositiveInteger(input.width, 'Frame width');
    validatePositiveInteger(input.height, 'Frame height');
    if (input.pixels.length !== input.width * input.height * 4) {
      throw new RangeError('Frame pixels must match the declared RGBA dimensions.');
    }

    this.lastOfferedTimestampMs = input.timestampMs;
    if (this.frames.length && input.timestampMs - this.frames[this.frames.length - 1].timestampMs < this.captureIntervalMs) {
      return false;
    }

    const pixels = new Uint8ClampedArray(input.pixels);
    const frame: BufferedFrame = {
      sessionId: this.config.sessionId,
      sequence: input.sequence,
      timestampMs: input.timestampMs,
      mediaTimeMs: input.mediaTimeMs,
      width: input.width,
      height: input.height,
      pixels,
      phase: input.phase,
      byteSize: pixels.byteLength,
    };
    this.frames.push(frame);
    this.byteCount += frame.byteSize;
    this.storedFrames += 1;
    if (this.firstCapturedTimestampMs === null) this.firstCapturedTimestampMs = frame.timestampMs;
    this.firstCapturedSequence ??= frame.sequence;
    this.lastCapturedTimestampMs = frame.timestampMs;
    this.lastCapturedSequence = frame.sequence;

    this.evict(input.timestampMs);
    return this.frames.includes(frame);
  }

  getLatestFrame(sessionId: string): FrameLookupResult {
    const mismatch = this.sessionProblem(sessionId);
    if (mismatch) return mismatch;
    if (!this.frames.length) {
      return this.emptyLookup(
        this.capturedRange() ? 'evicted' : 'not-yet-captured',
        this.capturedRange() ? 'All captured frames have been evicted.' : 'No frame has been captured yet.',
      );
    }
    return this.availableLookup(this.frames[this.frames.length - 1]);
  }

  getFrameBySequence(sessionId: string, sequence: number): FrameLookupResult {
    const mismatch = this.sessionProblem(sessionId);
    if (mismatch) return mismatch;
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      throw new RangeError('Frame sequence must be a positive integer.');
    }
    if (this.lastCapturedSequence === null) {
      return this.emptyLookup('not-yet-captured', 'No frame has been captured yet.');
    }
    if (sequence < (this.firstCapturedSequence ?? 0)) {
      return this.emptyLookup('nonexistent', `Frame ${sequence} predates this session.`);
    }
    if (sequence > this.lastCapturedSequence) {
      return this.emptyLookup('not-yet-captured', `Frame ${sequence} has not been captured yet.`);
    }
    const frame = this.frames.find((entry) => entry.sequence === sequence);
    if (!frame) return this.emptyLookup('evicted', `Frame ${sequence} is no longer retained.`);
    return this.availableLookup(frame);
  }

  getFrameAtTimestamp(sessionId: string, timestampMs: number, toleranceMs = 100): FrameLookupResult {
    const mismatch = this.sessionProblem(sessionId);
    if (mismatch) return mismatch;
    validateFinite(timestampMs, 'Requested timestamp');
    if (!Number.isFinite(toleranceMs) || toleranceMs < 0) {
      throw new RangeError('Timestamp tolerance must be nonnegative and finite.');
    }
    if (this.lastCapturedTimestampMs === null) {
      return this.emptyLookup('not-yet-captured', 'No frame has been captured yet.');
    }
    if (timestampMs < (this.firstCapturedTimestampMs ?? 0)) {
      return this.emptyLookup('nonexistent', 'The requested timestamp predates this session.');
    }
    if (timestampMs > this.lastCapturedTimestampMs) {
      return this.emptyLookup('not-yet-captured', 'The requested timestamp has not been captured yet.');
    }

    let nearest: BufferedFrame | undefined;
    let nearestDistance = Infinity;
    for (const frame of this.frames) {
      const distance = Math.abs(frame.timestampMs - timestampMs);
      if (distance < nearestDistance || (distance === nearestDistance && frame.timestampMs < (nearest?.timestampMs ?? Infinity))) {
        nearest = frame;
        nearestDistance = distance;
      }
    }
    if (nearest && nearestDistance <= toleranceMs) return this.availableLookup(nearest);
    return this.emptyLookup('evicted', 'No retained frame is close enough to the requested timestamp.');
  }

  getFramesBetween(
    sessionId: string,
    startMs: number,
    endMs: number,
    options: { readonly maxFrames?: number } = {},
  ): FrameRangeLookupResult {
    const requestedRange = { startMs, endMs };
    const mismatch = this.sessionProblem(sessionId);
    if (mismatch) return this.rangeFailure(mismatch.status, requestedRange, mismatch.message);
    validateFinite(startMs, 'Range start');
    validateFinite(endMs, 'Range end');
    if (startMs > endMs) {
      return this.rangeFailure('invalid-range', requestedRange, 'Range start must not exceed range end.');
    }
    const maxFrames = options.maxFrames ?? 8;
    if (!Number.isSafeInteger(maxFrames) || maxFrames < 1) {
      throw new RangeError('maxFrames must be a positive integer.');
    }
    const capturedRange = this.capturedRange();
    const availableRange = this.availableRange();
    if (!capturedRange) {
      return this.rangeFailure('not-yet-captured', requestedRange, 'No frame has been captured yet.');
    }
    if (endMs < capturedRange.startMs) {
      return this.rangeFailure('nonexistent', requestedRange, 'The requested range predates this session.');
    }
    if (startMs > capturedRange.endMs) {
      return this.rangeFailure('not-yet-captured', requestedRange, 'The requested range has not been captured yet.');
    }

    const retained = this.frames.filter((frame) => frame.timestampMs >= startMs && frame.timestampMs <= endMs);
    const truncated = retained.length > maxFrames;
    const frames = (truncated ? retained.slice(0, maxFrames) : retained).map(copyFrame);
    const missing: MissingRange[] = [];

    if (startMs < capturedRange.startMs) {
      missing.push({ reason: 'before-capture', range: { startMs, endMs: Math.min(endMs, capturedRange.startMs) } });
    }
    if (endMs > capturedRange.endMs) {
      missing.push({ reason: 'after-capture', range: { startMs: Math.max(startMs, capturedRange.endMs), endMs } });
    }
    if (availableRange && availableRange.startMs > Math.max(startMs, capturedRange.startMs)) {
      missing.push({
        reason: 'evicted',
        range: {
          startMs: Math.max(startMs, capturedRange.startMs),
          endMs: Math.min(endMs, availableRange.startMs),
        },
      });
    }

    let status: DataStatus;
    if (frames.length && missing.length) status = 'partial';
    else if (frames.length) status = 'available';
    else if (missing.some((entry) => entry.reason === 'evicted')) status = 'evicted';
    else if (missing.every((entry) => entry.reason === 'before-capture')) status = 'nonexistent';
    else status = 'not-yet-captured';

    return {
      status,
      sessionId: this.config.sessionId,
      frames,
      byteCount: frames.reduce((total, frame) => total + frame.byteSize, 0),
      requestedRange,
      availableRange,
      capturedRange,
      missing,
      truncated,
      message: status === 'available'
        ? 'Requested range is retained.'
        : 'Requested range is only partially retained or has gaps.',
    };
  }

  getRegion(
    sessionId: string,
    locator: { readonly sequence: number } | { readonly timestampMs: number; readonly toleranceMs?: number },
    region: PixelRegion,
  ): RegionLookupResult {
    const mismatch = this.sessionProblem(sessionId);
    if (mismatch) {
      return {
        status: mismatch.status,
        sessionId: this.config.sessionId,
        sourceFrame: null,
        region,
        image: null,
        availableRange: null,
        capturedRange: null,
        message: mismatch.message,
      };
    }
    const lookup = 'sequence' in locator
      ? this.getFrameBySequence(sessionId, locator.sequence)
      : this.getFrameAtTimestamp(sessionId, locator.timestampMs, locator.toleranceMs);
    if (lookup.status !== 'available' || !lookup.frame) {
      return {
        status: lookup.status,
        sessionId: this.config.sessionId,
        sourceFrame: null,
        region,
        image: null,
        availableRange: lookup.availableRange,
        capturedRange: lookup.capturedRange,
        message: lookup.message,
      };
    }

    if (!Number.isSafeInteger(region.x) || !Number.isSafeInteger(region.y)
      || !Number.isSafeInteger(region.width) || !Number.isSafeInteger(region.height)
      || region.width < 1 || region.height < 1
      || region.x < 0 || region.y < 0
      || region.x + region.width > lookup.frame.width
      || region.y + region.height > lookup.frame.height) {
      return {
        status: 'region-invalid',
        sessionId: this.config.sessionId,
        sourceFrame: {
          sequence: lookup.frame.sequence,
          timestampMs: lookup.frame.timestampMs,
          width: lookup.frame.width,
          height: lookup.frame.height,
        },
        region,
        image: null,
        availableRange: lookup.availableRange,
        capturedRange: lookup.capturedRange,
        message: 'The requested pixel region is outside the frame.',
      };
    }

    const image = cropRegion(lookup.frame, region);
    return {
      status: 'available',
      sessionId: this.config.sessionId,
      sourceFrame: {
        sequence: lookup.frame.sequence,
        timestampMs: lookup.frame.timestampMs,
        width: lookup.frame.width,
        height: lookup.frame.height,
      },
      region,
      image,
      availableRange: lookup.availableRange,
      capturedRange: lookup.capturedRange,
      message: 'Region is available.',
    };
  }

  stats(): ContextBufferStats {
    return {
      sessionId: this.config.sessionId,
      frameCount: this.frames.length,
      byteCount: this.byteCount,
      maxAgeMs: this.config.maxAgeMs,
      maxBytes: this.config.maxBytes,
      maxFrames: this.config.maxFrames,
      captureIntervalMs: this.captureIntervalMs,
      oldestTimestampMs: this.frames[0]?.timestampMs ?? null,
      latestTimestampMs: this.frames[this.frames.length - 1]?.timestampMs ?? null,
      firstCapturedTimestampMs: this.firstCapturedTimestampMs,
      lastCapturedTimestampMs: this.lastCapturedTimestampMs,
      firstCapturedSequence: this.firstCapturedSequence,
      lastCapturedSequence: this.lastCapturedSequence,
      storedFrames: this.storedFrames,
      evictionCount: this.evictionCount,
      evictedByReason: { ...this.evictedByReason },
      disposed: this.disposed,
    };
  }

  dispose(): void {
    this.frames.length = 0;
    this.byteCount = 0;
    this.disposed = true;
  }

  private evict(nowMs: number): void {
    const cutoff = nowMs - this.config.maxAgeMs;
    while (this.frames.length && this.frames[0].timestampMs < cutoff) {
      this.removeOldest('age');
    }
    while (this.frames.length > this.config.maxFrames) {
      this.removeOldest('frames');
    }
    while (this.byteCount > this.config.maxBytes && this.frames.length) {
      this.removeOldest('bytes');
    }
  }

  private removeOldest(reason: 'age' | 'frames' | 'bytes'): void {
    const removed = this.frames.shift();
    if (!removed) return;
    this.byteCount -= removed.byteSize;
    this.evictionCount += 1;
    this.evictedByReason[reason] += 1;
  }

  private sessionProblem(sessionId: string): FrameLookupResult | null {
    if (this.disposed) return this.emptyLookup('disposed', 'The context buffer has been disposed.');
    if (sessionId !== this.config.sessionId) {
      return {
        status: 'wrong-session',
        sessionId: this.config.sessionId,
        frame: null,
        availableRange: null,
        capturedRange: null,
        message: 'The request belongs to a different buffer session.',
      };
    }
    return null;
  }

  private availableLookup(frame: BufferedFrame): FrameLookupResult {
    return {
      status: 'available',
      sessionId: this.config.sessionId,
      frame: copyFrame(frame),
      availableRange: this.availableRange(),
      capturedRange: this.capturedRange(),
      message: 'Frame is available.',
    };
  }

  private emptyLookup(status: DataStatus, message: string): FrameLookupResult {
    return {
      status,
      sessionId: this.config.sessionId,
      frame: null,
      availableRange: this.availableRange(),
      capturedRange: this.capturedRange(),
      message,
    };
  }

  private rangeFailure(status: DataStatus, requestedRange: TimeRange, message: string): FrameRangeLookupResult {
    return {
      status,
      sessionId: this.config.sessionId,
      frames: [],
      byteCount: 0,
      requestedRange,
      availableRange: this.availableRange(),
      capturedRange: this.capturedRange(),
      missing: [],
      truncated: false,
      message,
    };
  }

  private availableRange(): TimeRange | null {
    if (!this.frames.length) return null;
    return {
      startMs: this.frames[0].timestampMs,
      endMs: this.frames[this.frames.length - 1].timestampMs,
    };
  }

  private capturedRange(): TimeRange | null {
    return rangeOrNull(this.firstCapturedTimestampMs, this.lastCapturedTimestampMs);
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('Cannot offer a frame to a disposed context buffer.');
  }
}

function cropRegion(frame: BufferedFrame, region: PixelRegion): RegionImage {
  const pixels = new Uint8ClampedArray(region.width * region.height * 4);
  const rowBytes = region.width * 4;
  for (let row = 0; row < region.height; row += 1) {
    const sourceStart = ((region.y + row) * frame.width + region.x) * 4;
    pixels.set(frame.pixels.subarray(sourceStart, sourceStart + rowBytes), row * rowBytes);
  }
  return {
    width: region.width,
    height: region.height,
    pixels,
    byteSize: pixels.byteLength,
  };
}
