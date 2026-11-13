import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { openDb } from '../src/db';
import { defaultSettings } from '../../shared/defaults';
import type { CheckRun, WeekTimesheets } from '../../shared/settings';

/* ---------- a fake Jira + Redmine ---------- */
const H = 3600;
type JiraLog = { id: string; issue: string; account: string; name: string; started: string; secs: number };
let jiraLogs: JiraLog[];
let redmineEntries: { id: number; user: number; name: string; spent_on: string; hours: number }[];
let jiraStatus: number;
let jira429Once: boolean;
const calls: string[] = [];

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function fakeFetch(input: string | URL | Request): Promise<Response> {
  const url = new URL(String(input));
  calls.push(url.pathname);
  if (url.host === 'acme.atlassian.net') {
    if (jira429Once) { jira429Once = false; return json(429, {}); }
    if (jiraStatus !== 200) return json(jiraStatus, {});
    if (url.pathname === '/rest/api/3/search/jql') {
      expect(url.searchParams.get('jql')).toContain('worklogDate >= "2026-11-08"');
      const issues = [...new Set(jiraLogs.map((l) => l.issue))].sort();
      // two pages to exercise nextPageToken
      if (!url.searchParams.get('nextPageToken')) return json(200, { issues: issues.slice(0, 1).map((key) => ({ key, fields: { project: { key: 'ACME' } } })), nextPageToken: 'p2', isLast: false });
      return json(200, { issues: issues.slice(1).map((key) => ({ key, fields: { project: { key: 'ACME' } } })), isLast: true });
    }
    const m = /^\/rest\/api\/3\/issue\/([^/]+)\/worklog$/.exec(url.pathname);
    if (m) {
      const all = jiraLogs.filter((l) => l.issue === m[1]);
      const startAt = Number(url.searchParams.get('startAt'));
      const page = all.slice(startAt, startAt + 2); // tiny pages to exercise pagination
      return json(200, {
        startAt, maxResults: 2, total: all.length,
        worklogs: page.map((l) => ({ id: l.id, started: l.started, timeSpentSeconds: l.secs, author: { accountId: l.account, displayName: l.name } })),
      });
    }
  }
  if (url.host === 'rm.example.com' && url.pathname === '/time_entries.json') {
    const offset = Number(url.searchParams.get('offset'));
    const page = redmineEntries.slice(offset, offset + 1);
    return json(200, {
      total_count: redmineEntries.length, offset, limit: 1,
      time_entries: page.map((e) => ({ id: e.id, hours: e.hours, spent_on: e.spent_on, user: { id: e.user, name: e.name }, project: { id: 1, name: 'Ops' } })),
    });
  }
  return json(404, {});
}

/* ---------- app ---------- */
let app: FastifyInstance;
let token: string;
const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as object, headers: { authorization: `Bearer ${token}` } });

beforeEach(async () => {
  calls.length = 0;
  jiraStatus = 200;
  jira429Once = false;
  jiraLogs = [
    // Ann: Monday 00:30 IST is still Sunday in UTC — must count for this week (scenario 13)
    { id: 'w1', issue: 'ACME-1', account: 'acc-ann', name: 'Ann', started: '2026-11-09T00:30:00.000+0530', secs: 8 * H },
    { id: 'w2', issue: 'ACME-1', account: 'acc-ann', name: 'Ann', started: '2026-11-10T09:00:00.000+0530', secs: 16 * H },
    { id: 'w3', issue: 'ACME-1', account: 'acc-ann', name: 'Ann', started: '2026-11-12T09:00:00.000+0530', secs: 16 * H },
    // next week's log — ignored
    { id: 'w4', issue: 'ACME-2', account: 'acc-ann', name: 'Ann', started: '2026-11-16T01:00:00.000+0530', secs: 8 * H },
    { id: 'w5', issue: 'ACME-2', account: 'acc-cara', name: 'Cara', started: '2026-11-11T10:00:00.000+0530', secs: 20 * H },
    { id: 'w6', issue: 'ACME-2', account: 'acc-zz', name: 'Zed Unknown', started: '2026-11-11T10:00:00.000+0530', secs: 5 * H },
  ];
  redmineEntries = [
    { id: 1, user: 7, name: 'Bob', spent_on: '2026-11-10', hours: 16 },
    { id: 2, user: 7, name: 'Bob', spent_on: '2026-11-11', hours: 16 },
  ];

  ({ app } = await buildApp({
    config: { dbPath: ':memory:', masterKey: randomBytes(32), adminPassword: 'pw-for-tests-123', allowInsecureSources: false, webDist: '/x' },
    db: openDb(':memory:'),
    fetch: fakeFetch as typeof fetch,
    sleep: async () => {},
    now: () => new Date('2026-11-13T06:00:00Z'), // Friday 11:30 IST
  }));
  token = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'pw-for-tests-123' } })).json().token;

  const s = defaultSettings();
  s.sources[0] = { ...s.sources[0]!, baseUrl: 'https://acme.atlassian.net', username: 'svc@acme.com' };
  s.sources[1] = { ...s.sources[1]!, baseUrl: 'https://rm.example.com' };
  s.sources[2] = { ...s.sources[2]!, authType: 'csv_import' };
  const r = await call('PUT', '/api/settings', { version: 0, settings: s, secrets: { 'source.jira.apiKey': 'tok', 'source.redmine.apiKey': 'rk' } });
  expect(r.statusCode).toBe(200);

  const emp = (employeeCode: string, name: string, accounts: Record<string, string>) =>
    call('POST', '/api/employees', { employeeCode, name, email: `${name.toLowerCase()}@example.com`, accounts });
  await emp('1', 'Ann', { jira: 'acc-ann' });
  await emp('2', 'Bob', { redmine: '7' });
  await emp('3', 'Cara', { jira: 'acc-cara', pulse: 'p-cara' });
  await emp('4', 'Dan', {});
  await emp('5', 'Eve', { jira: 'acc-eve' });
});
afterEach(() => app.close());

