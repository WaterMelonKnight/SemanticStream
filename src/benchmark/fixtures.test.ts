import { describe, expect, it } from 'vitest';
import { SAMPLE_HEIGHT, SAMPLE_WIDTH } from '../core/sample';
import { getScenes } from './fixtures';

describe('deterministic benchmark fixtures', () => {
  it('generates the same frames and event annotations on every call', () => {
    const first = getScenes('evaluation');
    const second = getScenes('evaluation');
    expect(first.map((scene) => scene.id)).toEqual(second.map((scene) => scene.id));
    for (let sceneIndex = 0; sceneIndex < first.length; sceneIndex += 1) {
      const left = first[sceneIndex];
      const right = second[sceneIndex];
      expect(left.frames).toHaveLength(right.frames.length);
      expect(left.events).toEqual(right.events);
      for (let frameIndex = 0; frameIndex < left.frames.length; frameIndex += 1) {
        expect(left.frames[frameIndex].sequence).toBe(right.frames[frameIndex].sequence);
        expect(left.frames[frameIndex].timestampMs).toBe(right.frames[frameIndex].timestampMs);
        expect(left.frames[frameIndex].sample).toEqual(right.frames[frameIndex].sample);
      }
    }
  });

  it('uses increasing timestamps, valid RGBA samples, and in-bounds event regions', () => {
    for (const suite of ['tuning', 'evaluation'] as const) {
      for (const scene of getScenes(suite)) {
        expect(scene.frames.length).toBeGreaterThan(0);
        expect(scene.events.length).toBeGreaterThan(0);
        let previous = -Infinity;
        for (const frame of scene.frames) {
          expect(frame.timestampMs).toBeGreaterThan(previous);
          expect(frame.sample).toHaveLength(SAMPLE_WIDTH * SAMPLE_HEIGHT * 4);
          previous = frame.timestampMs;
        }
        for (const event of scene.events) {
          expect(event.endMs).toBeGreaterThan(event.startMs);
          expect(event.region.x).toBeGreaterThanOrEqual(0);
          expect(event.region.y).toBeGreaterThanOrEqual(0);
          expect(event.region.x + event.region.width).toBeLessThanOrEqual(SAMPLE_WIDTH);
          expect(event.region.y + event.region.height).toBeLessThanOrEqual(SAMPLE_HEIGHT);
        }
      }
    }
  });

  it('contains the requested event families and a capture gap with no frames', () => {
    const evaluation = getScenes('evaluation');
    const kinds = new Set(evaluation.flatMap((scene) => scene.events.map((event) => event.kind)));
    expect(kinds).toEqual(new Set(['local-text', 'brief', 'low-contrast', 'slow-change', 'pause-hidden']));
    expect(evaluation.some((scene) => scene.id === 'eval-background-motion')).toBe(true);
    const pause = evaluation.find((scene) => scene.id === 'eval-capture-pause');
    expect(pause).toBeDefined();
    expect(pause?.frames.some((frame) => frame.timestampMs >= 1_700 && frame.timestampMs < 3_000)).toBe(false);
  });
});
