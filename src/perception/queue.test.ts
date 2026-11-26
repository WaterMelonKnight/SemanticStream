import { describe, expect, it } from 'vitest';
import { LatestFrameQueue } from './queue';

describe('latest frame queue', () => {
  it('keeps at most one pending frame and reports replacement', () => {
    const queue = new LatestFrameQueue<number>();
    expect(queue.tryEnqueue(1)).toEqual({ accepted: true, dropped: 0 });
    expect(queue.tryEnqueue(2)).toEqual({ accepted: true, dropped: 0 });
    expect(queue.tryEnqueue(3)).toEqual({ accepted: true, dropped: 1 });
    expect(queue.takePending()).toBe(3);
    expect(queue.takePending()).toBeNull();
    queue.complete();
    expect(queue.tryEnqueue(4)).toEqual({ accepted: true, dropped: 0 });
  });

  it('clears a session without retaining stale pending work', () => {
    const queue = new LatestFrameQueue<string>();
    queue.tryEnqueue('a');
    queue.tryEnqueue('b');
    queue.clear();
    expect(queue.inFlight).toBe(false);
    expect(queue.pending).toBeNull();
  });
});
