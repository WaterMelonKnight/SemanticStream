export type DiagnosticCode =
  | 'completed' | 'failed' | 'cancelled' | 'expired' | 'invalidated' | 'rejected' | 'pending'
  | 'queue_full' | 'repeated_event' | 'deadline_expired' | 'session_changed' | 'displaced'
  | 'capacity_full' | 'budget_exhausted' | 'stale_output' | 'blocked_output' | 'usage_unknown'
  | 'terminal' | 'model_load_failed' | 'worker_failed' | 'budget_poll_failed' | 'budget_invalid'
  | 'gateway_offline' | 'unknown';

const REASONS: ReadonlyArray<readonly [RegExp, DiagnosticCode]> = [
  [/queue is full|queue full/i, 'queue_full'],
  [/repeated event|coalesced/i, 'repeated_event'],
  [/deadline expired/i, 'deadline_expired'],
  [/session changed/i, 'session_changed'],
  [/higher priority/i, 'displaced'],
  [/quarantined|capacity/i, 'capacity_full'],
  [/budget.*requires operator|cost budget|budget exhausted/i, 'budget_exhausted'],
  [/stale/i, 'stale_output'],
  [/output cap|out-of-order|invalid partial/i, 'blocked_output'],
  [/user interrupted|cancelled/i, 'cancelled'],
  [/upstream completed|completed/i, 'completed'],
  [/failed|error/i, 'failed'],
  [/pending/i, 'pending'],
];

/**
 * Collapse a scheduler/browser error string into a finite diagnostic code.
 * Free text is never exported as a telemetry attribute.
 */
export function diagnosticCode(reason: string | undefined): DiagnosticCode {
  if (!reason) return 'unknown';
  if (reason === 'completed' || reason === 'failed' || reason === 'cancelled' || reason === 'expired'
    || reason === 'invalidated' || reason === 'rejected' || reason === 'pending') return reason;
  for (const [pattern, code] of REASONS) if (pattern.test(reason)) return code;
  return 'unknown';
}