const run = async () => (await call('POST', '/api/runs', {})).json() as CheckRun;
const week = async () => (await call('GET', '/api/timesheets')).json() as WeekTimesheets;
const row = (w: WeekTimesheets, name: string) => w.rows.find((r) => r.name === name)!;
const empId = async (name: string) => (await call('GET', '/api/employees')).json().find((e: { name: string }) => e.name === name).id;

describe('timesheet check', () => {
  it('fetches, attributes by author in the company timezone, and judges each employee', async () => {
    const r = await run();
    expect(r.weekStart).toBe('2026-11-09');
    expect(r.weekEnd).toBe('2026-11-13');
    expect(r.status).toBe('partial'); // Pulse file not imported yet
    expect(r.sources.find((s) => s.source === 'jira')).toMatchObject({ status: 'ok', worklogs: 5 });
    expect(r.sources.find((s) => s.source === 'pulse')).toMatchObject({ status: 'not_received' });
    expect(r.unmapped).toEqual([{ source: 'jira', externalUserId: 'acc-zz', authorName: 'Zed Unknown', seconds: 5 * H }]);

    const w = await week();
    expect(row(w, 'Ann')).toMatchObject({ status: 'complete', loggedSeconds: 40 * H, pendingSeconds: 0 });
    expect(row(w, 'Bob')).toMatchObject({ status: 'pending', loggedSeconds: 32 * H, pendingSeconds: 8 * H });
    expect(row(w, 'Cara').status).toBe('source_missing'); // uses Pulse, no data → not judged
    expect(row(w, 'Dan').status).toBe('unmapped');
    expect(row(w, 'Eve')).toMatchObject({ status: 'pending', loggedSeconds: 0, pendingSeconds: 40 * H }); // zero worklogs included
    expect(r.counts).toEqual({ employees: 5, complete: 1, pending: 2, sourceMissing: 1, unmapped: 1 });
  });

  it('a Pulse file import completes the data; re-import replaces, not adds', async () => {
    const csv = 'user_id,date,hours,issue_key\np-cara,2026-11-12,12,PUL-1\np-cara,13/11/2026,8,PUL-2\n';
    const imp = await call('POST', '/api/imports/worklogs', { source: 'pulse', from: '2026-11-09', to: '2026-11-13', csv });
    expect(imp.json()).toMatchObject({ rows: 2 });
    await call('POST', '/api/imports/worklogs', { source: 'pulse', from: '2026-11-09', to: '2026-11-13', csv });
    const r = await run();
    expect(r.status).toBe('success');
    expect(row(await week(), 'Cara')).toMatchObject({ status: 'complete', loggedSeconds: 40 * H, bySource: { jira: 20 * H, pulse: 20 * H } });
  });

  it('rejects an import row outside the declared period', async () => {
    const r = await call('POST', '/api/imports/worklogs', { source: 'pulse', from: '2026-11-09', to: '2026-11-13', csv: 'user_id,date,hours\np,2026-11-20,4\n' });
    expect(r.statusCode).toBe(400);
    expect(r.json().fieldErrors[0].message).toMatch(/outside the period/);
  });

  it('approved leave lowers the target; unapproved does not (scenarios 5, 6)', async () => {
    await call('POST', '/api/adjustments', { employeeId: await empId('Bob'), date: '2026-11-13', kind: 'leave', hours: null, approved: true });
    await call('POST', '/api/adjustments', { employeeId: await empId('Eve'), date: '2026-11-13', kind: 'leave', hours: null, approved: false });
    await run();
    const w = await week();
    expect(row(w, 'Bob')).toMatchObject({ status: 'complete', targetSeconds: 32 * H, daysOff: 1 });
    expect(row(w, 'Eve').targetSeconds).toBe(40 * H);
  });

  it('a public holiday lowers everyone’s target (scenario 7)', async () => {
    await call('POST', '/api/adjustments', { employeeId: null, date: '2026-11-11', kind: 'holiday', hours: null, approved: true });
    await run();
    const w = await week();
    expect(row(w, 'Bob')).toMatchObject({ targetSeconds: 32 * H, status: 'complete' });
    expect(row(w, 'Eve').targetSeconds).toBe(32 * H);
  });

  it('an edited or deleted worklog is reflected on the next check (scenario 8)', async () => {
    await run();
    jiraLogs = jiraLogs.filter((l) => l.id !== 'w3');
    await run();
    expect(row(await week(), 'Ann')).toMatchObject({ status: 'pending', loggedSeconds: 24 * H });
  });

  it('a failing source flags only its employees; others are still judged (scenario 9)', async () => {
    jiraStatus = 401;
    const r = await run();
    expect(r.sources.find((s) => s.source === 'jira')).toMatchObject({ status: 'failed' });
    expect(r.sources.find((s) => s.source === 'jira')!.message).toMatch(/401/);
    const w = await week();
    expect(row(w, 'Ann').status).toBe('source_missing');
    expect(row(w, 'Eve').status).toBe('source_missing');
    expect(row(w, 'Bob').status).toBe('pending');
  });

  it('retries after a rate limit (429)', async () => {
    jira429Once = true;
    const r = await run();
    expect(r.sources.find((s) => s.source === 'jira')!.status).toBe('ok');
  });

  it('employee drill-down lists their worklogs', async () => {
    await run();
    const logs = (await call('GET', `/api/timesheets/${await empId('Ann')}/worklogs`)).json();
    expect(logs.map((l: { workDate: string }) => l.workDate)).toEqual(['2026-11-09', '2026-11-10', '2026-11-12']);
  });

  it('imports the weekly report layout by EMP ID, even for people without a Pulse account ID', async () => {
    // Same layout as the manual report: pending shown negative, one decimal.
    const csv = [
      'EMP ID,EMP Name,Filled Hours,Need to fill hours,Pending hours',
      '3,Cara,20.0,40.0,-20.0',
      '5,Eve,0.0,40.0,-40.0',
      '4,Dan,32.0,40.0,-8.0',
      '999,Not In Master,12.5,40.0,-27.5',
    ].join('\r\n');
    const imp = await call('POST', '/api/imports/worklogs', { source: 'pulse', from: '2026-11-09', to: '2026-11-13', csv: '﻿' + csv });
    expect(imp.statusCode).toBe(200);
    const r = await run();
    expect(r.sources.find((s) => s.source === 'pulse')!.status).toBe('ok');
    const w = await week();
    expect(row(w, 'Cara')).toMatchObject({ status: 'complete', bySource: { jira: 20 * H, pulse: 20 * H } });
    // Dan has no account IDs at all, but the file lists him by EMP ID: judged, not "unmapped"
    expect(row(w, 'Dan')).toMatchObject({ status: 'pending', loggedSeconds: 32 * H, sources: ['pulse'] });
    expect(row(w, 'Eve').status).toBe('pending');
    expect(r.unmapped).toContainEqual({ source: 'pulse', externalUserId: 'emp:999', authorName: 'Not In Master', seconds: 12.5 * H });
  });

  it('rejects a weekly file with a bad number or a repeated EMP ID', async () => {
    const csv = 'EMP ID,EMP Name,Filled Hours,Need to fill hours,Pending hours\n3,Cara,abc,40,-40\n3,Cara,1,40,-39\n';
    const r = await call('POST', '/api/imports/worklogs', { source: 'pulse', from: '2026-11-09', to: '2026-11-13', csv });
    expect(r.statusCode).toBe(400);
    expect(r.json().fieldErrors.map((e: { message: string }) => e.message).join(' ')).toMatch(/Filled Hours "abc".*more than once/);
  });

  it('exports the weekly report with the agreed headers, and the export imports back', async () => {
    await run();
    const res = await call('GET', '/api/timesheets/export.csv');
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('timesheet-week46-2026-11-09.csv');
    const lines = res.body.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toBe('EMP ID,EMP Name,Filled Hours,Need to fill hours,Pending hours');
    expect(lines).toContain('1,Ann,40.0,40.0,0.0');
    expect(lines).toContain('2,Bob,32.0,40.0,-8.0');
    expect(lines).toContain('5,Eve,0.0,40.0,-40.0');
    expect(lines).toContain('3,Cara,20.0,40.0,Source data missing');
    expect(lines).toContain('4,Dan,0.0,40.0,No source account');

    // Round trip: the exported file is accepted by the import.
    const back = await call('POST', '/api/imports/worklogs', {
      source: 'pulse', from: '2026-11-09', to: '2026-11-13',
      csv: lines.filter((l) => !/Source data missing|No source account/.test(l)).join('\n'),
    });
    expect(back.statusCode).toBe(200);
  });

  it('can check a past week', async () => {
    const r = (await call('POST', '/api/runs', { weekOf: '2026-11-04' })).json();
    expect(r.weekStart).toBe('2026-11-02');
    expect(r.weekEnd).toBe('2026-11-06');
  });
});
