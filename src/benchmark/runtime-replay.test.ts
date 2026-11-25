import { expect, it } from 'vitest';
import { runRuntimeReplay } from './runtime-replay';

it('replays the same events and scripts with deterministic metrics and non-vacuous stale suppression', () => {
  const report = runRuntimeReplay();
  expect(runRuntimeReplay()).toEqual(report);
  const [serial, fifo, aware, awareSerial] = report.variants;
  for (const variant of report.variants) {
    expect(variant).toMatchObject({
      taskCount: serial.taskCount, peakSlots: variant.slots, peakQueue: report.limits.queue, staleOutputLeaks: 0,
      usage: { tokensProvisional: report.limits.tokensPerTask },
    });
    expect(variant.blockedPartials).toBeGreaterThan(0);
    expect(variant.failures.map(({ event }) => event)).toContain('Depends on superseded parent');
    expect(variant.tasks.find(({ event }) => event === 'Depends on successful parent')?.outcome).toBe('completed');
  }
  expect(fifo.critical.firstOutputDelayMs).toBeNull();
  expect(awareSerial.critical.firstOutputDelayMs).toBeNull();
  expect(aware.critical.firstOutputDelayMs).toBe(20);
  expect(aware.expiries).toBeLessThan(serial.expiries);
  expect(fifo.failures.some(({ reason }) => reason.includes("Rolling request"))).toBe(true);
});
