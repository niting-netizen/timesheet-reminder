import fs from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import type { Config } from './config';
import { openDb, type Db } from './db';
import { deriveKey } from './crypto';
import { Auth } from './auth/auth';
import { SecretStore } from './settings/secrets';
import { SettingsService } from './settings/service';
import { EmployeeService } from './employees/service';
import { RunService } from './runs/service';
import { ImportService } from './runs/imports';
import { AdjustmentService } from './runs/adjustments';
import { registerRoutes, type Deps } from './routes';
import { AppError, fromZod } from './errors';

export interface BuildOptions {
  config: Pick<Config, 'dbPath' | 'masterKey' | 'adminPassword' | 'allowInsecureSources' | 'webDist'>;
  db?: Db;
  fetch?: typeof fetch;
  smtpVerify?: Deps['smtpVerify'];
  logger?: boolean;
  /** Test hooks */
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export async function buildApp(opts: BuildOptions): Promise<{ app: FastifyInstance; db: Db }> {
  const { config } = opts;
  const db = opts.db ?? openDb(config.dbPath);
  const secrets = new SecretStore(db, deriveKey(config.masterKey, 'secrets'));
  const settings = new SettingsService(db, secrets);
  const imports = new ImportService(db);
  const adjustments = new AdjustmentService(db);
  const fetchFn = opts.fetch ?? fetch;
  const runs = new RunService({
    db, settings, secrets, imports, adjustments,
    connector: { fetch: fetchFn, allowInsecure: config.allowInsecureSources, sleep: opts.sleep },
    now: opts.now,
  });
  const deps: Deps = {
    auth: new Auth(deriveKey(config.masterKey, 'session'), config.adminPassword),
    settings,
    secrets,
    employees: new EmployeeService(db),
    runs,
    imports,
    adjustments,
    worklogsFor: (employeeId, from, to, s) => {
      const origin = Object.fromEntries(s.sources.map((x) => [x.type, x.authType === 'csv_import' ? 'import' : 'api']));
      return (
        db
          .prepare(
            `SELECT w.source, w.origin, w.issue_key AS issueKey, w.project, w.work_date AS workDate, w.seconds
             FROM worklogs w
             WHERE w.work_date BETWEEN ? AND ? AND (
               EXISTS (SELECT 1 FROM source_accounts a WHERE a.employee_id = ? AND a.source = w.source AND a.external_user_id = w.external_user_id)
               OR w.external_user_id = 'emp:' || (SELECT employee_code FROM employees WHERE id = ?))
             ORDER BY w.work_date, w.source, w.issue_key`,
          )
          .all(from, to, employeeId, employeeId) as { source: string; origin: string }[]
      ).filter((r) => origin[r.source] === r.origin);
    },
    fetch: fetchFn,
    allowInsecureSources: config.allowInsecureSources,
    smtpVerify: opts.smtpVerify,
  };

  const app = Fastify({
    logger: opts.logger
      ? { level: 'info', redact: ['req.headers.authorization', 'req.body'] }
      : false,
    bodyLimit: 3 * 1024 * 1024,
    trustProxy: false,
  });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy',
      "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: err.message, fieldErrors: err.fieldErrors });
    }
    if (err instanceof ZodError) {
      const e = fromZod(err);
      return reply.status(400).send({ error: e.message, fieldErrors: e.fieldErrors });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: (err as Error).message });
    req.log.error(err);
    return reply.status(500).send({ error: 'Something went wrong on the server. Check the server log.' });
  });

  registerRoutes(app, deps);

  if (fs.existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'Not found' });
      return reply.sendFile('index.html');
    });
  }

  return { app, db };
}
