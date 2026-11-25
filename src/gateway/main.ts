import { readConfig } from './config';
import { createGateway } from './server';

try {
  const config = readConfig(process.env);
  const app = createGateway(config);
  app.server.once('error', () => {
    console.error('Could not listen on the configured loopback port.');
    void app.close().finally(() => { process.exitCode = 1; });
  });
  app.server.listen(config.port, '127.0.0.1', () => {
    console.log('SemanticStream gateway listening at http://127.0.0.1:' + config.port + '/runtime.html');
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      void app.close().catch(() => { process.exitCode = 1; });
    });
  }
} catch (error) {
  const message = error instanceof Error ? error.message : 'Invalid gateway setup';
  // Configuration values, file paths and provider errors can contain secrets.
  console.error(/^(Required gateway setting:|Invalid gateway setting:)/.test(message) ? message : 'Gateway could not start. Check the documented config and ledger lock.');
  process.exitCode = 1;
}
