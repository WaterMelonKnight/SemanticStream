import { context2d, HEIGHT, WIDTH } from './canvas';

const TAU = Math.PI * 2;
const STILL_END_MS = 4_000;
const SLOW_END_MS = 8_500;
const FAST_END_MS = 12_550;
const CYCLE_MS = 13_100;

export type ScenePhase = 'Still' | 'Slow motion' | 'Fast motion' | 'Text event';

function phaseAt(cycleMs: number): ScenePhase {
  if (cycleMs < STILL_END_MS) return 'Still';
  if (cycleMs < SLOW_END_MS) return 'Slow motion';
  if (cycleMs < FAST_END_MS) return 'Fast motion';
  return 'Text event';
}

export class TestScene {
  private readonly background: HTMLCanvasElement;

  constructor() {
    this.background = document.createElement('canvas');
    this.background.width = WIDTH;
    this.background.height = HEIGHT;
    drawBackground(context2d(this.background));
  }

  draw(context: CanvasRenderingContext2D, elapsedMs: number): ScenePhase {
    const cycleMs = elapsedMs % CYCLE_MS;
    const phase = phaseAt(cycleMs);
    context.drawImage(this.background, 0, 0);

    if (phase === 'Slow motion') {
      const progress = (cycleMs - STILL_END_MS) / (SLOW_END_MS - STILL_END_MS);
      drawMarker(context, 354 + progress * 124, 211 - Math.sin(progress * Math.PI) * 42, 29);
    } else if (phase === 'Fast motion') {
      const seconds = (cycleMs - SLOW_END_MS) / 1_000;
      const sweepX = (seconds * 460) % (WIDTH + 280) - 140;
      drawSweep(context, sweepX);
      drawMarker(context, 360 + Math.sin(seconds * 5.4) * 184, 205 + Math.cos(seconds * 8) * 92, 42);
    } else {
      drawMarker(context, 354, 211, 29);
      if (phase === 'Text event') drawEvent(context);
    }
    return phase;
  }
}

function drawBackground(context: CanvasRenderingContext2D): void {
  const background = context.createRadialGradient(365, 185, 9, 365, 185, 450);
  background.addColorStop(0, '#1c1940');
  background.addColorStop(0.6, '#111328');
  background.addColorStop(1, '#0a0b19');
  context.fillStyle = background;
  context.fillRect(0, 0, WIDTH, HEIGHT);

  context.strokeStyle = '#a0a1e116';
  context.beginPath();
  for (let x = 24; x < WIDTH; x += 24) {
    context.moveTo(x + 0.5, 0);
    context.lineTo(x + 0.5, HEIGHT);
  }
  for (let y = 24; y < HEIGHT; y += 24) {
    context.moveTo(0, y + 0.5);
    context.lineTo(WIDTH, y + 0.5);
  }
  context.stroke();

  drawContours(context, 365, 198, 1, 24);
  drawContours(context, 105, 88, 0.47, 16);
  drawContours(context, 625, 338, 0.54, 19);

  context.save();
  context.setLineDash([4, 7]);
  context.strokeStyle = '#c2b7ff65';
  context.beginPath();
  context.moveTo(24, 324);
  context.bezierCurveTo(192, 338, 212, 140, 354, 211);
  context.bezierCurveTo(511, 295, 525, 113, 696, 68);
  context.stroke();
  context.restore();

  context.strokeStyle = '#ac9efa75';
  const landmarks = [[103, 115], [207, 283], [503, 104], [590, 297], [636, 119]];
  for (const [x, y] of landmarks) {
    context.beginPath();
    context.moveTo(x - 5, y);
    context.lineTo(x + 5, y);
    context.moveTo(x, y - 5);
    context.lineTo(x, y + 5);
    context.stroke();
  }

  context.strokeStyle = '#b5a8fc75';
  context.beginPath();
  for (const [x, y, dx, dy] of [[14, 14, 13, 13], [706, 14, -13, 13], [14, 391, 13, -13], [706, 391, -13, -13]]) {
    context.moveTo(x + dx, y);
    context.lineTo(x, y);
    context.lineTo(x, y + dy);
  }
  context.stroke();
}

function drawContours(context: CanvasRenderingContext2D, x: number, y: number, scale: number, count: number): void {
  for (let ring = 0; ring < count; ring += 1) {
    const radius = (34 + ring * 9.2) * scale;
    context.strokeStyle = ring % 5 === 0 ? '#9582e480' : '#8774dd38';
    context.beginPath();
    for (let step = 0; step <= 96; step += 1) {
      const angle = (TAU * step) / 96;
      const distortion = 1 + 0.17 * Math.sin(angle * 3 + ring * 0.10)
        + 0.09 * Math.cos(angle * 5 - ring * 0.16) + 0.035 * Math.sin(angle * 9);
      const contourX = x + Math.cos(angle) * radius * distortion + ring * 1.1 * scale;
      const contourY = y + Math.sin(angle) * radius * distortion * 0.64;
      if (step === 0) context.moveTo(contourX, contourY);
      else context.lineTo(contourX, contourY);
    }
    context.closePath();
    context.stroke();
  }
}

function drawMarker(context: CanvasRenderingContext2D, x: number, y: number, radius: number): void {
  const glow = context.createRadialGradient(x, y, 0, x, y, radius * 2.2);
  glow.addColorStop(0, '#beabff88');
  glow.addColorStop(0.46, '#9d7cff33');
  glow.addColorStop(1, '#9d7cff00');
  context.fillStyle = glow;
  context.fillRect(x - radius * 2.2, y - radius * 2.2, radius * 4.4, radius * 4.4);

  context.strokeStyle = '#b9a8ff95';
  context.beginPath();
  context.arc(x, y, radius, 0, TAU);
  context.stroke();
  context.strokeStyle = '#dacfff';
  context.beginPath();
  context.arc(x, y, radius * 0.35, 0, TAU);
  context.stroke();
  context.fillStyle = '#f4edff';
  context.beginPath();
  context.arc(x, y, 3.2, 0, TAU);
  context.fill();
}

function drawSweep(context: CanvasRenderingContext2D, x: number): void {
  const sweep = context.createLinearGradient(x - 135, 0, x + 135, 0);
  sweep.addColorStop(0, '#9270ff00');
  sweep.addColorStop(0.49, '#a18aff66');
  sweep.addColorStop(0.50, '#d0c1ff90');
  sweep.addColorStop(0.52, '#a18aff33');
  sweep.addColorStop(1, '#9270ff00');
  context.fillStyle = sweep;
  context.fillRect(x - 135, 0, 270, HEIGHT);
}

function drawEvent(context: CanvasRenderingContext2D): void {
  context.fillStyle = '#211740';
  context.fillRect(247, 49, 226, 42);
  context.strokeStyle = '#c8b5ff';
  context.strokeRect(247.5, 49.5, 225, 41);
  context.fillStyle = '#e4d7ff';
  context.font = 'bold 16px monospace';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText('SIGNAL ACQUIRED', 360, 70);
}
