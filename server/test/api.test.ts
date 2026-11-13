import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { openDb } from '../src/db';
import { defaultSettings } from '../../shared/defaults';
import type { SettingsResponse } from '../../shared/settings';

const PASSWORD = 'correct-horse-battery';
let app: FastifyInstance;
let token: string;
let fetchMock: ReturnType<typeof vi.fn>;
let smtpVerify: ReturnType<typeof vi.fn>;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(async () => {
  fetchMock = vi.fn();
  smtpVerify = vi.fn();
  ({ app } = await buildApp({
    config: { dbPath: ':memory:', masterKey: randomBytes(32), adminPassword: PASSWORD, allowInsecureSources: false, webDist: '/nonexistent' },
    db: openDb(':memory:'),
    fetch: fetchMock as unknown as typeof fetch,
    smtpVerify: smtpVerify as never,
  }));
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: PASSWORD } });
  token = r.json().token;
});
afterEach(() => app.close());

const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as object, headers: { authorization: `Bearer ${token}` } });

async function loadSettings(): Promise<SettingsResponse> {
  return (await call('GET', '/api/settings')).json();
}
function validSettings() {
  const s = defaultSettings();
  s.recipients.broadcastList = ['all@example.com'];
  return s;
}

describe('auth', () => {
  it('rejects a wrong password and unauthenticated calls', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'nope' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/settings' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/settings', headers: { authorization: 'Bearer forged.sig' } })).statusCode).toBe(401);
  });
});

