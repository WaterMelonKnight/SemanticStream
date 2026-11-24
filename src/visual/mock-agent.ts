import type { ContextSink, StreamFrame } from '../core/stream';
import { context2d } from './canvas';
import type { VisualFrame, VisualPhase } from './source';

export interface FrameMetadata {
  readonly sequence: number;
  readonly timestampMs: number;
  readonly elapsedMs: number;
  readonly mediaTimeMs: number | null;
  readonly sessionElapsedMs: number;
  readonly phase: VisualPhase;
}

export class MockAgent implements ContextSink<VisualFrame> {
  private readonly context: CanvasRenderingContext2D;
  private metadata: FrameMetadata | undefined;

  constructor(canvas: HTMLCanvasElement) {
    this.context = context2d(canvas);
    this.context.clearRect(0, 0, canvas.width, canvas.height);
  }

  accept(frame: StreamFrame<VisualFrame>): boolean {
    const { sequence, payload } = frame;
    this.context.drawImage(payload.canvas, 0, 0);
    this.metadata = {
      sequence,
      timestampMs: frame.timestampMs,
      elapsedMs: payload.elapsedMs,
      mediaTimeMs: payload.mediaTimeMs,
      sessionElapsedMs: payload.sessionElapsedMs,
      phase: payload.phase,
    };
    return true;
  }

  latest(): FrameMetadata | undefined {
    return this.metadata;
  }
}
