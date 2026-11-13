import path from 'node:path';
import { buildApp } from './app';
import { ConfigError, loadConfig } from './config';

try {
  process.loadEnvFile(path.resolve(import.meta.dirname, '..', '..', '.env'));
} catch {
  /* no .env file: rely on the real environment */
}

try {
  const config = loadConfig();
  const { app } = await buildApp({ config, logger: true });
  await app.listen({ port: config.port, host: config.host });
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
}
