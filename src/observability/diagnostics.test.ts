import { describe, expect, it } from 'vitest';
import { diagnosticCode } from './diagnostics';

describe('diagnostic codes', () => {
  it('maps known scheduler reasons to finite codes', () => {
    expect(diagnosticCode('Queue full')).toBe('queue_full');
    expect(diagnosticCode('Repeated event coalesced')).toBe('repeated_event');
    expect(diagnosticCode('All endpoint slots quarantined')).toBe('capacity_full');
    expect(diagnosticCode('Upstream completed')).toBe('completed');
    expect(diagnosticCode('Gateway cost budget exhausted')).toBe('budget_exhausted');
  });

  it('never returns the original free text', () => {
    expect(diagnosticCode('a private provider error with details')).toBe('failed');
    expect(diagnosticCode(undefined)).toBe('unknown');
  });
});
