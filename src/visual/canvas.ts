import { SAMPLE_HEIGHT, SAMPLE_WIDTH } from '../core/sample';
import type { PixelSample } from '../core/sampling';

export const WIDTH = 720;
export const HEIGHT = 405;

export function context2d(canvas: HTMLCanvasElement, options?: CanvasRenderingContext2DSettings): CanvasRenderingContext2D {
  const context = canvas.getContext('2d', options);
  if (!context) {
    throw new Error('This browser could not start a Canvas 2D context.');
  }
  return context;
}

export class ThumbnailReader {
  private readonly context: CanvasRenderingContext2D;

  constructor() {
    const canvas = document.createElement('canvas');
    canvas.width = SAMPLE_WIDTH;
    canvas.height = SAMPLE_HEIGHT;
    this.context = context2d(canvas, { alpha: false, willReadFrequently: true });
  }

  read(source: HTMLCanvasElement): PixelSample {
    const { context } = this;
    const { width, height } = context.canvas;
    context.drawImage(source, 0, 0, width, height);
    return context.getImageData(0, 0, width, height).data;
  }
}

/** Draw a video into a fixed frame while preserving its aspect ratio. */
export function drawContained(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  width: number,
  height: number,
): void {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  if (!sourceWidth || !sourceHeight) return;
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  context.drawImage(video, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
}
