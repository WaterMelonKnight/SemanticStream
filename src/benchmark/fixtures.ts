import { SAMPLE_HEIGHT, SAMPLE_WIDTH } from '../core/sample';
import {
  BENCHMARK_DURATION_MS,
  BENCHMARK_FRAME_RATE,
} from './types';
import type {
  BenchmarkScene,
  BlockRegion,
  EventAnnotation,
  ReplayFrame,
  SceneSuite,
} from './types';

const FRAME_MS = 1_000 / BENCHMARK_FRAME_RATE;
const FULL_FRAME: BlockRegion = { x: 0, y: 0, width: SAMPLE_WIDTH, height: SAMPLE_HEIGHT };

const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  S: ['111', '100', '111', '001', '111'],
  I: ['111', '010', '010', '010', '111'],
  G: ['111', '100', '101', '101', '111'],
  O: ['111', '101', '101', '101', '111'],
  K: ['101', '101', '110', '101', '101'],
  '!': ['010', '010', '010', '000', '010'],
};

function createBaseSample(): Uint8ClampedArray {
  const sample = new Uint8ClampedArray(SAMPLE_WIDTH * SAMPLE_HEIGHT * 4);
  for (let y = 0; y < SAMPLE_HEIGHT; y += 1) {
    for (let x = 0; x < SAMPLE_WIDTH; x += 1) {
      const grid = (x % 12 === 0 ? 4 : 0) + (y % 12 === 0 ? 3 : 0);
      const vignette = Math.floor((6 * x) / SAMPLE_WIDTH + (4 * y) / SAMPLE_HEIGHT);
      const index = (y * SAMPLE_WIDTH + x) * 4;
      sample[index] = 18 + grid + vignette;
      sample[index + 1] = 20 + grid + vignette;
      sample[index + 2] = 34 + grid + vignette;
      sample[index + 3] = 255;
    }
  }
  return sample;
}

const BASE_SAMPLE = createBaseSample();

function putPixel(sample: Uint8ClampedArray, x: number, y: number, rgb: readonly [number, number, number]): void {
  if (x < 0 || y < 0 || x >= SAMPLE_WIDTH || y >= SAMPLE_HEIGHT) return;
  const index = (y * SAMPLE_WIDTH + x) * 4;
  sample[index] = rgb[0];
  sample[index + 1] = rgb[1];
  sample[index + 2] = rgb[2];
  sample[index + 3] = 255;
}

function addToPixel(sample: Uint8ClampedArray, x: number, y: number, delta: number): void {
  const index = (y * SAMPLE_WIDTH + x) * 4;
  sample[index] = Math.min(255, Math.max(0, sample[index] + delta));
  sample[index + 1] = Math.min(255, Math.max(0, sample[index + 1] + delta));
  sample[index + 2] = Math.min(255, Math.max(0, sample[index + 2] + delta));
}

function drawText(
  sample: Uint8ClampedArray,
  region: BlockRegion,
  text: string,
  rgb: readonly [number, number, number],
): void {
  let cursorX = region.x + 1;
  for (const character of text) {
    const glyph = GLYPHS[character];
    if (!glyph) continue;
    for (let row = 0; row < glyph.length; row += 1) {
      for (let column = 0; column < glyph[row].length; column += 1) {
        if (glyph[row][column] === '1') {
          putPixel(sample, cursorX + column, region.y + 1 + row, rgb);
        }
      }
    }
    cursorX += 4;
  }
}

function shadeRegion(sample: Uint8ClampedArray, region: BlockRegion, delta: number): void {
  for (let y = region.y; y < region.y + region.height; y += 1) {
    for (let x = region.x; x < region.x + region.width; x += 1) {
      addToPixel(sample, x, y, delta);
    }
  }
}

function paintTextEvents(
  events: readonly EventAnnotation[],
  rgb: readonly [number, number, number],
): (sample: Uint8ClampedArray, timeMs: number) => void {
  return (sample, timeMs) => {
    for (const event of events) {
      if (timeMs >= event.startMs && timeMs < event.endMs && event.text) {
        drawText(sample, event.region, event.text, rgb);
      }
    }
  };
}

