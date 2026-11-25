import type { FrameListener, StreamSource } from '../core/stream';
import { context2d } from './canvas';
import type { VisualFrame } from './source';

/** A local synthetic monitor with intentionally separate, operator-authored event metadata. */
export class MonitorSource implements StreamSource<VisualFrame> {
  private readonly context: CanvasRenderingContext2D;
  private timer: number | undefined;
  private normalChanges = 0;
  private incident = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.context = context2d(canvas, { alpha: false });
  }

  trigger(critical: boolean): void {
    this.incident = critical;
    if (!critical) this.normalChanges += 1;
  }

  start(listener: FrameListener<VisualFrame>): void {
    if (this.timer !== undefined) return;
    const origin = performance.now();
    let sequence = 0;
    this.timer = window.setInterval(() => {
      this.draw();
      const timestampMs = performance.now();
      listener({
        sequence: ++sequence, timestampMs,
        payload: {
          canvas: this.canvas, mediaTimeMs: null, elapsedMs: timestampMs - origin,
          sessionElapsedMs: timestampMs - origin, phase: 'Monitor',
        },
      });
    }, 1_000 / 30);
  }

  stop(): void {
    window.clearInterval(this.timer);
    this.timer = undefined;
  }

  private draw(): void {
    const { context: ctx, canvas } = this;
    const colors = this.incident
      ? { tint: '#ff7579', chart: '#742d3c', headline: 'CRITICAL · DB replica offline' }
      : { tint: '#73e0c0', chart: '#123b3c', headline: 'Healthy · All replicas online' };
    ctx.fillStyle = '#0a1321';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#a8b9ce';
    ctx.font = '16px monospace';
    ctx.fillText('SIMULATED TELEMETRY / SERVICE HEALTH', 32, 48);
    ctx.fillStyle = colors.tint;
    ctx.font = 'bold 31px system-ui';
    ctx.fillText(colors.headline, 32, 100);
    ctx.fillStyle = colors.chart;
    ctx.fillRect(32, 136, 656, 223);
    for (let index = 0; index < 24; index += 1) {
      const height = this.incident && index > 16 ? 180 - (index % 3) * 12
        : 26 + ((index * 17 + this.normalChanges * 19) % 79);
      ctx.fillStyle = colors.tint;
      ctx.fillRect(52 + index * 26, 337 - height, 15, height);
    }
    ctx.fillStyle = '#a8b9ce';
    ctx.font = '13px monospace';
    ctx.fillText('REQUEST LOAD · REVISION ' + this.normalChanges, 32, 384);
  }
}
