export type TelemetryModule = 'perception' | 'context' | 'decision' | 'scheduler' | 'model' | 'cost' | 'runtime';
export type TelemetryKind = 'counter' | 'gauge' | 'histogram' | 'event';
export type TelemetrySource = 'mock' | 'fixture' | 'real' | 'unavailable';

export interface TelemetryIdentity {
  readonly sessionId?: string;
  readonly taskId?: number;
  readonly requestId?: string;
  readonly providerRequestId?: string;
}

export interface TelemetryRecordInput extends TelemetryIdentity {
  readonly atMs: number;
  readonly module: TelemetryModule;
  readonly kind: TelemetryKind;
  readonly name: string;
  readonly value?: number;
  readonly unit?: string;
  readonly source: TelemetrySource;
  /** Low-cardinality only. Never put prompts, media, keys, tokens or model output here. */
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
}

export interface TelemetryEvent extends TelemetryRecordInput {
  readonly id: number;
}

export interface TelemetrySeriesPoint {
  readonly atMs: number;
  readonly value: number;
}

export interface TelemetrySeries {
  readonly name: string;
  readonly sessionId?: string;
  readonly unit?: string;
  readonly source: TelemetrySource;
  readonly points: readonly TelemetrySeriesPoint[];
}

export interface TelemetrySnapshot {
  readonly events: readonly TelemetryEvent[];
  readonly series: readonly TelemetrySeries[];
  readonly droppedEvents: number;
  readonly droppedSeries: number;
}
