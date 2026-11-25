import { GatewayStreamingProvider } from '../inference/gateway-provider';
import { evaluateGateway } from './evaluation';
import { localGateway } from './fixtures';

const fixture = await localGateway();
try {
  const provider = await GatewayStreamingProvider.connect(fixture.config.token, fixture.origin);
  console.log(JSON.stringify(await evaluateGateway(provider, true, 'local SSE fixture simulation'),
    (_key, value) => value === undefined ? null : value, 2));
} finally {
  await fixture.close();
}
