import { describe, expect, it } from 'vitest';
import { BoundedTimeline } from './timeline';

describe('bounded timeline', () => {
  it('keeps insertion order while there is room', () => {
    const timeline = new BoundedTimeline<number>(3);
    timeline.push(1);
    timeline.push(2);
    expect(timeline.size).toBe(2);
    expect(timeline.toArray()).toEqual([1, 2]);
  });

  it('overwrites the oldest entries at capacity and never grows beyond it', () => {
    const timeline = new BoundedTimeline<number>(3);
    for (const value of [1, 2, 3, 4, 5]) timeline.push(value);
    expect(timeline.size).toBe(3);
    expect(timeline.toArray()).toEqual([3, 4, 5]);
  });

  it('clears entries and capacity validation rejects bad sizes', () => {
    const timeline = new BoundedTimeline<string>(2);
    timeline.push('a');
    timeline.clear();
    expect(timeline.size).toBe(0);
    expect(timeline.toArray()).toEqual([]);
    expect(() => new BoundedTimeline(0)).toThrow(RangeError);
    expect(() => new BoundedTimeline(1.5)).toThrow(RangeError);
  });
});
