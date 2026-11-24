import type { FrameDecision } from '../core/metrics';
import { TIMELINE_CAPACITY } from '../app/sampling-session';
import type { TimelineEntry } from '../app/sampling-session';
import { context2d } from '../visual/canvas';

const WIDTH = 1_200;
const HEIGHT = 180;
const PADDING = 10;
const LANE_HEIGHT = 70;
const LANE_GAP = 20;

const COLORS: Readonly<Record<FrameDecision, string>> = {
  sent: '#b49aff',
  policy: '#4a465c',
  interval: '#58718a',
  budget: '#c9974e',
  backpressure: '#cf6f7b',
};

/** Draws two fixed-height lanes; the ring buffer keeps the latest entries. */
export function drawDecisionTimeline(canvas: HTMLCanvasElement, entries: readonly TimelineEntry[]): void {
  if (canvas.width !== WIDTH) canvas.width = WIDTH;
  if (canvas.height !== HEIGHT) canvas.height = HEIGHT;
  const context = context2d(canvas, { alpha: false });
  context.fillStyle = '#14131f';
  context.fillRect(0, 0, WIDTH, HEIGHT);

  const usableWidth = WIDTH - PADDING * 2;
  const slotWidth = usableWidth / TIMELINE_CAPACITY;
  const laneTop = [PADDING, PADDING + LANE_HEIGHT + LANE_GAP];
  const laneColorKeys: ReadonlyArray<'adaptive' | 'fixed'> = ['adaptive', 'fixed'];

  context.fillStyle = '#23212f';
  for (const top of laneTop) {
    context.fillRect(PADDING, top, usableWidth, LANE_HEIGHT);
  }

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const x = PADDING + index * slotWidth;
    const width = Math.max(1, slotWidth - 1);
    for (let lane = 0; lane < laneColorKeys.length; lane += 1) {
      context.fillStyle = COLORS[entry[laneColorKeys[lane]]];
      context.fillRect(x, laneTop[lane], width, LANE_HEIGHT);
    }
  }

  const adaptiveSent = entries.filter((entry) => entry.adaptive === 'sent').length;
  const fixedSent = entries.filter((entry) => entry.fixed === 'sent').length;
  canvas.setAttribute(
    'aria-label',
    `Bounded decision timeline showing the latest ${entries.length} of ${TIMELINE_CAPACITY} input frames. `
      + `Adaptive sent ${adaptiveSent} and fixed sent ${fixedSent} in this window.`,
  );
}
