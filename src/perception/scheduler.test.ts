import { describe, expect, it } from 'vitest';
import { DetectionTrigger } from './scheduler';

describe('detection trigger', () => {
  it('uses a fixed interval for fixed detection', () => {
    const trigger = new DetectionTrigger({ mode: 'fixed', targetFps: 2, periodicMs: 1_500, changeThreshold: 2 });
    expect(trigger.shouldSubmit(0, 0).submit).toBe(true);
    trigger.markSubmitted(0, 0);
    expect(trigger.shouldSubmit(499, 99).submit).toBe(false);
    expect(trigger.shouldSubmit(500, 0).submit).toBe(true);
  });

  it('accepts a change only after the configured minimum interval', () => {
    const trigger = new DetectionTrigger({ mode: 'adaptive', targetFps: 5, periodicMs: 1_500, changeThreshold: 2 });
    expect(trigger.shouldSubmit(0, 0).submit).toBe(true);
    trigger.markSubmitted(0, 0);
    expect(trigger.shouldSubmit(100, 10)).toMatchObject({ submit: false, reason: 'interval' });
    expect(trigger.shouldSubmit(200, 10)).toMatchObject({ submit: true, reason: 'change' });
    trigger.markSubmitted(200, 10);
    expect(trigger.shouldSubmit(300, 0)).toMatchObject({ submit: false, reason: 'below-threshold' });
  });

  it('fires periodically even when the change probe is below threshold', () => {
    const trigger = new DetectionTrigger({ mode: 'adaptive', targetFps: 5, periodicMs: 1_000, changeThreshold: 2 });
    trigger.markSubmitted(0, 0);
    expect(trigger.shouldSubmit(900, 0).submit).toBe(false);
    expect(trigger.shouldSubmit(1_000, 0)).toMatchObject({ submit: true, reason: 'periodic' });
  });

  it('clamps the configured FPS into 2–5', () => {
    const trigger = new DetectionTrigger({ mode: 'fixed', targetFps: 99, periodicMs: 1_500, changeThreshold: 2 });
    expect(trigger.shouldSubmit(0, 0).intervalMs).toBe(200);
  });
});
