import { describe, expect, it } from 'vitest';
import { TelemetryHub, telemetryToOpenTelemetryHint } from './telemetry';

describe('bounded telemetry hub', () => {
  it('keeps bounded events and series with explicit source and identity', () => {
    const hub = new TelemetryHub(3, 2);
    hub.gauge(10, 'perception', 'detection_fps', 2.5, 'fps', 'real', { sessionId: 's1' });
    hub.counter(11, 'scheduler', 'completed', 1, 'mock', { sessionId: 's1', taskId: 4 });
    hub.event(12, 'cost', 'budget_poll_error', 'unavailable', { sessionId: 's1' });
    hub.gauge(13, 'perception', 'detection_fps', 3.5, 'fps', 'real', { sessionId: 's1' });
    hub.gauge(14, 'perception', 'detection_fps', 4.5, 'fps', 'real', { sessionId: 's1' });
    const snapshot = hub.snapshot();
    expect(snapshot.events).toHaveLength(3);
    expect(snapshot.events.at(-1)?.value).toBe(4.5);
    expect(snapshot.events.at(-1)?.source).toBe('real');
    expect(snapshot.events.at(-1)?.sessionId).toBe('s1');
    expect(snapshot.droppedEvents).toBe(2);
    expect(snapshot.series[0].points).toHaveLength(2);
    expect(snapshot.series[0].name).toBe('detection_fps');
    expect(snapshot.series[0].sessionId).toBe('s1');
    expect(snapshot.droppedSeries).toBe(1);
  });

  it('supports session isolation and reset', () => {
    const hub = new TelemetryHub(10, 5);
    hub.event(1, 'runtime', 'session_start', 'mock', { sessionId: 'a' });
    hub.event(2, 'runtime', 'session_start', 'mock', { sessionId: 'b' });
    hub.gauge(3, 'runtime', 'queue', 1, 'tasks', 'mock', { sessionId: 'a' });
    hub.clearSession('a');
    expect(hub.snapshot().events.map((event) => event.sessionId)).toEqual(['b']);
    expect(hub.snapshot().series).toHaveLength(0);
    hub.clear();
    expect(hub.snapshot().events).toHaveLength(0);
    expect(hub.snapshot().droppedEvents).toBe(0);
  });

  it('drops high-cardinality/sensitive attributes and exports JSON/CSV without payloads', () => {
    const hub = new TelemetryHub(10, 5);
    hub.event(1, 'model', 'load_failed', 'unavailable', { sessionId: 's', taskId: 2 }, {
      prompt: 'SECRET PROMPT', authorization: 'Bearer SECRET', image: 'BASE64', status: 'error', count: 2,
    });
    const event = hub.snapshot().events[0];
    expect(event.attributes).toEqual({ status: 'error', count: 2 });
    expect(hub.exportJson()).not.toContain('SECRET');
    const csv = hub.exportCsv();
    expect(csv).toContain('record_type');
    expect(csv).toContain('event');
    expect(csv).not.toContain('SECRET');
  });

  it('provides an explicit OpenTelemetry mapping boundary', () => {
    const hub = new TelemetryHub();
    hub.histogram(10, 'scheduler', 'first_text_ms', 42, 'ms', 'fixture', { requestId: 'r1', taskId: 3 });
    const hint = telemetryToOpenTelemetryHint(hub.snapshot().events[0]);
    expect(hint.name).toBe('semanticstream.scheduler.first_text_ms');
    expect(hint.attributes['semanticstream.source']).toBe('fixture');
    expect(hint.attributes['semanticstream.request_id']).toBe('r1');
  });
});
