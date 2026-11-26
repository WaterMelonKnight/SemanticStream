import type { ModelBox, SourceTransform } from './types';

export function createSourceTransform(
  sourceWidth: number,
  sourceHeight: number,
  modelWidth: number,
  modelHeight: number,
): SourceTransform {
  if (!(sourceWidth > 0) || !(sourceHeight > 0) || !(modelWidth > 0) || !(modelHeight > 0)) {
    throw new RangeError('Source and model dimensions must be positive.');
  }
  const scale = Math.min(modelWidth / sourceWidth, modelHeight / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  return {
    sourceWidth,
    sourceHeight,
    modelWidth,
    modelHeight,
    scale,
    offsetX: (modelWidth - drawWidth) / 2,
    offsetY: (modelHeight - drawHeight) / 2,
  };
}

export function drawLetterboxed(
  context: CanvasRenderingContext2D,
  source: CanvasImageSource,
  transform: SourceTransform,
): void {
  context.fillStyle = '#000';
  context.fillRect(0, 0, transform.modelWidth, transform.modelHeight);
  contextsDraw(context, source, transform);
}

function contextsDraw(context: CanvasRenderingContext2D, source: CanvasImageSource, transform: SourceTransform): void {
  const drawWidth = transform.sourceWidth * transform.scale;
  const drawHeight = transform.sourceHeight * transform.scale;
  context.drawImage(source, transform.offsetX, transform.offsetY, drawWidth, drawHeight);
}

export function mapModelBoxToSource(box: ModelBox, transform: SourceTransform): ModelBox {
  const x = (box.x - transform.offsetX) / transform.scale;
  const y = (box.y - transform.offsetY) / transform.scale;
  const width = box.width / transform.scale;
  const height = box.height / transform.scale;
  const left = Math.max(0, Math.min(transform.sourceWidth, x));
  const top = Math.max(0, Math.min(transform.sourceHeight, y));
  const right = Math.max(0, Math.min(transform.sourceWidth, x + width));
  const bottom = Math.max(0, Math.min(transform.sourceHeight, y + height));
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

export function boxArea(box: ModelBox): number {
  return Math.max(0, box.width) * Math.max(0, box.height);
}
