import { describe, expect, it } from 'vitest';
import { isCurrentDetectionResult } from './session';

describe('perception session guard', () => {
  it('rejects late results from an expired request or session', () => {
    expect(isCurrentDetectionResult({ requestId: 7, sessionId: 'perception-camera-2' }, { requestId: 7 }, 'perception-camera-2')).toBe(true);
    expect(isCurrentDetectionResult({ requestId: 6, sessionId: 'perception-camera-1' }, { requestId: 7 }, 'perception-camera-2')).toBe(false);
    expect(isCurrentDetectionResult({ requestId: 7, sessionId: 'perception-camera-1' }, { requestId: 7 }, 'perception-camera-2')).toBe(false);
    expect(isCurrentDetectionResult({ requestId: 7, sessionId: 'perception-camera-2' }, undefined, 'perception-camera-2')).toBe(false);
  });
});
