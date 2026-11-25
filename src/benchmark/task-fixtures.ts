import { SAMPLE_HEIGHT, SAMPLE_WIDTH } from '../core/sample';
import type { TaskDefinition } from '../decision/types';
import { buildScene, drawText } from './fixtures';
import type { BenchmarkScene, EventAnnotation } from './types';

const FULL_FRAME = { x: 0, y: 0, width: SAMPLE_WIDTH, height: SAMPLE_HEIGHT };

export const TASKS_BY_SCENE: Readonly<Record<string, TaskDefinition>> = {
  'eval-local-text': {
    id: 'read-status',
    label: 'Read the status text',
    category: 'text-reading',
    priority: 'high',
    roi: { x: 20, y: 20, width: 56, height: 26 },
  },
  'eval-brief': {
    id: 'catch-brief-status',
    label: 'Catch a brief status flash',
    category: 'text-reading',
    priority: 'high',
    roi: { x: 12, y: 14, width: 56, height: 26 },
  },
  'eval-low-contrast': {
    id: 'detect-subtle-panel',
    label: 'Detect a subtle panel change',
    category: 'general-inspection',
    priority: 'normal',
    roi: { x: 20, y: 16, width: 52, height: 24 },
  },
  'eval-slow-change': {
    id: 'monitor-illumination',
    label: 'Monitor illumination drift',
    category: 'motion-monitoring',
    priority: 'normal',
    roi: FULL_FRAME,
  },
  'eval-background-motion': {
    id: 'read-roi-while-moving',
    label: 'Read the ROI while the background moves',
    category: 'text-reading',
    priority: 'high',
    roi: { x: 56, y: 26, width: 20, height: 14 },
  },
  'eval-capture-pause': {
    id: 'read-after-gap',
    label: 'Read the status after a capture gap',
    category: 'text-reading',
    priority: 'high',
    roi: { x: 16, y: 18, width: 56, height: 28 },
  },
  'task-random-roi': {
    id: 'random-roi-watch',
    label: 'Watch a predeclared random ROI',
    category: 'general-inspection',
    priority: 'high',
    roi: { x: 30, y: 18, width: 36, height: 22 },
  },
  'task-repeated': {
    id: 'repeated-status-watch',
    label: 'Watch repeated status changes',
    category: 'text-reading',
    priority: 'normal',
    roi: { x: 38, y: 18, width: 20, height: 14 },
  },
  'task-overlap': {
    id: 'overlap-priority',
    label: 'Prioritize an overlapping ROI event',
    category: 'text-reading',
    priority: 'high',
    roi: { x: 18, y: 18, width: 24, height: 16 },
  },
};

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function fillRect(sample: Uint8ClampedArray, x: number, y: number, width: number, height: number): void {
  for (let row = y; row < y + height; row += 1) {
    for (let column = x; column < x + width; column += 1) {
      if (column < 0 || row < 0 || column >= SAMPLE_WIDTH || row >= SAMPLE_HEIGHT) continue;
      const index = (row * SAMPLE_WIDTH + column) * 4;
      sample[index] = 214;
      sample[index + 1] = 202;
      sample[index + 2] = 255;
      sample[index + 3] = 255;
    }
  }
}

function randomRoiScene(): BenchmarkScene {
  const random = seeded(7);
  const roi = TASKS_BY_SCENE['task-random-roi'].roi!;
  const events: EventAnnotation[] = [
    {
      id: 'random-roi-a',
      kind: 'local-text',
      startMs: 1_600 + Math.round(random() * 300),
      endMs: 2_100 + Math.round(random() * 300),
      region: {
        x: roi.x + Math.round(random() * (roi.width - 14)),
        y: roi.y + Math.round(random() * (roi.height - 8)),
        width: 12,
        height: 8,
      },
      description: 'Deterministic random text event inside the declared ROI.',
      text: 'SIG',
    },
    {
      id: 'random-roi-b',
      kind: 'local-text',
      startMs: 3_700 + Math.round(random() * 300),
      endMs: 4_200 + Math.round(random() * 300),
      region: {
        x: roi.x + Math.round(random() * (roi.width - 14)),
        y: roi.y + Math.round(random() * (roi.height - 8)),
        width: 12,
        height: 8,
      },
      description: 'Second deterministic random text event inside the declared ROI.',
      text: 'OK',
    },
  ];
  return buildScene({
    id: 'task-random-roi',
    suite: 'evaluation',
    description: 'Deterministic seeded positions and timings inside a predeclared task ROI.',
    events,
    paint: (sample, timeMs) => {
      for (const event of events) {
        if (timeMs >= event.startMs && timeMs < event.endMs) drawText(sample, event.region, event.text ?? 'SIG', [245, 240, 255]);
      }
      const x = Math.round(20 + (timeMs / 6_000) * 40);
      fillRect(sample, x, 44, 12, 7);
    },
  });
}

function repeatedScene(): BenchmarkScene {
  const roi = TASKS_BY_SCENE['task-repeated'].roi!;
  const events: EventAnnotation[] = [1_500, 1_900, 2_300, 2_700, 3_100].map((startMs, index) => ({
    id: `repeated-${index + 1}`,
    kind: 'local-text' as const,
    startMs,
    endMs: startMs + 260,
    region: roi,
    description: 'Repeated identical text event for suppression analysis.',
    text: 'OK',
  }));
  return buildScene({
    id: 'task-repeated',
    suite: 'evaluation',
    description: 'Five repeated identical text events inside the task ROI.',
    events,
    paint: (sample, timeMs) => {
      for (const event of events) {
        if (timeMs >= event.startMs && timeMs < event.endMs) drawText(sample, event.region, 'OK', [242, 238, 252]);
      }
    },
  });
}

function overlapScene(): BenchmarkScene {
  const roi = TASKS_BY_SCENE['task-overlap'].roi!;
  const events: EventAnnotation[] = [
    { id: 'overlap-roi', kind: 'local-text', startMs: 1_800, endMs: 2_600, region: roi, description: 'ROI text event overlapping a distractor.', text: 'SIG' },
    { id: 'overlap-distractor', kind: 'local-text', startMs: 2_000, endMs: 2_400, region: { x: 62, y: 32, width: 12, height: 8 }, description: 'Distractor text outside the task ROI.', text: 'OK' },
  ];
  return buildScene({
    id: 'task-overlap',
    suite: 'evaluation',
    description: 'Two overlapping text events: one inside the declared ROI and one outside.',
    events,
    paint: (sample, timeMs) => {
      for (const event of events) {
        if (timeMs >= event.startMs && timeMs < event.endMs) drawText(sample, event.region, event.text ?? 'SIG', [244, 240, 255]);
      }
      const x = Math.round(-24 + (timeMs / 6_000) * (SAMPLE_WIDTH + 48));
      fillRect(sample, x, 7, 16, 7);
    },
  });
}

export function getTaskScenes(): BenchmarkScene[] {
  return [randomRoiScene(), repeatedScene(), overlapScene()];
}

export function getTaskForScene(sceneId: string): TaskDefinition {
  const task = TASKS_BY_SCENE[sceneId];
  if (!task) throw new Error(`No task declaration for scene ${sceneId}`);
  return task;
}
