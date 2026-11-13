import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AI_ASSIST_KINDS,
  EmailProviderSchema,
  SOURCE_TYPES,
  SourceConfigSchema,
  sourceSecretRef,
} from '../../shared/settings';
import type { Auth } from './auth/auth';
import type { SettingsService } from './settings/service';
import type { SecretStore } from './settings/secrets';
import type { EmployeeService } from './employees/service';
import type { RunService } from './runs/service';
import type { ImportService } from './runs/imports';
import type { AdjustmentService } from './runs/adjustments';
import { weeklyReportCsv } from './runs/export';
import type { Settings } from '../../shared/settings';
import { testSource } from './testers/sources';
import { testEmail, type EmailTestContext } from './testers/email';
import { assist, testGroq } from './ai/groq';
import { ProbeError, type FetchFn, type ProbeResult } from './testers/http';
import { AppError, badRequest, fromZod } from './errors';

export interface Deps {
  auth: Auth;
  settings: SettingsService;
  secrets: SecretStore;
  employees: EmployeeService;
  runs: RunService;
  imports: ImportService;
  adjustments: AdjustmentService;
  worklogsFor: (employeeId: number, from: string, to: string, settings: Settings) => unknown[];
  fetch: FetchFn;
  allowInsecureSources: boolean;
  smtpVerify?: EmailTestContext['smtpVerify'];
}

/** Use a typed (unsaved) secret if given, else the stored one. */
const pick = (typed: string | undefined, stored: () => string | undefined) => (typed && typed.trim() ? typed : stored());

async function timed(fn: () => Promise<ProbeResult>): Promise<ProbeResult & { latencyMs: number }> {
  const t0 = performance.now();
  try {
    const r = await fn();
    return { ...r, latencyMs: Math.round(performance.now() - t0) };
  } catch (e) {
    if (e instanceof ProbeError) return { ok: false, message: e.message, latencyMs: Math.round(performance.now() - t0) };
    throw e;
  }
}

function parse<T>(schema: z.ZodType<T>, body: unknown, prefix = ''): T {
  const r = schema.safeParse(body);
  if (!r.success) throw fromZod(r.error, prefix);
  return r.data;
}

