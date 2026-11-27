import type { InferenceScheduler } from '../inference/scheduler';
import { diagnosticCode } from './diagnostics';
import type { TelemetryHub } from './telemetry';
import type { TelemetrySource } from './types';

/** Observe lifecycle records before the scheduler's journal can overwrite them. */
export function observeInference(
  scheduler: InferenceScheduler, sink: TelemetryHub, source: TelemetrySource, instance: string,
): () => void {
  return scheduler.subscribe((record) => {
    const { task, kind, atMs } = record;
    if (!task) return;
    const identity = {
      runtimeInstanceId: task.origin?.runtimeInstanceId ?? instance,
      sessionId: task.origin?.sessionId ?? ('runtime-' + task.session),
      eventId: task.origin?.eventId,
      taskId: task.id, requestId: task.requestId, providerRequestId: record.providerRequestId ?? task.providerRequestId,
    };
    const histogram = (name: string, start: number) =>
      sink.histogram(atMs, 'model', name, Math.max(0, atMs - start), 'ms', source, identity);
    switch (kind) {
      case 'queued':
        sink.event(atMs, 'scheduler', 'admitted', source, identity);
        histogram('event_to_admission_ms', task.origin?.producedAtMs ?? task.ingestedAtMs);
        break;
      case 'start':
        sink.event(atMs, 'scheduler', 'dispatch', source, identity);
        histogram('queue_wait_ms', task.ingestedAtMs);
        break;
      case 'dispatch': sink.event(atMs, 'model', 'gateway_dispatch', source, identity); break;
      case 'first-text':
        if (task.startedAtMs !== undefined) histogram('first_text_ms', task.startedAtMs);
        break;
      case 'output':
        if (record.firstValidOutput) histogram('event_to_valid_response_ms', task.origin?.producedAtMs ?? task.ingestedAtMs);
        break;
      case 'blocked':
        sink.counter(atMs, 'scheduler', record.staleOutput ? 'stale_suppressed' : 'partial_blocked', 1, source, identity);
        break;
      case 'end':
        sink.event(atMs, 'scheduler', 'task_' + record.outcome, source, identity, { code: diagnosticCode(record.reason) }, true);
        break;
      case 'quarantined': sink.event(atMs, 'model', 'quarantined', source, identity, undefined, true); break;
      case 'upstream':
        sink.event(atMs, 'model', 'terminal', source, identity, { usage: record.usageUnknown ? 'unknown' : 'known' }, true);
        if (record.usage) {
          sink.counter(atMs, 'model', 'input_tokens', record.usage.inputTokens, source, identity);
          sink.counter(atMs, 'model', 'output_tokens', record.usage.outputTokens, source, identity);
        } else if (record.usageUnknown) sink.counter(atMs, 'model', 'unknown_usage', 1, source, identity);
        break;
    }
  });
}
