import { describe, expect, it } from 'vitest';
import { formatBytes, formatClock, formatRate } from './format';

describe('display formatting', () => {
  it('formats media time with tenths and carries rounded seconds', () => {
    expect(formatClock(null)).toBe('—');
    expect(formatClock(0)).toBe('0:00.0');
    expect(formatClock(5_240)).toBe('0:05.2');
    expect(formatClock(59_960)).toBe('1:00.0');
    expect(formatClock(3_600_000)).toBe('1:00:00.0');
  });

  it('formats rates and rejects nonfinite values', () => {
    expect(formatRate(29.94)).toBe('29.9');
    expect(formatRate(Number.NaN)).toBe('—');
  });

  it('formats bounded cache sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1_866_240)).toBe('1.87 MB');
  });
});
