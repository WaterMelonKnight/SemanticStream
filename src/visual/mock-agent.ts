import type { ContextSink, StreamFrame } from '../core/stream';
import { context2d } from './canvas';
import type { ScenePhase } from './scene';
import type { VisualFrame } from './source';

export interface FrameMetadata {
  readonly sequence: number;
  readonly elapsedMs: number;
  readonly phase: ScenePhase;
}

export class MockAgent implements ContextSink<VisualFrame> {
  private readonly context: CanvasRenderingContext2D;
  private metadata: FrameMetadata | undefined;

  constructor(canvas: HTMLCanvasElement) {
    this.context = context2d(canvas);
    this.context.clearRect(0, 0, canvas.width, canvas.height);
  }

  accept({ sequence, payload }: StreamFrame<VisualFrame>): boolean {
    this.context.drawImage(payload.canvas, 0, 0);
    this.metadata = { sequence, elapsedMs: payload.elapsedMs, phase: payload.phase };
    return true;
  }

  latest(): FrameMetadata | undefined {
    return this.metadata;
  }
}
