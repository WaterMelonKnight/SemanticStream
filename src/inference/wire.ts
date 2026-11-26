import type { ProviderTerminal } from './types';

export interface GatewayCapabilities {
  readonly model: string;
  readonly profile: 'deepseek' | 'openai';
  readonly slots: number;
  readonly inputReserve: number;
  readonly outputLimit: number;
  readonly timeoutMs: number;
}

export interface GatewayBudget {
  readonly held: number;
  readonly quarantined: number;
  readonly accepted: number;
  readonly slots: number;
  readonly requestLimit: number;
  readonly limitNanoUsd: number;
  readonly costPerRequestNanoUsd: number;
  readonly settledNanoUsd: number;
  readonly provisionalNanoUsd: number;
  readonly reservedNanoUsd: number;
  readonly blocked: boolean;
}

export type GatewayFrame =
  | { readonly type: 'dispatch'; readonly id: string }
  | { readonly type: 'partial'; readonly id: string; readonly index: number; readonly text: string; readonly firstTextMs?: number; readonly providerRequestId: string }
  | { readonly type: 'terminal'; readonly id: string; readonly receipt: ProviderTerminal }
  | { readonly type: 'unconfirmed'; readonly id: string; readonly reason: string };

/** Bounded, streaming UTF-8 decoding for both SSE and newline-delimited frames. */
export async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let bytes = 0;
  let eof = false;
  try {
    while (!eof) {
      const { value, done } = await reader.read();
      eof = done;
      bytes += value?.byteLength ?? 0;
      if (bytes > 2_097_152) throw new Error('Stream byte limit exceeded');
      buffer += value ? decoder.decode(value, { stream: true }) : decoder.decode();
      let start = 0;
      const delimiter = /\r\n|\n|\r/g;
      for (const match of buffer.matchAll(delimiter)) {
        const at = match.index;
        if (!eof && match[0] === '\r' && at === buffer.length - 1) break;
        if (at - start > 131_072) throw new Error('Stream line limit exceeded');
        yield buffer.slice(start, at);
        start = at + match[0].length;
      }
      buffer = buffer.slice(start);
      if (buffer.length > 131_072) throw new Error('Stream line limit exceeded');
    }
    // A truncated frame cannot be trusted as protocol evidence.
    if (buffer.length) throw new Error('Unterminated stream line');
  } finally {
    if (!eof) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
