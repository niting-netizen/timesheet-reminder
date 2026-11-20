import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { openDb } from '../src/db';
import type { Scheduler } from '../src/scheduler';
import { defaultSettings } from '../../shared/defaults';
import type { EmailMessage, SendSummary, Settings } from '../../shared/settings';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const deadFetch = async () => json(404, {}); // no source APIs are used (Pulse is file-import)

// Captures every SMTP delivery instead of opening a socket.
let smtpCalls: { to: string[]; cc: string[]; subject: string; html: string }[];
const smtpSend = async (_o: unknown, m: { to: string[]; cc: string[]; subject: string; html: string }) => {
  smtpCalls.push({ to: m.to, cc: m.cc, subject: m.subject, html: m.html });
  return `smtp-${smtpCalls.length}`;
};

let app: FastifyInstance;
let token: string;
const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as object, headers: { authorization: `Bearer ${token}` } });

/** Settings with only Pulse (file import) enabled, SMTP provider, and a broadcast list. */
function emailSettings(over: (s: Settings) => void = () => {}): Settings {
  const s = defaultSettings();
  s.sources[0] = { ...s.sources[0]!, enabled: false };
  s.sources[1] = { ...s.sources[1]!, enabled: false };
  s.sources[2] = { ...s.sources[2]!, enabled: true, authType: 'csv_import' };
  s.emailProvider = { ...s.emailProvider, type: 'smtp', from: 'timesheet@acme.com', fromName: 'Timesheet', smtp: { host: 'smtp.acme.com', port: 587, security: 'starttls', user: 'svc' } };
  s.recipients = { broadcastList: ['team@acme.com'], customList: ['lead@acme.com'], cc: ['cc@acme.com'] };
  s.signature = { name: 'Nitin', title: 'QA Lead', addresses: 'Mumbai' };
  s.tickets = { leave: 'LEAVE-1', holiday: 'HOL-1', bench: 'BENCH-1' };
  s.dryRun = false;
  over(s);
  return s;
}

async function setup(now: string, settings: Settings) {
  smtpCalls = [];
  const built = await buildApp({
    config: { dbPath: ':memory:', masterKey: randomBytes(32), adminPassword: 'pw-for-tests-123', allowInsecureSources: false, webDist: '/x' },
    db: openDb(':memory:'),
    fetch: deadFetch as unknown as typeof fetch,
    smtpSend,
    now: () => new Date(now),
  });
  app = built.app;
  token = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'pw-for-tests-123' } })).json().token;
  await call('PUT', '/api/settings', { version: 0, settings });
  const emp = (code: string, name: string) => call('POST', '/api/employees', { employeeCode: code, name, email: `${name.toLowerCase()}@acme.com`, accounts: { pulse: `p-${name.toLowerCase()}` } });
  await emp('1', 'Ann');
  await emp('2', 'Bob');
  await emp('3', 'Cara');
  // Weekly totals: Ann complete (40h), Bob pending (20h); Cara absent from the file but
  // mapped to Pulse, so she is pending with 0h.
  const csv = ['EMP ID,EMP Name,Filled Hours,Need to fill hours,Pending hours', '1,Ann,40,40,0', '2,Bob,20,40,-20'].join('\n');
  await call('POST', '/api/imports/worklogs', { source: 'pulse', from: '2026-11-09', to: '2026-11-13', csv });
  await call('POST', '/api/runs', {});
  return built.scheduler;
}
afterEach(() => app?.close());

const FRIDAY = '2026-11-13T06:00:00Z'; // Fri 11:30 IST, week Mon 09 .. Fri 13 Nov 2026

