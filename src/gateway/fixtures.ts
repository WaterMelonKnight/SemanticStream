import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GatewayConfig } from './config';
import { createGateway } from './server';

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No local fixture port');
  return address.port;
}

export function fixtureCompletion(res: ServerResponse, profile: GatewayConfig['profile'], delayMs = 220): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(': keep-alive\r\n\r\n');
  const emit = (choices: unknown[], usage?: unknown) => {
    res.write('data: ' + JSON.stringify({ id: 'completion-fixture', choices, usage }) + '\r\n\r\n');
  };
  const start = setTimeout(() => emit([{ index: 0, delta: { content: 'Ready 🍉' }, finish_reason: null }]), 20);
  const finish = setTimeout(() => {
    const usage = { prompt_tokens: 31, completion_tokens: 4, total_tokens: 35 };
    emit([{ index: 0, delta: {}, finish_reason: 'stop' }], profile === 'deepseek' ? usage : undefined);
    if (profile === 'openai') emit([], usage);
    res.end('data: [DONE]\r\n\r\n');
  }, delayMs);
  res.on('close', () => { clearTimeout(start); clearTimeout(finish); });
}

export async function localGateway(
  handler?: (req: IncomingMessage, res: ServerResponse, config: GatewayConfig) => void,
  settings: Partial<GatewayConfig> = {},
) {
  const temp = await mkdtemp(join(tmpdir(), 'semanticstream-gateway-'));
  const upstream = createServer((req, res) => {
    if (handler) handler(req, res, config);
    else { req.resume(); fixtureCompletion(res, config.profile); }
  });
  const upstreamPort = await listen(upstream);
  const config: GatewayConfig = {
    port: 0, token: randomBytes(32).toString('hex'), apiKey: randomBytes(32).toString('hex'),
    url: new URL('http://127.0.0.1:' + upstreamPort), profile: 'deepseek', model: 'fixture-text',
    dist: 'dist', stateFile: join(temp, 'ledger.local'), slots: 2, maxBytes: 4096,
    inputReserve: 1024, outputLimit: 32, maxRequests: 20, budgetNanoUsd: 1_000_000,
    inputNanoUsd: 2, outputNanoUsd: 5, timeoutMs: 1_000, cancelGraceMs: 60,
    ...settings,
  };
  const app = createGateway(config);
  const port = await listen(app.server);
  return {
    config, app, origin: 'http://127.0.0.1:' + port,
    async close() {
      await app.close();
      await new Promise<void>((resolve) => { upstream.close(() => resolve()); upstream.closeAllConnections(); });
      await rm(temp, { recursive: true, force: true });
    },
  };
}
