import path from 'node:path';

export interface Config {
  port: number;
  host: string;
  dbPath: string;
  masterKey: Buffer;
  adminPassword: string;
  allowInsecureSources: boolean;
  webDist: string;
}

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = [];

  const keyB64 = env.TSR_MASTER_KEY ?? '';
  const masterKey = Buffer.from(keyB64, 'base64');
  if (masterKey.length !== 32) problems.push('TSR_MASTER_KEY must be 32 bytes, base64-encoded. Generate one with: npm run keygen');

  const adminPassword = env.TSR_ADMIN_PASSWORD ?? '';
  if (adminPassword.length < 12) problems.push('TSR_ADMIN_PASSWORD must be at least 12 characters.');

  const port = Number(env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push('PORT must be a number between 1 and 65535.');

  if (problems.length) throw new ConfigError(`Configuration problems:\n- ${problems.join('\n- ')}\nSee .env.example.`);

  const root = path.resolve(import.meta.dirname, '..', '..');
  return {
    port,
    host: env.HOST ?? '127.0.0.1',
    dbPath: path.resolve(root, env.TSR_DB_PATH ?? './data/timesheet.sqlite'),
    masterKey,
    adminPassword,
    allowInsecureSources: env.TSR_ALLOW_INSECURE_SOURCES === 'true',
    webDist: path.resolve(root, 'web', 'dist'),
  };
}
