import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TokenUsage } from '../inference/types';
import type { GatewayConfig } from './config';

interface Hold {
  readonly id: string;
  readonly input: number;
  readonly output: number;
  readonly inputPrice: number;
  readonly outputPrice: number;
}

interface LedgerState {
  readonly version: 1;
  readonly ids: readonly string[];
  readonly held: readonly Hold[];
  readonly settled: number;
  readonly provisional: number;
  readonly overrun: boolean;
}

function reserveCost(hold: Hold): number {
  return hold.input * hold.inputPrice + hold.output * hold.outputPrice;
}

export class GatewayLedger {
  private state: LedgerState;
  private readonly unlock: () => void;
  private broken = false;

  constructor(private readonly config: GatewayConfig) {
    const { stateFile } = config;
    const lock = stateFile + '.lock.local';
    closeSync(openSync(lock, 'wx', 0o600));
    this.unlock = () => unlinkSync(lock);
    try {
      this.state = existsSync(stateFile) ? this.load() : {
        version: 1, ids: [], held: [], settled: 0, provisional: 0, overrun: false,
      };
    } catch {
      this.unlock();
      throw new Error('Gateway ledger could not be opened');
    }
  }

  admit(id: string): string | undefined {
    if (this.broken || this.state.overrun) return 'Gateway budget requires operator reconciliation';
    if (this.state.ids.includes(id)) return 'Request ID already used';
    if (this.state.held.length >= this.config.slots) return 'Gateway capacity is occupied or quarantined';
    if (this.state.ids.length >= this.config.maxRequests) return 'Gateway request limit reached';
    const hold = {
      id, input: this.config.inputReserve, output: this.config.outputLimit,
      inputPrice: this.config.inputNanoUsd, outputPrice: this.config.outputNanoUsd,
    };
    const exposure = this.state.settled + this.state.provisional + this.state.held.reduce((n, item) => n + reserveCost(item), 0);
    if (reserveCost(hold) > this.config.budgetNanoUsd - exposure) return 'Gateway cost budget exhausted';
    this.persist({
      ...this.state, ids: [...this.state.ids, id], held: [...this.state.held, hold],
    });
  }

  settle(id: string, usage?: TokenUsage): boolean {
    const hold = this.state.held.find((item) => item.id === id);
    if (!hold) return false;
    const settled = usage ? usage.inputTokens * hold.inputPrice + usage.outputTokens * hold.outputPrice : 0;
    this.persist({
      ...this.state,
      held: this.state.held.filter((item) => item !== hold),
      settled: this.state.settled + settled,
      provisional: this.state.provisional + (usage ? 0 : reserveCost(hold)),
      overrun: this.state.overrun || Boolean(usage && (usage.inputTokens > hold.input || usage.outputTokens > hold.output)),
    });
    return true;
  }

  snapshot() {
    return {
      held: this.state.held.length,
      settledNanoUsd: this.state.settled, provisionalNanoUsd: this.state.provisional,
      reservedNanoUsd: this.state.held.reduce((n, item) => n + reserveCost(item), 0),
      accepted: this.state.ids.length, blocked: this.state.overrun || this.broken,
    };
  }

  close(): void {
    this.unlock();
  }

  private load(): LedgerState {
    const state: LedgerState = JSON.parse(readFileSync(this.config.stateFile, 'utf8'));
    const safe = (n: number) => Number.isSafeInteger(n) && n >= 0;
    if (state.version !== 1 || !Array.isArray(state.ids) || !Array.isArray(state.held)
      || state.ids.length > 10_000 || state.held.length > 2 || !safe(state.settled) || !safe(state.provisional)
      || typeof state.overrun !== 'boolean' || state.ids.some((id) => typeof id !== 'string')
      || state.held.some(({ id, input, output, inputPrice, outputPrice }) => !state.ids.includes(id)
        || ![input, output, inputPrice, outputPrice].every(safe))) throw new Error('Invalid ledger');
    return state;
  }

  private persist(state: LedgerState): void {
    if (this.broken) throw new Error('Gateway ledger is unavailable');
    const { stateFile } = this.config;
    const temp = stateFile + '.tmp.local';
    try {
      const file = openSync(temp, 'w', 0o600);
      try {
        writeFileSync(file, JSON.stringify(state) + '\n');
        fsyncSync(file);
      } finally {
        closeSync(file);
      }
      renameSync(temp, stateFile);
      const dir = openSync(dirname(stateFile), 'r');
      try { fsyncSync(dir); } finally { closeSync(dir); }
      this.state = state;
    } catch {
      this.broken = true;
      throw new Error('Gateway ledger write failed');
    }
  }
}
