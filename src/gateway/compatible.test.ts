import { expect, it } from 'vitest';
import { readCompletion } from './compatible';

function stream(data: string) {
  const bytes = new TextEncoder().encode(data);
  // Exercise delimiters, emoji and JSON fragments split across byte chunks.
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  });
}

it('decodes fragmented UTF-8 deltas and treats inconsistent usage as unknown', async () => {
  const partials: string[] = [];
  const data = ': keep-alive\r\n\r\n'
    + 'data: {"id":"a","choices":[{"index":0,"delta":{"content":"π🍉"}}]}\r\n\r\n'
    + 'data: {"id":"a","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],'
    + '"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":4}}\r\n\r\n'
    + 'data: [DONE]\r\n\r\n';
  const final = await readCompletion(stream(data), 'deepseek', (text) => { partials.push(text); });
  expect(partials).toEqual(['π🍉']);
  expect(final).toMatchObject({ status: 'completed', tokens: null, providerRequestId: 'a' });
});

it('refuses to attest a final choice received under a different upstream ID', async () => {
  const data = 'data: {"id":"a","choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n'
    + 'data: {"id":"b","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'
    + 'data: [DONE]\n\n';
  await expect(readCompletion(stream(data), 'deepseek', () => {})).rejects.toThrow('Invalid completion chunk');
});
