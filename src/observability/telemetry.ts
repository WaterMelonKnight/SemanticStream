import { BoundedTimeline } from '../core/timeline';
import type {
  TelemetryEvent,
  TelemetryIdentity,
  TelemetryKind,
  TelemetryModule,
  TelemetryRecordInput,
  TelemetrySnapshot,
  TelemetrySource,
} from './types';

const MAX_ATTRIBUTES = 12;
const MAX_ATTRIBUTE_KEY = 32;
const MAX_ATTRIBUTE_STRING = 64;
const MAX_SERIES = 24;
const FORBIDDEN_ATTRIBUTE = /(prompt|content|text|image|video|media|token|secret|key|authorization|payload|data|cookie|password)/i;

function cleanAttributes(
  attributes: TelemetryRecordInput['attributes'],
): Readonly<Record<string, string | number | boolean>> | undefined {
  if (!attributes) return undefined;
  const entries = Object.entries(attributes).slice(0, MAX_ATTRIBUTES);
  const clean: Record<string, string | number | boolean> = {};
  for (const [key, value] of entries) {
    if (FORBIDDEN_ATTRIBUTE.test(key) || key.length > MAX_ATTRIBUTE_KEY) continue;
    if (typeof value === 'string') clean[key] = value.slice(0, MAX_ATTRIBUTE_STRING);
    else if (typeof value === 'number' && Number.isFinite(value)) clean[key] = value;
    else if (typeof value === 'boolean') clean[key] = value;
  }
  return Object.keys(clean).length ? clean : undefined;
}

/**
 * Page-scoped telemetry. It is deliberately not a global singleton: each page
 * owns one hub and exports only its own bounded events/series.
 */
export class TelemetryHub {
  private readonly events: BoundedTimeline<TelemetryEvent>;
  private readonly series = new Map<string, BoundedTimeline<{ atMs: number; value: number }>>();
  private readonly seriesMeta = new Map<string, { name: string; sessionId?: string; unit?: string; source: TelemetrySource }>();
  private readonly seriesCapacity: number;
  private nextId = 0;
  private droppedEvents = 0;
  private droppedSeries = 0;

  constructor(eventCapacity = 400, seriesCapacity = 160) {
    this.events = new BoundedTimeline<TelemetryEvent>(Math.max(1, eventCapacity));
    this.seriesCapacity = Math.max(1, seriesCapacity);
  }

  record(input: TelemetryRecordInput): TelemetryEvent | undefined {
    if (!Number.isFinite(input.atMs) || input.atMs < 0 || input.name.length === 0 || input.name.length > 80) return undefined;
    const event: TelemetryEvent = {
      ...input,
      attributes: cleanAttributes(input.attributes),
      id: ++this.nextId,
    };
    const previous = this.events.size;
    this.events.push(event);
    if (previous >= this.events.capacity) this.droppedEvents += 1;
    if (input.kind === 'gauge' || input.kind === 'histogram') {
      if (input.value !== undefined && Number.isFinite(input.value)) this.pushSeries(input, input.value);
    }
    return event;
  }

  event(
    atMs: number,
    module: TelemetryModule,
    name: string,
    source: TelemetrySource,
    identity: TelemetryIdentity = {},
    attributes?: TelemetryRecordInput['attributes'],
  ): TelemetryEvent | undefined {
    return this.record({ atMs, module, kind: 'event', name, source, ...identity, attributes });
  }

  gauge(
    atMs: number,
    module: TelemetryModule,
    name: string,
    value: number,
    unit: string,
    source: TelemetrySource,
    identity: TelemetryIdentity = {},
  ): TelemetryEvent | undefined {
    return this.record({ atMs, module, kind: 'gauge', name, value, unit, source, ...identity });
  }

  histogram(
    atMs: number,
    module: TelemetryModule,
    name: string,
    value: number,
    unit: string,
    source: TelemetrySource,
    identity: TelemetryIdentity = {},
  ): TelemetryEvent | undefined {
    return this.record({ atMs, module, kind: 'histogram', name, value, unit, source, ...identity });
  }

