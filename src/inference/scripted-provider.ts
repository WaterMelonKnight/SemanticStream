import type { InferenceProvider, InferenceTask, RuntimeClock } from './types';

export interface StreamScript {
  readonly firstTokenMs: number;
  readonly intervalMs: number;
  readonly chunks: readonly string[];
  readonly finishAfterMs?: number;
  readonly cancelAfterMs?: number;
  readonly ignoreCancel?: boolean;
  readonly fail?: boolean;
  readonly unknownUsage?: boolean;
  readonly latePartialMs?: number;
}

export class ScriptedStreamingProvider implements InferenceProvider {
  constructor(
    private readonly clock: RuntimeClock,
    private readonly scriptFor: (task: InferenceTask) => StreamScript,
  ) {}

  start(task: InferenceTask, signal: AbortSignal, callbacks: Parameters<InferenceProvider['start']>[2]): void {
    let script: StreamScript;
    try {
      script = this.scriptFor(task);
    } catch {
      callbacks.terminal({ status: 'failed', tokens: 0, reason: 'Script selection failed' });
      return;
    }
    const timers: (() => void)[] = [];
    let tokens = 0;
    let emittedChunks = 0;
    let ended = false;
    const finish = (status: 'completed' | 'failed' | 'cancelled') => {
      if (ended) return;
      ended = true;
      timers.forEach((stop) => stop());
      signal.removeEventListener('abort', cancel);
      callbacks.terminal({
        status, tokens: script.unknownUsage ? null : tokens,
        reason: status === 'failed' ? 'Scripted provider error' : undefined,
      });
      if (script.latePartialMs !== undefined) {
        this.clock.after(script.latePartialMs, () => callbacks.partial({
          index: emittedChunks, text: 'Late scripted partial',
        }));
      }
    };
    const cancel = () => {
      if (script.ignoreCancel) return;
      timers.forEach((stop) => stop());
      timers.push(this.clock.after(script.cancelAfterMs ?? 25, () => finish('cancelled')));
    };

    script.chunks.forEach((text, index) => {
      timers.push(this.clock.after(script.firstTokenMs + index * script.intervalMs, () => {
        const accepted = text.slice(0, (task.tokenLimit - tokens) * 4);
        if (!accepted) return;
        tokens += Math.ceil(accepted.length / 4);
        callbacks.partial({ index: emittedChunks++, text: accepted });
      }));
    });
    const lastChunkMs = script.firstTokenMs + Math.max(0, script.chunks.length - 1) * script.intervalMs;
    timers.push(this.clock.after(lastChunkMs + (script.finishAfterMs ?? 50), () => {
      finish(script.fail ? 'failed' : 'completed');
    }));
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  }
}
