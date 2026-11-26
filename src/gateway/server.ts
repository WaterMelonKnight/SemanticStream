import { timingSafeEqual } from 'node:crypto';
import { stat, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import type { ChatMessage, ProviderTerminal } from '../inference/types';
import type { GatewayCapabilities, GatewayFrame } from '../inference/wire';
import { compatibleRequest, readCompletion } from './compatible';
import type { GatewayConfig } from './config';
import { GatewayLedger } from './ledger';

const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const KNOWN_REJECTIONS = new Set([400, 401, 402, 403, 404, 422, 429]);
const MEDIA_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.json': 'application/json', '.wasm': 'application/wasm',
};
const STATIC_FILES = /^(?:index\.html|runtime\.html|perception\.html|favicon\.png|assets\/[\w.-]+|benchmark\/[\w.-]+|mediapipe\/wasm\/vision_wasm_module_internal\.(?:js|wasm))$/;
const BASE_CSP = "default-src 'self'; object-src 'none'; base-uri 'self'; media-src 'self' blob:; "
  + "img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'";
const PERCEPTION_CSP = "default-src 'self'; object-src 'none'; base-uri 'self'; media-src 'self' blob:; "
  + "img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self' https://storage.googleapis.com; "
  + "script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; frame-ancestors 'none'";

export function staticFileAllowed(fileName: string): boolean {
  return STATIC_FILES.test(fileName) && !fileName.endsWith('/..');
}

export function mediaTypeFor(fileName: string): string | undefined {
  return MEDIA_TYPES[extname(fileName)];
}