function buildScene(spec: {
  readonly id: string;
  readonly suite: SceneSuite;
  readonly description: string;
  readonly events: readonly EventAnnotation[];
  readonly paint: (sample: Uint8ClampedArray, timeMs: number) => void;
  readonly pause?: { readonly startMs: number; readonly endMs: number };
}): BenchmarkScene {
  const frames: ReplayFrame[] = [];
  let sequence = 0;
  for (let index = 0; index * FRAME_MS < BENCHMARK_DURATION_MS; index += 1) {
    const timeMs = Math.round(index * FRAME_MS * 1_000) / 1_000;
    if (spec.pause && timeMs >= spec.pause.startMs && timeMs < spec.pause.endMs) continue;
    const sample = new Uint8ClampedArray(BASE_SAMPLE);
    spec.paint(sample, timeMs);
    frames.push({ sequence: ++sequence, timestampMs: timeMs, sample });
  }
  return {
    id: spec.id,
    suite: spec.suite,
    description: spec.description,
    frames,
    events: spec.events,
  };
}

function localTextScene(suite: SceneSuite): BenchmarkScene {
  const tuning = suite === 'tuning';
  const events: EventAnnotation[] = tuning
    ? [
        { id: 'tune-local-a', kind: 'local-text', startMs: 1_600, endMs: 2_200, region: { x: 36, y: 22, width: 12, height: 8 }, description: 'Small high-contrast text in a quiet corner.', text: 'SIG' },
        { id: 'tune-local-b', kind: 'local-text', startMs: 3_600, endMs: 4_200, region: { x: 56, y: 34, width: 12, height: 8 }, description: 'Second local text event at a different position.', text: 'OK' },
      ]
    : [
        { id: 'eval-local-a', kind: 'local-text', startMs: 1_800, endMs: 2_400, region: { x: 44, y: 24, width: 12, height: 8 }, description: 'Small high-contrast text in a quiet corner.', text: 'SIG' },
        { id: 'eval-local-b', kind: 'local-text', startMs: 4_200, endMs: 4_800, region: { x: 22, y: 38, width: 12, height: 8 }, description: 'Second local text event at a different position.', text: 'OK' },
      ];
  return buildScene({
    id: tuning ? 'tune-local-text' : 'eval-local-text',
    suite,
    description: 'Two brief high-contrast text changes that occupy less than 1% of the frame.',
    events,
    paint: paintTextEvents(events, [242, 238, 252]),
  });
}

function briefScene(suite: SceneSuite): BenchmarkScene {
  const tuning = suite === 'tuning';
  const events: EventAnnotation[] = tuning
    ? [
        { id: 'tune-brief-a', kind: 'brief', startMs: 1_800, endMs: 1_900, region: { x: 40, y: 20, width: 8, height: 6 }, description: 'One-hundred-millisecond local glyph.', text: '!' },
        { id: 'tune-brief-b', kind: 'brief', startMs: 3_800, endMs: 3_900, region: { x: 60, y: 30, width: 8, height: 6 }, description: 'Second short local glyph.', text: '!' },
      ]
    : [
        { id: 'eval-brief-a', kind: 'brief', startMs: 2_200, endMs: 2_300, region: { x: 50, y: 18, width: 8, height: 6 }, description: 'One-hundred-millisecond local glyph.', text: '!' },
        { id: 'eval-brief-b', kind: 'brief', startMs: 4_400, endMs: 4_500, region: { x: 16, y: 32, width: 8, height: 6 }, description: 'Second short local glyph.', text: '!' },
      ];
  return buildScene({
    id: tuning ? 'tune-brief' : 'eval-brief',
    suite,
    description: 'Two 100 ms local events, shorter than the 125 ms delivery spacing.',
    events,
    paint: paintTextEvents(events, [250, 250, 250]),
  });
}

function lowContrastScene(suite: SceneSuite): BenchmarkScene {
  const tuning = suite === 'tuning';
  const events: EventAnnotation[] = tuning
    ? [
        { id: 'tune-low-a', kind: 'low-contrast', startMs: 1_600, endMs: 2_300, region: { x: 28, y: 18, width: 16, height: 10 }, description: 'Low-contrast region change of 10 RGB levels.' },
        { id: 'tune-low-b', kind: 'low-contrast', startMs: 3_600, endMs: 4_300, region: { x: 50, y: 30, width: 16, height: 10 }, description: 'Second low-contrast region.' },
      ]
    : [
        { id: 'eval-low-a', kind: 'low-contrast', startMs: 1_800, endMs: 2_500, region: { x: 24, y: 20, width: 16, height: 10 }, description: 'Low-contrast region change of 12 RGB levels.' },
        { id: 'eval-low-b', kind: 'low-contrast', startMs: 4_300, endMs: 5_000, region: { x: 54, y: 28, width: 16, height: 10 }, description: 'Second low-contrast region.' },
      ];
  const delta = tuning ? 10 : 12;
  return buildScene({
    id: tuning ? 'tune-low-contrast' : 'eval-low-contrast',
    suite,
    description: `Two low-contrast local changes (+${delta} RGB) spread across a 16×10 region.`,
    events,
    paint: (sample, timeMs) => {
      for (const event of events) {
        if (timeMs >= event.startMs && timeMs < event.endMs) shadeRegion(sample, event.region, delta);
      }
    },
  });
}

