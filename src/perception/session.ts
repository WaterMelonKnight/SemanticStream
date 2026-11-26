import type { DetectionRequest, DetectionResponse } from './types';

/** A detection result is usable only for the live request and live session. */
export function isCurrentDetectionResult(
  result: Pick<DetectionResponse, 'requestId' | 'sessionId'>,
  request: Pick<DetectionRequest, 'requestId'> | undefined,
  sessionId: string,
): boolean {
  return Boolean(request && sessionId && result.requestId === request.requestId && result.sessionId === sessionId);
}
