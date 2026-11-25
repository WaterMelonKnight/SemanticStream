import { resolve } from 'node:path';
import type { ProviderProfile } from './compatible';

export interface GatewayConfig {
  readonly port: number;
  readonly token: string;
  readonly apiKey: string;
  readonly url: URL;
  readonly profile: ProviderProfile;
  readonly model: string;
  readonly dist: string;
  readonly stateFile: string;
  readonly slots: number;
  readonly maxBytes: number;
  readonly inputReserve: number;
  readonly outputLimit: number;
  readonly maxRequests: number;
  readonly budgetNanoUsd: number;
  readonly inputNanoUsd: number;
  readonly outputNanoUsd: number;
  readonly timeoutMs: number;
  readonly cancelGraceMs: number;
}

export function readConfig(env: NodeJS.ProcessEnv): GatewayConfig {
  const required = (key: string) => {
    const value = env[key]?.trim();
    if (!value) throw new Error('Required gateway setting: ' + key);
    return value;
  };
  const integer = (key: string, min: number, max: number, fallback?: number) => {
    const value = env[key] === undefined && fallback !== undefined ? fallback : Number(required(key));
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('Invalid gateway setting: ' + key);
    return value;
  };
  if (env.SS_ENABLE_REAL !== 'YES') throw new Error('Real gateway requires SS_ENABLE_REAL=YES');
  const profile = env.SS_PROVIDER_PROFILE ?? 'deepseek';
  if (profile !== 'deepseek' && profile !== 'openai') throw new Error('Unsupported SS_PROVIDER_PROFILE');
  const url = new URL(env.SS_PROVIDER_URL ?? 'https://api.deepseek.com/chat/completions');
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:'
    && (url.protocol !== 'http:' || url.hostname !== '127.0.0.1'))) throw new Error('Invalid SS_PROVIDER_URL');
  if (profile === 'openai' && !env.SS_PROVIDER_URL) throw new Error('OpenAI profile requires SS_PROVIDER_URL');
  const token = required('SS_GATEWAY_TOKEN');
  const apiKey = required('SS_PROVIDER_KEY');
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token) || token === apiKey || /[\r\n]/.test(apiKey)) {
    throw new Error('Use a distinct, random SS_GATEWAY_TOKEN with at least 32 characters');
  }
  const model = required('SS_PROVIDER_MODEL');
  if (!/^[A-Za-z0-9_.:/-]{1,100}$/.test(model)) throw new Error('Invalid SS_PROVIDER_MODEL');
  const stateFile = resolve(required('SS_STATE_FILE'));
  if (!stateFile.endsWith('.local')) throw new Error('SS_STATE_FILE must end in .local');
  return {
    port: integer('SS_PORT', 1024, 65_535, 4180),
    token, apiKey, model, url, profile, stateFile, dist: resolve('dist'),
    slots: integer('SS_MAX_CONCURRENCY', 1, 2),
    maxBytes: integer('SS_MAX_REQUEST_BYTES', 512, 24_000),
    inputReserve: integer('SS_INPUT_TOKEN_RESERVE', 512, 32_768),
    outputLimit: integer('SS_MAX_OUTPUT_TOKENS', 1, 1_024),
    maxRequests: integer('SS_MAX_REQUESTS', 1, 10_000),
    budgetNanoUsd: integer('SS_BUDGET_NANO_USD', 1, 1_000_000_000_000),
    inputNanoUsd: integer('SS_INPUT_NANO_USD_PER_TOKEN', 1, 1_000_000),
    outputNanoUsd: integer('SS_OUTPUT_NANO_USD_PER_TOKEN', 1, 1_000_000),
    timeoutMs: integer('SS_UPSTREAM_TIMEOUT_MS', 1_000, 120_000, 40_000),
    cancelGraceMs: integer('SS_CANCEL_GRACE_MS', 0, 10_000, 1_500),
  };
}