function slowScene(suite: SceneSuite): BenchmarkScene {
  const tuning = suite === 'tuning';
  const startMs = tuning ? 1_400 : 1_500;
  const endMs = tuning ? 4_800 : 5_000;
  const events: EventAnnotation[] = [
    {
      id: tuning ? 'tune-slow' : 'eval-slow',
      kind: 'slow-change',
      startMs,
      endMs,
      region: FULL_FRAME,
      description: 'Whole-frame brightness ramp over several seconds.',
    },
  ];
  return buildScene({
    id: tuning ? 'tune-slow-change' : 'eval-slow-change',
    suite,
    description: 'A slow whole-frame brightness ramp that accumulates against the last accepted frame.',
    events,
    paint: (sample, timeMs) => {
      if (timeMs < startMs || timeMs >= endMs) return;
      const progress = (timeMs - startMs) / (endMs - startMs);
      shadeRegion(sample, FULL_FRAME, Math.round(20 * progress));
    },
  });
}

function motionScene(suite: SceneSuite): BenchmarkScene {
  const tuning = suite === 'tuning';
  const event: EventAnnotation = {
    id: tuning ? 'tune-motion-text' : 'eval-motion-text',
    kind: 'local-text',
    startMs: tuning ? 3_000 : 4_200,
    endMs: tuning ? 3_400 : 4_600,
    region: { x: 60, y: 30, width: 12, height: 8 },
    description: 'A small text event while an irrelevant bright object moves through another region.',
    text: 'OK',
  };
  return buildScene({
    id: tuning ? 'tune-background-motion' : 'eval-background-motion',
    suite,
    description: 'Irrelevant background motion crosses the frame while one small local event occurs.',
    events: [event],
    paint: (sample, timeMs) => {
      const x = Math.round(-24 + (timeMs / BENCHMARK_DURATION_MS) * (SAMPLE_WIDTH + 48));
      for (let y = 8; y < 26; y += 1) {
        for (let column = x; column < x + 18; column += 1) {
          putPixel(sample, column, y, [210, 198, 255]);
        }
      }
      if (timeMs >= event.startMs && timeMs < event.endMs && event.text) {
        drawText(sample, event.region, event.text, [246, 242, 255]);
      }
    },
  });
}

function pauseScene(suite: SceneSuite): BenchmarkScene {
  const tuning = suite === 'tuning';
  const pause = tuning
    ? { startMs: 1_800, endMs: 3_200 }
    : { startMs: 1_700, endMs: 3_000 };
  const events: EventAnnotation[] = tuning
    ? [
        { id: 'tune-pause-hidden', kind: 'pause-hidden', startMs: 2_200, endMs: 2_800, region: { x: 40, y: 24, width: 12, height: 8 }, description: 'Event entirely inside a capture pause; no input frame can observe it.', text: 'SIG' },
        { id: 'tune-pause-visible', kind: 'local-text', startMs: 4_600, endMs: 5_200, region: { x: 20, y: 36, width: 12, height: 8 }, description: 'Visible local text event after capture resumes.', text: 'OK' },
      ]
    : [
        { id: 'eval-pause-hidden', kind: 'pause-hidden', startMs: 2_000, endMs: 2_600, region: { x: 44, y: 26, width: 12, height: 8 }, description: 'Event entirely inside a capture pause; no input frame can observe it.', text: 'SIG' },
        { id: 'eval-pause-visible', kind: 'local-text', startMs: 4_600, endMs: 5_200, region: { x: 24, y: 34, width: 12, height: 8 }, description: 'Visible local text event after capture resumes.', text: 'OK' },
      ];
  return buildScene({
    id: tuning ? 'tune-capture-pause' : 'eval-capture-pause',
    suite,
    description: 'A 1.2–1.3 second capture gap hides one event and a later event remains visible.',
    events,
    pause,
    paint: paintTextEvents(events, [242, 238, 252]),
  });
}

export function getScenes(suite: SceneSuite): BenchmarkScene[] {
  return suite === 'tuning'
    ? [localTextScene('tuning'), briefScene('tuning'), lowContrastScene('tuning'), slowScene('tuning'), motionScene('tuning'), pauseScene('tuning')]
    : [localTextScene('evaluation'), briefScene('evaluation'), lowContrastScene('evaluation'), slowScene('evaluation'), motionScene('evaluation'), pauseScene('evaluation')];
}