export function registerRoutes(app: FastifyInstance, d: Deps) {
  const admin = { preHandler: d.auth.requireAdmin };
  const actor = (req: { session?: { sub: string } }) => req.session?.sub ?? 'unknown';

  app.get('/api/health', async () => ({ ok: true }));

  /* ---- auth ---- */
  app.post('/api/auth/login', async (req) => {
    const { password } = parse(z.object({ password: z.string().max(500) }), req.body);
    const { token, session } = d.auth.login(password, req.ip);
    d.settings.audit(session.sub, 'auth.login', `from ${req.ip}`);
    return { token, role: session.role, expiresAt: new Date(session.exp).toISOString() };
  });
  app.get('/api/auth/me', admin, async (req) => ({ role: req.session!.role }));

  /* ---- settings ---- */
  app.get('/api/settings', admin, async () => d.settings.response());
  app.put('/api/settings', admin, async (req) => d.settings.save(req.body, actor(req)));
  app.get('/api/audit', admin, async () => d.settings.auditLog());

  /* ---- connection tests (use the values currently in the form) ---- */
  app.post<{ Params: { type: string } }>('/api/tests/source/:type', admin, async (req) => {
    const type = parse(z.enum(SOURCE_TYPES), req.params.type);
    const body = parse(z.object({ source: SourceConfigSchema, apiKey: z.string().max(8000).optional() }), req.body);
    if (body.source.type !== type) throw badRequest('The source in the request does not match the URL.');
    const secret = pick(body.apiKey, () => d.secrets.get(sourceSecretRef(type)));
    const r = await timed(() => testSource(body.source, secret, { fetch: d.fetch, allowInsecure: d.allowInsecureSources }));
    return d.settings.recordTest(`source.${type}`, r, actor(req));
  });

  app.post('/api/tests/email', admin, async (req) => {
    const body = parse(
      z.object({
        emailProvider: EmailProviderSchema,
        secrets: z
          .object({
            gmailClientSecret: z.string().max(8000), gmailRefreshToken: z.string().max(8000),
            graphClientSecret: z.string().max(8000), smtpPassword: z.string().max(8000),
          })
          .partial()
          .default({}),
      }),
      req.body,
      'emailProvider',
    );
    const s = body.secrets ?? {};
    const r = await timed(() =>
      testEmail(
        body.emailProvider,
        {
          gmailClientSecret: pick(s.gmailClientSecret, () => d.secrets.get('email.gmail.clientSecret')),
          gmailRefreshToken: pick(s.gmailRefreshToken, () => d.secrets.get('email.gmail.refreshToken')),
          graphClientSecret: pick(s.graphClientSecret, () => d.secrets.get('email.graph.clientSecret')),
          smtpPassword: pick(s.smtpPassword, () => d.secrets.get('email.smtp.password')),
        },
        { fetch: d.fetch, smtpVerify: d.smtpVerify },
      ),
    );
    return d.settings.recordTest('email', r, actor(req));
  });

  app.post('/api/tests/ai', admin, async (req) => {
    const body = parse(z.object({ model: z.string().trim().min(1).max(100), apiKey: z.string().max(500).optional() }), req.body);
    const key = pick(body.apiKey, () => d.secrets.get('ai.groq.apiKey'));
    const r = await timed(() => testGroq(key, body.model, d.fetch));
    return d.settings.recordTest('ai', r, actor(req));
  });

  app.get<{ Querystring: { target?: string } }>('/api/tests/history', admin, async (req) => {
    const target = parse(z.string().regex(/^(source\.(jira|redmine|pulse|texpert)|email|ai)$/), req.query.target);
    return d.settings.testHistory(target);
  });

  /* ---- AI assist (template text only) ---- */
  app.post('/api/ai/assist', admin, async (req) => {
    const body = parse(z.object({ kind: z.enum(AI_ASSIST_KINDS), text: z.string().min(1).max(20000) }), req.body);
    const { settings } = d.settings.current();
    if (!settings.ai.enabled) throw badRequest('AI assist is turned off. Turn it on under AI assist and save.');
    const key = d.secrets.get('ai.groq.apiKey');
    if (!key) throw badRequest('Save a Groq API key under AI assist first.');
    try {
      return { text: await assist(body.kind, body.text, key, settings.ai.model, d.fetch) };
    } catch (e) {
      if (e instanceof ProbeError) throw new AppError(502, e.message);
      throw e;
    }
  });

  /* ---- timesheet checks ---- */
  const weekParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').optional();

  app.post('/api/runs', admin, async (req) => {
    const body = parse(z.object({ weekOf: weekParam }), req.body ?? {});
    return d.runs.run({ weekOf: body.weekOf, trigger: 'manual', actor: actor(req) });
  });
  app.get('/api/runs', admin, async () => d.runs.listRuns());
  app.get<{ Querystring: { week?: string } }>('/api/timesheets', admin, async (req) => d.runs.week(parse(weekParam, req.query.week)));
  app.get<{ Querystring: { week?: string } }>('/api/timesheets/export.csv', admin, async (req, reply) => {
    const w = d.runs.week(parse(weekParam, req.query.week));
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="timesheet-week${w.isoWeek}-${w.weekStart}.csv"`);
    return weeklyReportCsv(w);
  });
  app.get<{ Params: { id: string }; Querystring: { week?: string } }>('/api/timesheets/:id/worklogs', admin, async (req) => {
    const { settings } = d.settings.current();
    const w = d.runs.window(settings, parse(weekParam, req.query.week));
    return d.worklogsFor(Number(req.params.id), w.from, w.to, settings);
  });

  /* ---- worklog file import (Pulse until its API is confirmed) ---- */
  app.post('/api/imports/worklogs', admin, async (req) => {
    const r = d.imports.importWorklogs(req.body, actor(req));
    d.settings.audit(actor(req), 'worklogs.import', `${(req.body as { source?: string })?.source}: ${r.rows} rows ${r.from}..${r.to}`);
    return r;
  });
  app.get('/api/imports', admin, async () => d.imports.list());

  /* ---- approved leave and holidays ---- */
  app.get<{ Querystring: { from?: string; to?: string } }>('/api/adjustments', admin, async (req) =>
    d.adjustments.list(parse(weekParam, req.query.from), parse(weekParam, req.query.to)),
  );
  app.post('/api/adjustments', admin, async (req) => {
    const a = d.adjustments.create(req.body, actor(req));
    d.settings.audit(actor(req), 'adjustment.create', `${a.kind} ${a.date} ${a.employeeName ?? 'everyone'}`);
    return a;
  });
  app.delete<{ Params: { id: string } }>('/api/adjustments/:id', admin, async (req) => {
    d.adjustments.remove(Number(req.params.id));
    d.settings.audit(actor(req), 'adjustment.delete', req.params.id);
    return { ok: true };
  });

  /* ---- employees ---- */
  app.get('/api/employees', admin, async () => d.employees.list());
  app.post('/api/employees', admin, async (req) => {
    const e = d.employees.upsert(req.body);
    d.settings.audit(actor(req), 'employee.save', e.employeeCode);
    return e;
  });
  app.put<{ Params: { id: string } }>('/api/employees/:id', admin, async (req) => {
    const e = d.employees.update(Number(req.params.id), req.body);
    d.settings.audit(actor(req), 'employee.save', e.employeeCode);
    return e;
  });
  app.delete<{ Params: { id: string } }>('/api/employees/:id', admin, async (req) => {
    d.employees.remove(Number(req.params.id));
    d.settings.audit(actor(req), 'employee.delete', req.params.id);
    return { ok: true };
  });
  app.post('/api/employees/import', admin, async (req) => {
    const { csv } = parse(z.object({ csv: z.string().min(1).max(2_000_000) }), req.body);
    const r = d.employees.importCsv(csv);
    d.settings.audit(actor(req), 'employee.import', `${r.created} created, ${r.updated} updated`);
    return r;
  });
}
