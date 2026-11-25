import type { RuntimeClock } from '../inference/types';

interface Alarm {
  readonly at: number;
  readonly callback: () => void;
}

/** Logical timers run in time order, with registration order resolving ties. */
export class ReplayClock implements RuntimeClock {
  private time = 0;
  private readonly alarms = new Set<Alarm>();

  now(): number {
    return this.time;
  }

  after(delayMs: number, callback: () => void): () => void {
    const alarm = { at: this.time + delayMs, callback };
    this.alarms.add(alarm);
    return () => { this.alarms.delete(alarm); };
  }

  advance(to: number): void {
    if (!Number.isFinite(to) || to < this.time) throw new RangeError('Replay time must be finite and monotonic');
    for (;;) {
      let next: Alarm | undefined;
      for (const alarm of this.alarms) {
        if (alarm.at <= to && (!next || alarm.at < next.at)) next = alarm;
      }
      if (!next) break;
      this.time = next.at;
      this.alarms.delete(next);
      next.callback();
    }
    this.time = to;
  }
}