describe('settings', () => {
  it('starts from defaults at version 0', async () => {
    const s = await loadSettings();
    expect(s.version).toBe(0);
    expect(s.settings.week.weeklyHours).toBe(40);
    expect(s.secrets['source.jira.apiKey']).toEqual({ set: false });
  });

  it('saves settings and secrets, and never returns a secret value (scenario 21)', async () => {
    const settings = validSettings();
    settings.emailProvider.from = 'Timesheet@Example.com';
    const r = await call('PUT', '/api/settings', {
      version: 0, settings, secrets: { 'source.jira.apiKey': 'jira-secret-123', 'ai.groq.apiKey': 'gsk_supersecretvalue' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain('jira-secret-123');
    expect(r.body).not.toContain('gsk_supersecretvalue');
    const s = r.json() as SettingsResponse;
    expect(s.version).toBe(1);
    expect(s.settings.emailProvider.from).toBe('timesheet@example.com');
    expect(s.secrets['source.jira.apiKey'].set).toBe(true);

    const all = await Promise.all(['/api/settings', '/api/audit'].map((u) => call('GET', u)));
    for (const res of all) expect(res.body).not.toContain('jira-secret-123');
  });

  it('keeps a stored secret when the field is left empty, and clears on request', async () => {
    await call('PUT', '/api/settings', { version: 0, settings: validSettings(), secrets: { 'email.smtp.password': 'pw-1' } });
    let s = (await call('PUT', '/api/settings', { version: 1, settings: validSettings(), secrets: { 'email.smtp.password': '' } })).json();
    expect(s.secrets['email.smtp.password'].set).toBe(true);
    s = (await call('PUT', '/api/settings', { version: 2, settings: validSettings(), clearSecrets: ['email.smtp.password'] })).json();
    expect(s.secrets['email.smtp.password'].set).toBe(false);
  });

  it('rejects a stale version with 409', async () => {
    await call('PUT', '/api/settings', { version: 0, settings: validSettings() });
    const r = await call('PUT', '/api/settings', { version: 0, settings: validSettings() });
    expect(r.statusCode).toBe(409);
  });

  it('returns field errors for invalid settings', async () => {
    const s = validSettings();
    s.week.startDay = 'FRI';
    s.week.endDay = 'MON';
    s.emailProvider.from = 'not-an-email';
    const r = await call('PUT', '/api/settings', { version: 0, settings: s });
    expect(r.statusCode).toBe(400);
    const paths = r.json().fieldErrors.map((e: { path: string }) => e.path);
    expect(paths).toContain('emailProvider.from');
  });

  it('requires a custom list when live sending uses custom mode (scenario 25)', async () => {
    const s = validSettings();
    s.dryRun = false;
    s.schedule.events[2]!.mode = 'custom';
    const r = await call('PUT', '/api/settings', { version: 0, settings: s });
    expect(r.statusCode).toBe(400);
    expect(r.json().fieldErrors[0].path).toBe('recipients.customList');
  });

  it('lets a fresh install save in dry run before recipient lists exist', async () => {
    const r = await call('PUT', '/api/settings', { version: 0, settings: defaultSettings(), secrets: { 'source.jira.apiKey': 'k' } });
    expect(r.statusCode).toBe(200);
  });
});

describe('connection tests', () => {
  const jira = { ...defaultSettings().sources[0]!, baseUrl: 'https://acme.atlassian.net', username: 'svc@acme.com' };

  it('Jira Cloud: calls /rest/api/3/myself with basic auth and records the result (scenario 20)', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { displayName: 'Timesheet Bot' }));
    const r = (await call('POST', '/api/tests/source/jira', { source: jira, apiKey: 'tok' })).json();
    expect(r.ok).toBe(true);
    expect(r.message).toContain('Timesheet Bot');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://acme.atlassian.net/rest/api/3/myself');
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from('svc@acme.com:tok').toString('base64')}`);
    expect((await loadSettings()).tests['source.jira']?.ok).toBe(true);
  });

  it('Jira: a rejected token reports 401 (scenario 19)', async () => {
    fetchMock.mockResolvedValueOnce(json(401, {}));
    const r = (await call('POST', '/api/tests/source/jira', { source: jira, apiKey: 'bad' })).json();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/401/);
  });

  it('uses the stored secret when none is typed', async () => {
    await call('PUT', '/api/settings', { version: 0, settings: validSettings(), secrets: { 'source.jira.apiKey': 'stored-tok' } });
    fetchMock.mockResolvedValueOnce(json(200, { displayName: 'x' }));
    await call('POST', '/api/tests/source/jira', { source: jira });
    expect(fetchMock.mock.calls[0]![1].headers.Authorization).toBe(`Basic ${Buffer.from('svc@acme.com:stored-tok').toString('base64')}`);
  });

  it('refuses plain http and missing fields before sending credentials', async () => {
    let r = (await call('POST', '/api/tests/source/jira', { source: { ...jira, baseUrl: 'http://acme.atlassian.net' }, apiKey: 't' })).json();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/https/);
    r = (await call('POST', '/api/tests/source/redmine', { source: { ...defaultSettings().sources[1]!, baseUrl: 'https://rm.example.com' } })).json();
    expect(r.message).toBe('Enter the API key.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Redmine: uses X-Redmine-API-Key against /users/current.json', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { user: { login: 'svc' } }));
    const src = { ...defaultSettings().sources[1]!, baseUrl: 'https://rm.example.com/' };
    const r = (await call('POST', '/api/tests/source/redmine', { source: src, apiKey: 'k' })).json();
    expect(r.ok).toBe(true);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://rm.example.com/users/current.json');
    expect(fetchMock.mock.calls[0]![1].headers['X-Redmine-API-Key']).toBe('k');
  });

  it('Pulse API: requires an owner-confirmed test path, never guesses one', async () => {
    const src = { ...defaultSettings().sources[2]!, baseUrl: 'https://pulse.example.com' };
    let r = (await call('POST', '/api/tests/source/pulse', { source: src, apiKey: 'k' })).json();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/test path/);
    fetchMock.mockResolvedValueOnce(json(200, {}));
    r = (await call('POST', '/api/tests/source/pulse', { source: { ...src, testPath: '/api/me' }, apiKey: 'k' })).json();
    expect(r.ok).toBe(true);
    expect(fetchMock.mock.calls[0]![1].headers.Authorization).toBe('Bearer k');
  });

  it('a Cloudflare bot challenge is reported as such, not as a bad key', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('<!DOCTYPE html><html><head><title>Just a moment...</title></head></html>', {
        status: 403, headers: { 'Content-Type': 'text/html', server: 'cloudflare' },
      }),
    );
    const src = { ...defaultSettings().sources[2]!, baseUrl: 'https://pulse.example.com', testPath: '/timesheet' };
    const r = (await call('POST', '/api/tests/source/pulse', { source: src, apiKey: 'k' })).json();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Cloudflare/);
  });

  it('network failures become readable messages', async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }));
    const r = (await call('POST', '/api/tests/source/jira', { source: jira, apiKey: 't' })).json();
    expect(r.message).toMatch(/Could not find that server/);
  });

  it('SMTP: verifies with the typed password, maps auth failure', async () => {
    const ep = { ...defaultSettings().emailProvider, type: 'smtp' as const, smtp: { host: 'smtp.example.com', port: 587, security: 'starttls' as const, user: 'u@example.com' } };
    smtpVerify.mockResolvedValueOnce(undefined);
    let r = (await call('POST', '/api/tests/email', { emailProvider: ep, secrets: { smtpPassword: 'pw' } })).json();
    expect(r.ok).toBe(true);
    expect(smtpVerify.mock.calls[0]![0]).toMatchObject({ host: 'smtp.example.com', requireTLS: true, auth: { user: 'u@example.com', pass: 'pw' } });
    smtpVerify.mockRejectedValueOnce(Object.assign(new Error('Invalid login'), { code: 'EAUTH' }));
    r = (await call('POST', '/api/tests/email', { emailProvider: ep, secrets: { smtpPassword: 'pw' } })).json();
    expect(r.message).toMatch(/rejected the username or password/);
  });

  it('Gmail: refresh-token exchange must include gmail.send', async () => {
    const ep = { ...defaultSettings().emailProvider, gmail: { clientId: 'cid' } };
    fetchMock.mockResolvedValueOnce(json(200, { access_token: 'a', scope: 'https://www.googleapis.com/auth/gmail.readonly' }));
    let r = (await call('POST', '/api/tests/email', { emailProvider: ep, secrets: { gmailClientSecret: 's', gmailRefreshToken: 'r' } })).json();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/gmail.send/);
    fetchMock.mockResolvedValueOnce(json(200, { access_token: 'a', scope: 'https://www.googleapis.com/auth/gmail.send' }));
    r = (await call('POST', '/api/tests/email', { emailProvider: ep, secrets: { gmailClientSecret: 's', gmailRefreshToken: 'r' } })).json();
    expect(r.ok).toBe(true);
  });

  it('Groq: checks the key and that the model exists', async () => {
    let r = (await call('POST', '/api/tests/ai', { model: 'openai/gpt-oss-120b', apiKey: 'nope' })).json();
    expect(r.message).toMatch(/gsk_/);
    fetchMock.mockResolvedValueOnce(json(200, { data: [{ id: 'openai/gpt-oss-120b' }] }));
    r = (await call('POST', '/api/tests/ai', { model: 'openai/gpt-oss-120b', apiKey: 'gsk_abc' })).json();
    expect(r.ok).toBe(true);
  });
});

describe('AI assist', () => {
  async function enableAi() {
    const s = validSettings();
    s.ai.enabled = true;
    await call('PUT', '/api/settings', { version: 0, settings: s, secrets: { 'ai.groq.apiKey': 'gsk_abc' } });
  }
  const reply = (content: string) => json(200, { choices: [{ message: { content } }] });

  it('is refused while AI is off', async () => {
    expect((await call('POST', '/api/ai/assist', { kind: 'polish', text: 'Hi {employee_name}' })).statusCode).toBe(400);
  });
  it('returns the suggestion when placeholders are preserved, and sends only template text', async () => {
    await enableAi();
    fetchMock.mockResolvedValueOnce(reply('Hello {employee_name}.'));
    const r = await call('POST', '/api/ai/assist', { kind: 'polish', text: 'Hi {employee_name}' });
    expect(r.json().text).toBe('Hello {employee_name}.');
    const sent = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(JSON.stringify(sent.messages)).toContain('Hi {employee_name}');
  });
  it('discards a suggestion that changed placeholders (scenario 30-style safety)', async () => {
    await enableAi();
    fetchMock.mockResolvedValueOnce(reply('Hello there.'));
    const r = await call('POST', '/api/ai/assist', { kind: 'polish', text: 'Hi {employee_name}' });
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toMatch(/placeholders/);
  });
});

describe('employees', () => {
  it('imports CSV atomically and maps source accounts', async () => {
    const bad = 'employee_code,name,email\n1,Ann,ann@example.com\n2,Bob,not-an-email\n';
    expect((await call('POST', '/api/employees/import', { csv: bad })).statusCode).toBe(400);
    expect((await call('GET', '/api/employees')).json()).toHaveLength(0);

    const csv = 'employee_code,name,email,team,active,jira\n1,Ann,ann@example.com,QA,yes,acc-1\n2,"Rao, Bob",bob@example.com,QA,no,\n';
    expect((await call('POST', '/api/employees/import', { csv })).json()).toEqual({ created: 2, updated: 0 });
    const list = (await call('GET', '/api/employees')).json();
    expect(list.find((e: { name: string }) => e.name === 'Ann').accounts).toEqual({ jira: 'acc-1' });
    expect(list.find((e: { name: string }) => e.name === 'Rao, Bob').active).toBe(false);
  });
  it('refuses to map one source account to two people', async () => {
    await call('POST', '/api/employees', { employeeCode: '1', name: 'Ann', email: 'ann@example.com', accounts: { jira: 'x' } });
    const r = await call('POST', '/api/employees', { employeeCode: '2', name: 'Bob', email: 'bob@example.com', accounts: { jira: 'x' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/already mapped to Ann/);
  });
});
