import type { FrameListener, StreamSource } from '../core/stream';
import { context2d } from './canvas';
import { TestScene } from './scene';
import type { ScenePhase } from './scene';

const CAPTURE_INTERVAL_MS = 1_000 / 30;

export interface VisualFrame {
  readonly canvas: HTMLCanvasElement;
  readonly elapsedMs: number;
  readonly phase: ScenePhase;
}

export class ProceduralSource implements StreamSource<VisualFrame> {
  private readonly context: CanvasRenderingContext2D;
  private readonly scene = new TestScene();
  private animationId: number | undefined;
  private origin: number | undefined;
  private nextCapture: number | undefined;
  private sequence = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.context = context2d(canvas, { alpha: false });
  }

  start(listener: FrameListener<VisualFrame>): void {
    if (this.animationId !== undefined) return;

    const capture = (animationTime: number) => {
      this.animationId = requestAnimationFrame(capture);
      const nextCapture = this.nextCapture ?? animationTime;
      if (animationTime < nextCapture) return;

      this.origin ??= animationTime;
      const elapsedMs = animationTime - this.origin;
      const missedSlots = Math.floor((animationTime - nextCapture) / CAPTURE_INTERVAL_MS);
      this.nextCapture = nextCapture + (missedSlots + 1) * CAPTURE_INTERVAL_MS;

      try {
        const phase = this.scene.draw(this.context, elapsedMs);
        listener({
          sequence: ++this.sequence,
          timestampMs: performance.now(),
          payload: { canvas: this.canvas, elapsedMs, phase },
        });
      } catch (error) {
        this.stop();
        throw error;
      }
    };

    this.animationId = requestAnimationFrame(capture);
  }

  stop(): void {
    if (this.animationId === undefined) return;
    cancelAnimationFrame(this.animationId);
    this.animationId = undefined;
  }
}
