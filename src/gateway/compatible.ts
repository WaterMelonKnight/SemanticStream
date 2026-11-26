import { validTokenCount } from '../inference/types';
import type { ChatMessage, ProviderTerminal, TokenUsage } from '../inference/types';
import { readLines } from '../inference/wire';

export type ProviderProfile = 'deepseek' | 'openai';

function object(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
}

function tokenUsage(value: unknown): TokenUsage | undefined {
  const usage = object(value);
  if (!usage) return;
  const { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: total } = usage;
  if (validTokenCount(inputTokens) && validTokenCount(outputTokens)
    && validTokenCount(total) && total === inputTokens + outputTokens) return { inputTokens, outputTokens };
}

async function* events(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const data: string[] = [];
  let size = 0;
  for await (const line of readLines(stream)) {
    if (!line) {
      if (data.length) yield data.join('\n');
      data.length = 0;
      size = 0;
    } else if (line.startsWith('data:') || line === 'data') {
      const value = line.slice(5).replace(/^ /, '');
      size += value.length + 1;
      if (size > 131_072) throw new Error('SSE event limit exceeded');
      data.push(value);
    }
  }
}

export function compatibleRequest(
  profile: ProviderProfile, model: string, messages: readonly ChatMessage[], outputLimit: number,
) {
  return {
    model,
    messages: [{
      role: 'system',
      content: 'You are a concise system monitoring assistant. You receive text and synthetic event metadata. '
        + 'You cannot view camera, video or pixels. State when evidence is unavailable. Do not claim to execute actions.',
    }, ...messages],
    stream: true,
    stream_options: { include_usage: true },
    ...(profile === 'deepseek'
      ? { max_tokens: outputLimit, thinking: { type: 'disabled' } }
      : { max_completion_tokens: outputLimit }),
  };
}

export async function readCompletion(
  stream: ReadableStream<Uint8Array>, profile: ProviderProfile, partial: (text: string, id: string) => void,
): Promise<ProviderTerminal> {
  let id: string | undefined;
  let finish: string | undefined;
  let usage: TokenUsage | undefined;
  let sawUsage = false;
  for await (const data of events(stream)) {
    if (data === '[DONE]') {
      if (!finish || !id) throw new Error('Completion marker without final choice');
      return {
        status: finish === 'stop' ? 'completed' : 'failed',
        reason: finish === 'stop' ? undefined : 'Upstream finished without a complete answer',
        tokens: usage ? usage.inputTokens + usage.outputTokens : null,
        usage,
        providerRequestId: id,
      };
    }
    const chunk = object(JSON.parse(data));
    if (!chunk || chunk.error || typeof chunk.id !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(chunk.id)
      || (id && chunk.id !== id) || !Array.isArray(chunk.choices)) throw new Error('Invalid completion chunk');
    id = chunk.id;
    if (profile === 'openai' && chunk.choices.length === 0 && finish && !sawUsage) {
      sawUsage = true;
      usage = tokenUsage(chunk.usage);
      continue;
    }
    const choice = object(chunk.choices[0]);
    if (finish || chunk.choices.length !== 1 || !choice || choice.index !== 0) throw new Error('Unexpected completion choice');
    const delta = object(choice.delta);
    const content = delta?.content;
    if (content !== undefined && content !== null && typeof content !== 'string') throw new Error('Invalid text delta');
    if (typeof content === 'string' && content) partial(content, id);
    if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
      finish = choice.finish_reason;
      if (profile === 'deepseek') usage = tokenUsage(chunk.usage);
    }
  }
  throw new Error('Upstream closed before completion marker');
}
