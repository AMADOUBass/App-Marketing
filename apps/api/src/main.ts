import { createApp } from './app.js';
import { InvalidEnvError, parseEnv } from './config/env.js';

async function bootstrap(): Promise<void> {
  const env = parseEnv(process.env);
  const app = await createApp(env);
  await app.listen(env.PORT, env.HOST);
}

try {
  await bootstrap();
} catch (error) {
  // The logger may not exist yet (e.g. invalid env), so write straight to stderr.
  const message = error instanceof InvalidEnvError ? error.message : String(error);
  process.stderr.write(`Failed to start api: ${message}\n`);
  process.exit(1);
}