describe('reminder email sending', () => {
  beforeEach(async () => { await setup(FRIDAY, emailSettings()); });

  it('broadcast mode sends one email with the pending table, and dedupes on repeat', async () => {
    const r = (await call('POST', '/api/reminders/send', { eventId: 'R3' })).json() as SendSummary;
    expect(r).toMatchObject({ sent: 1, dryRunCount: 0, skipped: 0, failed: 0, dryRun: false });
    expect(smtpCalls).toHaveLength(1);
    expect(smtpCalls[0]!.to).toEqual(['team@acme.com']);
    expect(smtpCalls[0]!.cc).toEqual(['cc@acme.com']);
    // Pending table lists Bob and Cara (not Ann, who is complete).
    expect(smtpCalls[0]!.html).toContain('Bob');
    expect(smtpCalls[0]!.html).toContain('Cara');
    expect(smtpCalls[0]!.html).not.toContain('Ann');

    const again = (await call('POST', '/api/reminders/send', { eventId: 'R3' })).json() as SendSummary;
    expect(again).toMatchObject({ sent: 0, skipped: 1 });
    expect(smtpCalls).toHaveLength(1); // no second delivery
  });

  it('individual mode sends one private email per pending employee and never leaks others', async () => {
    const s = emailSettings((x) => { x.schedule.events[2] = { ...x.schedule.events[2]!, mode: 'individual' }; });
    await call('PUT', '/api/settings', { version: 1, settings: s });

    const r = (await call('POST', '/api/reminders/send', { eventId: 'R3' })).json() as SendSummary;
    expect(r.sent).toBe(2);
    const to = smtpCalls.map((c) => c.to[0]).sort();
    expect(to).toEqual(['bob@acme.com', 'cara@acme.com']);
    const bob = smtpCalls.find((c) => c.to[0] === 'bob@acme.com')!;
    expect(bob.to).toHaveLength(1);
    expect(bob.html).toContain('Bob');
    expect(bob.html).not.toContain('Cara'); // privacy: only the recipient's own data
  });

  it('custom mode sends to exactly the custom list', async () => {
    const s = emailSettings((x) => { x.schedule.events[2] = { ...x.schedule.events[2]!, mode: 'custom' }; });
    await call('PUT', '/api/settings', { version: 1, settings: s });
    const r = (await call('POST', '/api/reminders/send', { eventId: 'R3' })).json() as SendSummary;
    expect(r.sent).toBe(1);
    expect(smtpCalls[0]!.to).toEqual(['lead@acme.com']);
  });

  it('dry run records what would go out but sends nothing', async () => {
    const s = emailSettings((x) => { x.dryRun = true; });
    await call('PUT', '/api/settings', { version: 1, settings: s });
    const r = (await call('POST', '/api/reminders/send', { eventId: 'R3' })).json() as SendSummary;
    expect(r).toMatchObject({ sent: 0, dryRunCount: 1, dryRun: true });
    expect(smtpCalls).toHaveLength(0);
    const history = (await call('GET', '/api/emails')).json() as EmailMessage[];
    expect(history[0]).toMatchObject({ status: 'dry_run', eventId: 'R3' });
  });

  it('send-test delivers one message to a chosen address, ignoring dry-run and dedupe', async () => {
    const s = emailSettings((x) => { x.dryRun = true; });
    await call('PUT', '/api/settings', { version: 1, settings: s });
    const r1 = await call('POST', '/api/reminders/test', { eventId: 'R1', to: 'me@acme.com' });
    expect(r1.statusCode).toBe(200);
    const r2 = await call('POST', '/api/reminders/test', { eventId: 'R1', to: 'me@acme.com' });
    expect(r2.statusCode).toBe(200);
    expect(smtpCalls).toHaveLength(2); // sent both times despite dry-run and same recipient
    expect(smtpCalls[0]!.to).toEqual(['me@acme.com']);
  });

  it('records a failure when the provider rejects the message', async () => {
    smtpCalls = [];
    // Replace the transport with one that throws an auth error on the next app.
    const built = await buildApp({
      config: { dbPath: ':memory:', masterKey: randomBytes(32), adminPassword: 'pw-for-tests-123', allowInsecureSources: false, webDist: '/x' },
      db: openDb(':memory:'),
      fetch: deadFetch as unknown as typeof fetch,
      smtpSend: async () => { const e = new Error('bad'); (e as { code?: string }).code = 'EAUTH'; throw e; },
      now: () => new Date(FRIDAY),
    });
    app = built.app;
    token = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'pw-for-tests-123' } })).json().token;
    await call('PUT', '/api/settings', { version: 0, settings: emailSettings() });
    await call('POST', '/api/employees', { employeeCode: '2', name: 'Bob', email: 'bob@acme.com', accounts: { pulse: 'p-bob' } });
    await call('POST', '/api/imports/worklogs', { source: 'pulse', from: '2026-11-09', to: '2026-11-13', csv: 'EMP ID,EMP Name,Filled Hours,Need to fill hours,Pending hours\n2,Bob,20,40,-20' });
    await call('POST', '/api/runs', {});
    const r = (await call('POST', '/api/reminders/send', { eventId: 'R3' })).json() as SendSummary;
    expect(r).toMatchObject({ sent: 0, failed: 1 });
    const history = (await call('GET', '/api/emails')).json() as EmailMessage[];
    expect(history[0]!.status).toBe('failed');
    expect(history[0]!.error).toMatch(/rejected the username or password/);
  });
});

describe('scheduler', () => {
  let scheduler: Scheduler;

  it('fires the event due this minute, then dedupes within the same minute', async () => {
    // Thursday 11:00 IST = R1 (general reminder, broadcast).
    scheduler = await setup('2026-11-12T05:30:00Z', emailSettings());
    await scheduler.tick();
    expect(smtpCalls).toHaveLength(1);
    expect(smtpCalls[0]!.to).toEqual(['team@acme.com']);
    const history = (await call('GET', '/api/emails')).json() as EmailMessage[];
    expect(history[0]).toMatchObject({ eventId: 'R1', trigger: 'scheduled', status: 'sent' });

    await scheduler.tick(); // same minute again
    expect(smtpCalls).toHaveLength(1); // not resent
  });

  it('does nothing at a minute with no scheduled event', async () => {
    scheduler = await setup('2026-11-12T04:00:00Z', emailSettings()); // Thu 09:30 IST
    await scheduler.tick();
    expect(smtpCalls).toHaveLength(0);
  });

  it('is paused by the paused flag', async () => {
    scheduler = await setup('2026-11-12T05:30:00Z', emailSettings((s) => { s.schedule.paused = true; }));
    await scheduler.tick();
    expect(smtpCalls).toHaveLength(0);
  });

  it('skips a pending report when nobody is pending', async () => {
    // Friday 13:00 IST = R3. Make everyone complete so nobody is pending.
    scheduler = await setup('2026-11-13T07:30:00Z', emailSettings());
    // Re-import so everyone is complete (nobody pending).
    await call('POST', '/api/imports/worklogs', { source: 'pulse', from: '2026-11-09', to: '2026-11-13', csv: ['EMP ID,EMP Name,Filled Hours,Need to fill hours,Pending hours', '1,Ann,40,40,0', '2,Bob,40,40,0', '3,Cara,40,40,0'].join('\n') });
    await scheduler.tick();
    expect(smtpCalls).toHaveLength(0);
  });
});
