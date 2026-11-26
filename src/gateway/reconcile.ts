import { validTokenCount } from '../inference/types';
import { readConfig } from './config';
import { GatewayLedger } from './ledger';

const [id, input, output, ...extra] = process.argv.slice(2);
const inputTokens = Number(input);
const outputTokens = Number(output);
const unknown = input === 'unknown' && output === undefined;

try {
  if (process.env.SS_CONFIRM_TERMINAL !== 'YES' || !id || extra.length
    || (!unknown && (!/^\d+$/.test(input) || !/^\d+$/.test(output)
      || !validTokenCount(inputTokens) || !validTokenCount(outputTokens) || !validTokenCount(inputTokens + outputTokens)))) {
    throw new Error();
  }
  const ledger = new GatewayLedger(readConfig(process.env));
  try {
    if (!ledger.settle(id, unknown ? undefined : { inputTokens, outputTokens })) throw new Error();
  } finally {
    ledger.close();
  }
  console.log(unknown ? 'Confirmed terminal applied. Usage remains provisional.' : 'Confirmed terminal and usage applied.');
} catch {
  console.error('Reconciliation requires a stopped gateway, a pending request ID and authoritative terminal evidence.');
  process.exitCode = 1;
}
