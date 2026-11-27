import type { RuntimeLimits } from '../inference/scheduler';
import type { InferenceProvider } from '../inference/types';
import type { TelemetrySource } from '../observability/types';

export interface AgentProviderCapabilities {
  readonly modelId: string;
  readonly executionLocation: 'mock' | 'gateway' | 'browser';
  readonly supportsText: boolean;
  readonly supportsVision: boolean;
  readonly supportsStreaming: boolean;
  readonly supportsCancellation: boolean;
  readonly maxConcurrency: number;
  readonly usageReporting: 'simulated' | 'reported-or-unknown' | 'unavailable';
  readonly readiness: 'ready' | 'unavailable';
}

export interface AgentProvider {
  readonly adapter: InferenceProvider;
  readonly capabilities: AgentProviderCapabilities;
  readonly limits: RuntimeLimits;
  readonly source: TelemetrySource;
  readonly deadlineMs: number;
}

/** Future local text adapters report their measured execution capacity through AgentProvider. */
export type BrowserLocalProvider = AgentProvider & {
  readonly capabilities: AgentProviderCapabilities & { readonly executionLocation: 'browser' };
};
