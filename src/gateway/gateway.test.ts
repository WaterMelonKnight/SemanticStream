import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { GatewayStreamingProvider } from '../inference/gateway-provider';
import { InferenceScheduler } from '../inference/scheduler';
import { systemClock } from '../inference/types';
import { evaluateGateway } from './evaluation';
import { fixtureCompletion, localGateway } from './fixtures';
import { readConfig } from './config';
import { GatewayLedger } from './ledger';

function runtime(provider: GatewayStreamingProvider) {
  const caps = provider.capabilities;
  return new InferenceScheduler(provider, systemClock, {
    slots: caps.slots, queue: 3, totalTokens: 20_000,
    tokensPerTask: caps.outputLimit, inputTokensPerTask: caps.inputReserve,
    transport: { maxFrames: 20, maxBytes: 20_000, windowMs: 5_000 },
  }, 'context-aware');
}

function send(scheduler: InferenceScheduler, label: string, supersede = false) {
  return scheduler.ingest({ source: 'user', label, capturedAtMs: systemClock.now(), reason: 'test' },
    { channel: 'response', priority: 1, ttlMs: 2_000, supersede });
}

describe('Node gateway and browser adapter contract', () => {
  it.each(['deepseek', 'openai'] as const)('maps the %s request and usage layout without including pixels', async (profile) => {
    const seen: { authorization?: string; input?: Record<string, unknown> } = {};
    const fixture = await localGateway((req, res, config) => {
      seen.authorization = req.headers.authorization;
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        seen.input = JSON.parse(body);
        fixtureCompletion(res, config.profile, 50);
      });
    }, { profile });
    try {
      const provider = await GatewayStreamingProvider.connect(fixture.config.token, fixture.origin);
      const scheduler = runtime(provider);
      scheduler.ingest({ source: 'user', label: 'What is known?', capturedAtMs: systemClock.now(), reason: 'test' },
        { channel: 'response', priority: 1, ttlMs: 2_000 }, {
          source: 'camera', mediaType: 'image/png', data: 'LOCAL-TEXT-SENTINEL', capturedAtMs: systemClock.now() - 1, sequence: 1,
        });
      await expect.poll(() => scheduler.snapshot().outputs[0]?.state).toBe('completed');
      expect(scheduler.snapshot().outputs[0]?.text).toBe('Ready 🍉');
      expect(seen.authorization).toBe('Bearer ' + fixture.config.apiKey);
      expect(seen.input).toMatchObject({ model: 'fixture-text', stream: true, stream_options: { include_usage: true } });
      expect(JSON.stringify(seen.input)).not.toContain('LOCAL-TEXT-SENTINEL');
      if (profile === 'deepseek') expect(seen.input).toMatchObject({ max_tokens: 32, thinking: { type: 'disabled' } });
      else expect(seen.input).toMatchObject({ max_completion_tokens: 32 });
      const metric = scheduler.requestMeasurements()[0];
      expect(metric).toMatchObject({ providerRequestId: 'completion-fixture', inputTokens: 31, outputTokens: 4, usage: 'reported' });
      expect(metric.upstreamFirstTextMs).toBeGreaterThan(0);
      expect(metric.firstEffectiveDelayMs).toBeGreaterThan(0);
      expect(await provider.budget()).toMatchObject({ settledNanoUsd: 82, held: 0 });
    } finally { await fixture.close(); }
  });

  it('keeps cancellation and transport close distinct from a terminal marker and persists quarantine', async () => {
    let disconnected = false;
    const fixture = await localGateway((req, res) => {
      req.resume();
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"id":"still-working","choices":[{"index":0,"delta":{"content":"text"}}]}\n\n');
      res.on('close', () => { disconnected = true; });
    }, { slots: 1 });
    try {
      const provider = await GatewayStreamingProvider.connect(fixture.config.token, fixture.origin);
      const scheduler = runtime(provider);
      send(scheduler, 'first');
      await expect.poll(() => scheduler.snapshot().outputs[0]?.text).toBe('text');
      scheduler.newSession();
      const next = send(scheduler, 'next session');
      expect(scheduler.snapshot().queued[0]?.id).toBe(next);
      await expect.poll(() => scheduler.snapshot().budget.quarantinedSlots).toBe(1);
      await expect.poll(() => disconnected).toBe(true);
      expect(await provider.budget()).toMatchObject({ held: 1, quarantined: 1, settledNanoUsd: 0, reservedNanoUsd: 2208 });
      expect(scheduler.snapshot().records.at(-1)?.reason).toBe('All endpoint slots quarantined');
      expect(scheduler.requestMeasurements()[0]).toMatchObject({ usage: 'unknown · held', outcome: 'invalidated' });
      await fixture.app.close();
      const ledger = new GatewayLedger(fixture.config);
      try {
        expect(ledger.admit(randomUUID())).toBe('Gateway capacity is occupied or quarantined');
        const requestId = scheduler.requestMeasurements()[0].requestId!;
        expect(ledger.settle(requestId, { inputTokens: 31, outputTokens: 4 })).toBe(true);
        expect(ledger.settle(requestId, { inputTokens: 31, outputTokens: 4 })).toBe(false);
        expect(ledger.admit(randomUUID())).toBeUndefined();
      } finally { ledger.close(); }
    } finally { await fixture.close(); }
  });

  it('keeps both physical slots across cancellation and blocks late text before a reliable terminal', async () => {
    let upstreamStarts = 0;
    const fixture = await localGateway((req, res) => {
      req.resume();
      const sequence = ++upstreamStarts;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const emit = (content: string, finish_reason: string | null) => res.write('data: ' + JSON.stringify({
        id: 'fixture-' + sequence, choices: [{ index: 0, delta: { content }, finish_reason }],
      }) + '\n\n');
      emit('response ' + sequence, null);
      const timer = setTimeout(() => {
        emit(' late ' + sequence, null);
        emit('', 'stop');
        res.end('data: [DONE]\n\n');
      }, 250);
      res.on('close', () => clearTimeout(timer));
    }, { cancelGraceMs: 600 });
    try {
      const adapter = await GatewayStreamingProvider.connect(fixture.config.token, fixture.origin);
      const firstClient = runtime(adapter);
      const old = send(firstClient, 'first');
      await expect.poll(() => firstClient.snapshot().outputs[0]?.state).toBe('streaming');
      send(firstClient, 'take over', true);
      await expect.poll(async () => (await adapter.budget()).held).toBe(2);
      const secondClient = runtime(adapter);
      send(secondClient, 'third');
      await expect.poll(() => secondClient.snapshot().records.at(-1)?.reason).toBe('Gateway capacity is occupied or quarantined');
      await expect.poll(() => firstClient.snapshot().attempts.length).toBe(0);
      expect(upstreamStarts).toBe(2);
      const prior = firstClient.snapshot().outputs.find((item) => item.taskId === old);
      expect(prior).toMatchObject({ state: 'superseded', text: 'response 1' });
      const metric = firstClient.requestMeasurements()[0];
      expect(metric).toMatchObject({ blocked: 1, stale: 1 });
      expect(metric.waitForTerminalAfterStopMs).toBeGreaterThan(0);
      expect(await adapter.budget()).toMatchObject({ held: 0, quarantined: 0, provisionalNanoUsd: 4416 });
    } finally { await fixture.close(); }
  });

  it('settles reliable completion with absent usage provisionally and accounts full overrun before freezing', async () => {
    let count = 0;
    const fixture = await localGateway((req, res) => {
      req.resume();
      const usage = ++count === 1 ? null : { prompt_tokens: 1100, completion_tokens: 5, total_tokens: 1105 };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({
        id: 'finished', choices: [{ index: 0, delta: { content: 'ready' }, finish_reason: 'stop' }], usage,
      }) + '\n\ndata: [DONE]\n\n');
    });
    try {
      const provider = await GatewayStreamingProvider.connect(fixture.config.token, fixture.origin);
      const scheduler = runtime(provider);
      send(scheduler, 'one');
      await expect.poll(() => scheduler.snapshot().budget.provisionalTokens).toBe(1056);
      expect(await provider.budget()).toMatchObject({ held: 0, provisionalNanoUsd: 2208 });
      send(scheduler, 'two');
      await expect.poll(() => scheduler.snapshot().budget.reservationOverrun).toBe(true);
      expect(await provider.budget()).toMatchObject({ held: 0, blocked: true, settledNanoUsd: 2225 });
      // A fresh browser runtime is still subject to the server's accounting.
      const fresh = runtime(provider);
      send(fresh, 'blocked');
      await expect.poll(() => fresh.snapshot().records.at(-1)?.reason).toBe('Gateway budget requires operator reconciliation');
      expect(count).toBe(2);
    } finally { await fixture.close(); }
  });

  it('rejects untrusted origins, absent access tokens, oversized bodies and non-text inputs before dispatch', async () => {
    let calls = 0;
    const fixture = await localGateway((req, res) => {
      req.resume();
      calls += 1;
      res.writeHead(500).end();
    }, { maxBytes: 512 });
    try {
      const path = fixture.origin + '/api/inference';
      const headers = { Authorization: 'Bearer ' + fixture.config.token, 'Content-Type': 'application/json' };
      const post = (body: unknown, extra = {}) => fetch(path, {
        method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body),
      });
      const request = { id: randomUUID(), messages: [{ role: 'user', content: 'test' }] };
      expect((await post(request, { Authorization: '' })).status).toBe(401);
      expect((await post(request, { Origin: 'https://other.example' })).status).toBe(403);
      expect((await post({ ...request, padding: 'x'.repeat(700) })).status).toBe(413);
      expect((await post({ ...request, messages: [{ role: 'user', content: [{ type: 'image_url' }] }] })).status).toBe(400);
      expect(calls).toBe(0);
    } finally { await fixture.close(); }
  });

  it('compares policies over one endpoint and reports unanswered requests at equal capacity', async () => {
    const fixture = await localGateway();
    try {
      const report = await evaluateGateway(
        await GatewayStreamingProvider.connect(fixture.config.token, fixture.origin), true, 'local SSE fixture simulation',
      );
      expect(report).toMatchObject({ slots: 2, measurement: 'local SSE fixture simulation' });
      expect(report.variants).toHaveLength(2);
      for (const item of report.variants) {
        expect(item).toMatchObject({ taskCount: 6, pendingUpstreamSlots: 0 });
        expect(item.unansweredCount).toBeGreaterThan(0);
        expect(item.tasks?.filter((task) => task.unanswered)).toHaveLength(item.unansweredCount!);
      }
      expect(report.variants[0].tasks?.at(-1)?.reason).toBe('Queue full');
      expect(report.variants[1].tasks?.find(({ label }) => label.startsWith('Critical'))?.unanswered).toBe(false);
    } finally { await fixture.close(); }
  });

  it('treats EOF after finish and usage as unconfirmed without a DONE marker', async () => {
    const fixture = await localGateway((req, res) => {
      req.resume();
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: {"id":"finished","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],'
        + '"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\n');
    });
    try {
      const provider = await GatewayStreamingProvider.connect(fixture.config.token, fixture.origin);
      const scheduler = runtime(provider);
      send(scheduler, 'one');
      await expect.poll(() => scheduler.snapshot().budget.quarantinedSlots).toBe(1);
      await sleep(10);
      expect(await provider.budget()).toMatchObject({ settledNanoUsd: 0, quarantined: 1 });
    } finally { await fixture.close(); }
  });

  it('requires explicit enable and all safety caps', () => {
    expect(() => readConfig({})).toThrow('SS_ENABLE_REAL=YES');
    expect(() => readConfig({ SS_ENABLE_REAL: 'YES' })).toThrow('SS_GATEWAY_TOKEN');
  });
});