  counter(
    atMs: number,
    module: TelemetryModule,
    name: string,
    value: number,
    source: TelemetrySource,
    identity: TelemetryIdentity = {},
  ): TelemetryEvent | undefined {
    return this.record({ atMs, module, kind: 'counter', name, value, source, ...identity });
  }

  snapshot(): TelemetrySnapshot {
    return {
      events: this.events.toArray(),
      series: [...this.series.entries()].map(([name, points]) => {
        const meta = this.seriesMeta.get(name);
        return {
          name: meta?.name ?? name,
          sessionId: meta?.sessionId,
          unit: meta?.unit,
          source: meta?.source ?? 'unavailable',
          points: points.toArray(),
        };
      }),
      droppedEvents: this.droppedEvents,
      droppedSeries: this.droppedSeries,
    };
  }

  clear(): void {
    this.events.clear();
    this.series.clear();
    this.seriesMeta.clear();
    this.droppedEvents = 0;
    this.droppedSeries = 0;
    this.nextId = 0;
  }

  clearSession(sessionId: string): void {
    const kept = this.events.toArray().filter((event) => event.sessionId !== sessionId);
    this.events.clear();
    for (const event of kept) this.events.push(event);
    for (const key of [...this.series.keys()]) {
      if (key.startsWith(sessionId + ':')) {
        this.series.delete(key);
        this.seriesMeta.delete(key);
      }
    }
  }

  exportJson(): string {
    return JSON.stringify({
      schema: 'semanticstream.telemetry.v1',
      exportedAtMs: Date.now(),
      ...this.snapshot(),
    }, null, 2);
  }

  exportCsv(): string {
    const rows: string[][] = [[
      'record_type','id','at_ms','module','kind','name','value','unit','source',
      'session_id','task_id','request_id','provider_request_id','attributes',
    ]];
    const snapshot = this.snapshot();
    for (const event of snapshot.events) {
      rows.push([
        'event', String(event.id), String(event.atMs), event.module, event.kind, event.name,
        event.value === undefined ? '' : String(event.value), event.unit ?? '', event.source,
        event.sessionId ?? '', event.taskId === undefined ? '' : String(event.taskId),
        event.requestId ?? '', event.providerRequestId ?? '',
        event.attributes ? JSON.stringify(event.attributes) : '',
      ]);
    }
    for (const series of snapshot.series) {
      for (const point of series.points) {
        rows.push([
          'series', '', String(point.atMs), '', 'gauge', series.name, String(point.value), series.unit ?? '',
          series.source, series.sessionId ?? '', '', '', '', '',
        ]);
      }
    }
    return rows.map((row) => row.map((cell) => /[",\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell).join(',')).join('\n') + '\n';
  }

  private pushSeries(input: TelemetryRecordInput, value: number): void {
    const key = `${input.sessionId ?? '-'}:${input.name}`;
    let points = this.series.get(key);
    if (!points) {
      if (this.series.size >= MAX_SERIES) {
        this.droppedSeries += 1;
        return;
      }
      points = new BoundedTimeline<{ atMs: number; value: number }>(this.seriesCapacity);
      this.series.set(key, points);
      this.seriesMeta.set(key, { name: input.name, sessionId: input.sessionId, unit: input.unit, source: input.source });
    }
    const previous = points.size;
    points.push({ atMs: input.atMs, value });
    if (previous >= this.seriesCapacity) this.droppedSeries += 1;
  }
}

export function telemetryToOpenTelemetryHint(event: TelemetryEvent): {
  name: string;
  kind: TelemetryKind;
  attributes: Record<string, string | number | boolean>;
} {
  return {
    name: `semanticstream.${event.module}.${event.name}`,
    kind: event.kind,
    attributes: {
      'semanticstream.source': event.source,
      'semanticstream.session_id': event.sessionId ?? 'unattached',
      ...(event.taskId !== undefined ? { 'semanticstream.task_id': event.taskId } : {}),
      ...(event.requestId ? { 'semanticstream.request_id': event.requestId } : {}),
      ...(event.attributes ?? {}),
    },
  };
}
