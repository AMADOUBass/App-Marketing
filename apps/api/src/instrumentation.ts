// Preloaded with `node --import ./dist/instrumentation.js`, before any application module.
// Telemetry is opt-in: nothing starts and nothing is exported unless OTEL_EXPORTER_OTLP_ENDPOINT is set.
import { register } from 'node:module';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { HEALTH_PATH } from './common/paths.js';

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  // ESM apps need this loader hook so instrumentations can patch imported packages.
  // `module.register` is deprecated in Node 26, but OpenTelemetry only supports its own hook.mjs
  // (an async loader). Switch to `module.registerHooks` once OpenTelemetry documents it.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'app-api',
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req) => req.url === HEALTH_PATH,
      }),
      // Adds trace_id / span_id to every log line.
      new PinoInstrumentation(),
    ],
  });
  sdk.start();

  process.once('SIGTERM', () => {
    void sdk.shutdown();
  });
}
