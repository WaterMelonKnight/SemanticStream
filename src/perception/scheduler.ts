import type { DetectionMode, TriggerConfig, TriggerDecision } from './types';

export const MIN_DETECTION_FPS = 2;
export const MAX_DETECTION_FPS = 5;
export const ADAPTIVE_PERIODIC_MS = 1_500;

export function clampDetectionFps(value: number): number {
  return Math.max(MIN_DETECTION_FPS, Math.min(MAX_DETECTION_FPS, value));
}

/**
 * Fixed mode submits on a regular interval. Adaptive mode submits on a coarse
 * change signal OR a periodic floor, so it never relies only on frame diff.
 * Both modes are rate-limited by the configured detection FPS.
 */
export class DetectionTrigger {
  private config: TriggerConfig;
  private lastSubmittedAtMs: number | null = null;
  private lastSubmittedChange: number | null = null;

  constructor(config: TriggerConfig) {
    this.config = normalizeConfig(config);
  }

  get state(): { lastSubmittedAtMs: number | null; lastSubmittedChange: number | null } {
    return { lastSubmittedAtMs: this.lastSubmittedAtMs, lastSubmittedChange: this.lastSubmittedChange };
  }

  setConfig(config: TriggerConfig): void {
    this.config = normalizeConfig(config);
  }

  reset(): void {
    this.lastSubmittedAtMs = null;
    this.lastSubmittedChange = null;
  }

  shouldSubmit(timestampMs: number, changePercent: number): TriggerDecision {
    const intervalMs = 1_000 / this.config.targetFps;
    if (this.lastSubmittedAtMs === null) {
      return { submit: true, reason: this.config.mode === 'fixed' ? 'fixed' : 'change', intervalMs };
    }
    const elapsed = timestampMs - this.lastSubmittedAtMs;
    if (this.config.mode === 'fixed') {
      return elapsed >= intervalMs
        ? { submit: true, reason: 'fixed', intervalMs }
        : { submit: false, reason: 'interval', intervalMs };
    }
    if (elapsed >= this.config.periodicMs) {
      return { submit: true, reason: 'periodic', intervalMs };
    }
    if (changePercent >= this.config.changeThreshold) {
      return elapsed >= intervalMs
        ? { submit: true, reason: 'change', intervalMs }
        : { submit: false, reason: 'interval', intervalMs };
    }
    return { submit: false, reason: 'below-threshold', intervalMs };
  }

  markSubmitted(timestampMs: number, changePercent: number): void {
    this.lastSubmittedAtMs = timestampMs;
    this.lastSubmittedChange = changePercent;
  }

  get mode(): DetectionMode {
    return this.config.mode;
  }
}

function normalizeConfig(config: TriggerConfig): TriggerConfig {
  return {
    mode: config.mode,
    targetFps: clampDetectionFps(config.targetFps),
    periodicMs: Math.max(250, Math.min(10_000, config.periodicMs)),
    changeThreshold: Math.max(0, Math.min(100, config.changeThreshold)),
  };
}
