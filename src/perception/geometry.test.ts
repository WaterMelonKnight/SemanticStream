import { describe, expect, it } from 'vitest';
import { boxArea, createSourceTransform, mapModelBoxToSource } from './geometry';

describe('perception geometry', () => {
  it('letterboxes a 16:9 source into a square model input', () => {
    const transform = createSourceTransform(720, 405, 320, 320);
    expect(transform.scale).toBeCloseTo(320 / 720, 6);
    expect(transform.offsetX).toBeCloseTo(0, 6);
    expect(transform.offsetY).toBeCloseTo((320 - 405 * (320 / 720)) / 2, 6);
  });

  it('maps model-space boxes back to source pixels and clamps to the frame', () => {
    const transform = createSourceTransform(720, 405, 320, 320);
    const box = mapModelBoxToSource({ x: 30, y: 90, width: 100, height: 50 }, transform);
    expect(box.width).toBeCloseTo(100 / transform.scale, 4);
    expect(box.height).toBeCloseTo(50 / transform.scale, 4);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(720.001);
    expect(box.y + box.height).toBeLessThanOrEqual(405.001);
    expect(boxArea(box)).toBeGreaterThan(0);
  });

  it('clamps boxes that extend outside the model input', () => {
    const transform = createSourceTransform(100, 100, 320, 320);
    expect(mapModelBoxToSource({ x: -20, y: -20, width: 400, height: 400 }, transform))
      .toEqual({ x: 0, y: 0, width: 100, height: 100 });
  });
});