export function contentSecurityPolicyFor(fileName: string): string {
  return fileName === 'perception.html' ? PERCEPTION_CSP : BASE_CSP;
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function reject(res: ServerResponse, status: number, reason: string): void {
  res.setHeader('X-SemanticStream-Dispatch', 'none');
  json(res, status, { reason });
}

async function body(req: IncomingMessage, max: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  const iterator = req.iterator({ destroyOnReturn: false });
  for await (const data of iterator) {
    size += data.length;
    if (size > max) throw new RangeError('Request too large');
    chunks.push(data);
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}

function validate(value: unknown, config: GatewayConfig): { id: string; messages: ChatMessage[] } | undefined {
  if (!value || typeof value !== 'object') return;
  const { id, messages } = value as { id?: unknown; messages?: unknown };
  if (typeof id !== 'string' || !ID.test(id) || !Array.isArray(messages)
    || messages.length < 1 || messages.length > 7 || messages.length % 2 !== 1) return;
  const validated: ChatMessage[] = [];
  // Count UTF-8 bytes plus room for the fixed system prompt and per-message framing.
  // This is an operator-configured headroom policy, not a vendor tokenizer.
  let estimatedInput = 256;
  for (const [index, message] of messages.entries()) {
    if (!message || typeof message !== 'object') return;
    const role = index % 2 === 0 ? 'user' : 'assistant';
    const content = message.content;
    if (message.role !== role || typeof content !== 'string' || !content.trim() || content.length > 1_024) return;
    estimatedInput += Buffer.byteLength(content) + 32;
    validated.push({ role, content });
  }
  if (estimatedInput > config.inputReserve) return;
  return { id, messages: validated };
}

export function createGateway(config: GatewayConfig) {
  const ledger = new GatewayLedger(config);
  const active = new Map<string, { cancel(): void; abort(): void }>();
  const inProgress = new Set<Promise<void>>();
  const expectedAuth = Buffer.from('Bearer ' + config.token);
  let closing = false;

  async function infer(res: ServerResponse, id: string, messages: ChatMessage[]): Promise<void> {
    const controller = new AbortController();
    let cancelTimer: NodeJS.Timeout | undefined;
    let cancellationRequested = false;
    let connected = true;
    const abort = () => controller.abort();
    const cancel = () => {
      if (cancellationRequested) return;
      cancellationRequested = true;
      cancelTimer = setTimeout(abort, config.cancelGraceMs);
    };
    const disconnected = () => {
      connected = false;
      if (!res.writableEnded) cancel();
    };
    active.set(id, { cancel, abort });
    res.once('close', disconnected);
    const timeout = setTimeout(abort, config.timeoutMs);
    const send = (frame: GatewayFrame) => {
      if (!connected) return;
      res.write(JSON.stringify(frame) + '\n');
      if (res.writableLength > 131_072) res.destroy();
    };

    try {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
      const upstreamStarted = performance.now();
      send({ type: 'dispatch', id });
      const response = await fetch(config.url, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: {
          Authorization: 'Bearer ' + config.apiKey, 'Content-Type': 'application/json', Accept: 'text/event-stream',
        },
        body: JSON.stringify(compatibleRequest(config.profile, config.model, messages, config.outputLimit)),
      });
      let receipt: ProviderTerminal;
      if (KNOWN_REJECTIONS.has(response.status)) {
        void response.body?.cancel().catch(() => {});
        receipt = { status: 'failed', reason: 'Upstream rejected HTTP ' + response.status, tokens: null };
      } else {
        if (response.status !== 200 || !response.body || !/^text\/event-stream(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
          void response.body?.cancel().catch(() => {});
          throw new Error('Unconfirmed upstream response');
        }
        let index = 0;
        receipt = await readCompletion(response.body, config.profile, (text, providerRequestId) => {
          for (let offset = 0; offset < text.length; offset += 4_096) {
            send({
              type: 'partial', id, index, providerRequestId, text: text.slice(offset, offset + 4_096),
              firstTextMs: index === 0 ? performance.now() - upstreamStarted : undefined,
            });
            index += 1;
          }
        });
      }
      const upstreamElapsedMs = performance.now() - upstreamStarted;
      ledger.settle(id, receipt.usage);
      send({ type: 'terminal', id, receipt: { ...receipt, upstreamElapsedMs } });
    } catch {
      // The hold stays durable and counts against the endpoint cap.
      send({
        type: 'unconfirmed', id,
        reason: controller.signal.aborted
          ? 'Upstream transport closed without confirmation' : 'No reliable upstream terminal',
      });
    } finally {
      clearTimeout(timeout);
      clearTimeout(cancelTimer);
      active.delete(id);
      if (connected) res.end();
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const address = server.address();
    const host = '127.0.0.1:' + (typeof address === 'object' && address ? address.port : config.port);
    const origin = 'http://' + host;
    if (req.headers.host !== host || (req.headers.origin !== undefined && req.headers.origin !== origin)) {
      reject(res, 403, 'Origin denied');
      return;
    }

    const path = req.url ?? '/';
    if (!path.startsWith('/api/')) {
      const fileName = path === '/' ? 'index.html' : path.slice(1);
      if (req.method !== 'GET' || !staticFileAllowed(fileName)) { json(res, 404, {}); return; }
      const file = join(config.dist, fileName);
      const info = await stat(file).catch(() => undefined);
      if (!info?.isFile()) { json(res, 404, {}); return; }
      const type = mediaTypeFor(file);
      if (!type) { json(res, 404, {}); return; }
      const headers: Record<string, string> = { 'Content-Type': type };
      // Apply CSP to documents only. A CSP on a worker script becomes the
      // worker's policy and would otherwise drop the perception page's
      // allowlisted model origin.
      if (fileName.endsWith('.html')) headers['Content-Security-Policy'] = contentSecurityPolicyFor(fileName);
      res.writeHead(200, headers);
      res.end(await readFile(file));
      return;
    }

    const auth = Buffer.from(req.headers.authorization ?? '');
    if (auth.length !== expectedAuth.length || !timingSafeEqual(auth, expectedAuth)) {
      reject(res, 401, 'Gateway authorization required');
      return;
    }
    if (path === '/api/runtime' && req.method === 'GET') {
      const capabilities: GatewayCapabilities = {
        model: config.model, profile: config.profile, slots: config.slots,
        inputReserve: config.inputReserve, outputLimit: config.outputLimit, timeoutMs: config.timeoutMs,
      };
      const budget = ledger.snapshot();
      json(res, 200, { ...capabilities, budget: {
        ...budget, quarantined: budget.held - active.size,
        requestLimit: config.maxRequests, limitNanoUsd: config.budgetNanoUsd,
        costPerRequestNanoUsd: config.inputReserve * config.inputNanoUsd + config.outputLimit * config.outputNanoUsd,
      } });
      return;
    }

    const cancelId = path.match(/^\/api\/inference\/([^/]+)\/cancel$/)?.[1];
    if (cancelId && ID.test(cancelId) && req.method === 'POST') {
      const attempt = active.get(cancelId);
      if (!attempt) { reject(res, 404, 'No active gateway request'); return; }
      attempt.cancel();
      json(res, 202, { requested: true });
      return;
    }

    if (path !== '/api/inference' || req.method !== 'POST') { reject(res, 404, 'Route unavailable'); return; }
    if (closing) { reject(res, 503, 'Gateway is stopping'); return; }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) { reject(res, 415, 'JSON required'); return; }
    if (Number(req.headers['content-length']) > config.maxBytes) {
      res.setHeader('Connection', 'close');
      reject(res, 413, 'Request too large');
      return;
    }
    let data: unknown;
    try {
      data = await body(req, config.maxBytes);
    } catch (error) {
      res.setHeader('Connection', 'close');
      reject(res, error instanceof RangeError ? 413 : 400, 'Request body rejected');
      return;
    }
    const input = validate(data, config);
    if (!input) { reject(res, 400, 'Text messages exceed limits or have an invalid shape'); return; }
    if (closing || req.aborted || res.destroyed) { reject(res, 503, 'Gateway is stopping or disconnected'); return; }
    const denied = ledger.admit(input.id);
    if (denied) { reject(res, 429, denied); return; }
    const work = infer(res, input.id, input.messages);
    inProgress.add(work);
    try { await work; } finally { inProgress.delete(work); }
  }

  const server = createServer({ headersTimeout: 5_000, requestTimeout: 8_000, keepAliveTimeout: 2_000 }, (req, res) => {
    res.on('error', () => res.destroy());
    void route(req, res).catch(() => {
      if (res.headersSent) res.destroy();
      else reject(res, 503, 'Gateway unavailable');
    });
  });
  server.maxConnections = 32;
  let shutdown: Promise<void> | undefined;
  async function close(): Promise<void> {
    closing = true;
    for (const attempt of active.values()) attempt.abort();
    try {
      const stopped = server.listening ? new Promise<void>((resolve) => server.close(() => resolve())) : undefined;
      await Promise.all([stopped, Promise.allSettled(inProgress)]);
    } finally {
      ledger.close();
    }
  }
  return { server, close: () => shutdown ??= close() };
}
