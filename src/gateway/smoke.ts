import { GatewayStreamingProvider } from '../inference/gateway-provider';
import { evaluateGateway } from './evaluation';

try {
  const token = process.env.SS_GATEWAY_TOKEN;
  const port = Number(process.env.SS_PORT ?? 4180);
  if (process.env.SS_RUN_REAL_SMOKE !== 'YES' || !token
    || !Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new Error('Set SS_RUN_REAL_SMOKE=YES and configure the gateway token and port before running.');
  }
  const adapter = await GatewayStreamingProvider.connect(token, 'http://127.0.0.1:' + port);
  const report = await evaluateGateway(adapter, process.argv.includes('--compare'), 'network measurement via configured gateway');
  console.log(JSON.stringify(report, (_key, value) => value === undefined ? null : value, 2));
  const completed = report.variants.every((variant) => variant.pendingUpstreamSlots === 0
    && variant.tasks?.some((task) => task.outcome === 'completed' && !task.unanswered));
  if (!completed) process.exitCode = 1;
} catch (error) {
  const message = error instanceof Error ? error.message : '';
  console.error(/^(Set SS_RUN_REAL_SMOKE|Gateway must be idle)/.test(message) ? message : 'Gateway smoke test could not run.');
  process.exitCode = 1;
}
