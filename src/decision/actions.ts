import type { DecisionAction } from './types';

/** Phase 3R delivers both send proposals through the same frame effect. */
export function proposesRealtimeDelivery(action: DecisionAction | undefined): boolean {
  return action === 'SEND_FRAME' || action === 'SEND_PREVIEW';
}
