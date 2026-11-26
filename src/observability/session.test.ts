import { describe, expect, it } from 'vitest';
import { isCurrentRuntimeSession, runtimeSessionId } from './session';

describe('runtime telemetry session identity', () => {
  it('rejects records from a prior runtime session', () => {
    expect(isCurrentRuntimeSession(4, 4)).toBe(true);
    expect(isCurrentRuntimeSession(3, 4)).toBe(false);
    expect(runtimeSessionId(4)).toBe('runtime-4');
  });
});
