import { validTokenCount } from './types';
import type { InferenceProvider, InferenceTask, ProviderTerminal } from './types';
import { readLines } from './wire';
import type { GatewayBudget, GatewayCapabilities, GatewayFrame } from './wire';

export class GatewayStreamingProvider implements InferenceProvider {
  private constructor(
    readonly capabilities: GatewayCapabilities,
    private readonly authorization: string,
    private readonly origin: string,
  ) {}

  private static async status(authorization: string, origin: string): Promise<GatewayCapabilities & { budget: GatewayBudget }> {
    const response = await fetch(origin + '/api/runtime', {
      headers: { Authorization: authorization }, redirect: 'error', signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok || !response.headers.get('Content-Type')?.startsWith('application/json')) {
      throw new Error('Gateway unavailable or access token rejected');
    }
    return response.json();
  }

  async budget(): Promise<GatewayBudget> {
    return (await GatewayStreamingProvider.status(this.authorization, this.origin)).budget;
  }

  static async connect(token: string, origin = ''): Promise<GatewayStreamingProvider> {
    const authorization = 'Bearer ' + token;
    const caps = await this.status(authorization, origin);
    if ((caps.profile !== 'deepseek' && caps.profile !== 'openai') || typeof caps.model !== 'string'
      || (caps.slots !== 1 && caps.slots !== 2) || !validTokenCount(caps.inputReserve) || caps.inputReserve < 1
      || !validTokenCount(caps.outputLimit) || caps.outputLimit < 1 || !Number.isSafeInteger(caps.timeoutMs)
      || caps.timeoutMs < 1 || caps.timeoutMs > 120_000) throw new Error('Invalid gateway capabilities');
    return new GatewayStreamingProvider(caps, authorization, origin);
  }

  start(task: InferenceTask, signal: AbortSignal, callbacks: Parameters<InferenceProvider['start']>[2]): void {
    if (signal.aborted) {
      callbacks.terminal({ status: 'cancelled', tokens: 0 });
      return;
    }
    void this.stream(task, signal, callbacks);
  }

  private async stream(task: InferenceTask, signal: AbortSignal, callbacks: Parameters<InferenceProvider['start']>[2]) {
    const id = crypto.randomUUID();
    callbacks.requested?.(id);
    let dispatched = false;
    let cancelSent = false;
    let nextIndex = 0;
    const cancel = () => {
      if (cancelSent) return;
      cancelSent = true;
      void fetch(this.origin + '/api/inference/' + id + '/cancel', {
        method: 'POST', headers: { Authorization: this.authorization }, redirect: 'error',
        signal: AbortSignal.timeout(5_000),
      }).then((response) => response.body?.cancel()).catch(() => {});
    };
    const onAbort = () => { if (dispatched) cancel(); };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await fetch(this.origin + '/api/inference', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.capabilities.timeoutMs + 5_000),
        headers: { Authorization: this.authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, messages: task.context.messages }),
      });
      if (!response.ok && response.headers.get('X-SemanticStream-Dispatch') === 'none') {
        const { reason } = await response.json() as { reason?: unknown };
        callbacks.terminal({
          status: 'failed', tokens: 0, reason: typeof reason === 'string' ? reason.slice(0, 100) : 'Gateway rejected request',
        });
        return;
      }
      if (!response.ok || !response.body || !response.headers.get('Content-Type')?.startsWith('application/x-ndjson')) {
        void response.body?.cancel().catch(() => {});
        throw new Error();
      }
      for await (const line of readLines(response.body)) {
        const frame: GatewayFrame = JSON.parse(line);
        if (frame.id !== id) throw new Error();
        if (frame.type === 'dispatch' && !dispatched) {
          dispatched = true;
          callbacks.dispatched?.(id);
          if (signal.aborted) cancel();
        } else if (!dispatched) {
          throw new Error();
        } else if (frame.type === 'partial' && typeof frame.text === 'string' && frame.text.length <= 4096
          && Number.isSafeInteger(frame.index) && frame.index >= 0 && frame.index <= nextIndex) {
          if (frame.index === nextIndex) nextIndex += 1;
          callbacks.partial({ index: frame.index, text: frame.text, upstreamFirstTextMs: frame.firstTextMs,
            providerRequestId: frame.providerRequestId });
        } else if (frame.type === 'terminal' && validReceipt(frame.receipt)) {
          callbacks.terminal(frame.receipt);
          return;
        } else if (frame.type === 'unconfirmed' && typeof frame.reason === 'string') {
          callbacks.unconfirmed?.(frame.reason);
          return;
        } else {
          throw new Error();
        }
      }
      throw new Error();
    } catch {
      // A failed browser connection may have reached the server. Try stopping by ID and leave the slot fenced.
      cancel();
      callbacks.unconfirmed?.('Gateway connection ended without a reliable terminal');
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

function validReceipt(receipt: ProviderTerminal | undefined): receipt is ProviderTerminal {
  return !!receipt && (receipt.status === 'completed' || receipt.status === 'failed' || receipt.status === 'cancelled')
    && (receipt.tokens === null || validTokenCount(receipt.tokens));
}
