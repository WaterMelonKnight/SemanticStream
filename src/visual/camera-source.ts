import type { FrameListener } from '../core/stream';
import { context2d, drawContained } from './canvas';
import type { VisualFrame } from './source';

/** Owns the permission request, all acquired tracks and the capture callback. */
export class CameraSource {
  private readonly context: CanvasRenderingContext2D;
  private stream: MediaStream | undefined;
  private frame: number | undefined;
  private disposed = false;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly canvas: HTMLCanvasElement,
    private readonly onEnded: (message: string) => void,
  ) {
    this.context = context2d(canvas, { alpha: false });
  }

  async start(listener: FrameListener<VisualFrame>): Promise<void> {
    if (this.disposed) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Camera is unavailable here. Use HTTPS or localhost in a browser with camera support.');
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 720 }, height: { ideal: 405 } }, audio: false,
    });
    if (this.disposed) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    this.stream = stream;
    for (const track of stream.getVideoTracks()) track.addEventListener('ended', this.ended);
    this.video.srcObject = stream;
    try {
      await this.video.play();
    } catch (error) {
      if (this.disposed) return;
      this.dispose();
      throw error;
    }
    if (this.disposed) return;

    const origin = performance.now();
    let sequence = 0;
    let lastMediaTime = -1;
    const capture = () => {
      if (this.disposed) return;
      const mediaTime = this.video.currentTime;
      if (this.video.readyState >= 2 && mediaTime !== lastMediaTime) {
        lastMediaTime = mediaTime;
        this.context.fillStyle = '#080c13';
        this.context.fillRect(0, 0, this.canvas.width, this.canvas.height);
        drawContained(this.context, this.video, this.canvas.width, this.canvas.height);
        const timestampMs = performance.now();
        listener({
          sequence: ++sequence, timestampMs,
          payload: {
            canvas: this.canvas, mediaTimeMs: null,
            elapsedMs: timestampMs - origin, sessionElapsedMs: timestampMs - origin, phase: 'Camera',
          },
        });
      }
      if (!this.disposed) this.frame = requestAnimationFrame(capture);
    };
    this.frame = requestAnimationFrame(capture);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    for (const track of this.stream?.getTracks() ?? []) {
      track.removeEventListener('ended', this.ended);
      track.stop();
    }
    if (this.stream && this.video.srcObject === this.stream) {
      this.video.pause();
      this.video.srcObject = null;
    }
    this.stream = undefined;
  }

  private readonly ended = () => {
    this.dispose();
    this.onEnded('Camera stream ended.');
  };
}
