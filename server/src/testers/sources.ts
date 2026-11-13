import { SOURCE_NAME, type SourceConfig } from '../../../shared/settings';
import { checkBaseUrl, describeStatus, joinUrl, ProbeError, request, type FetchFn, type ProbeResult } from './http';

export interface SourceTestContext {
  fetch: FetchFn;
  allowInsecure: boolean;
}

/** Minimal read-only call that proves the URL and credentials work. */
export async function testSource(src: SourceConfig, secret: string | undefined, ctx: SourceTestContext): Promise<ProbeResult> {
  const name = SOURCE_NAME[src.type];
  if (!src.enabled) return { ok: false, message: `${name} is turned off. Turn it on to test.` };

  if (src.authType === 'csv_import') {
    return { ok: true, message: 'File import selected. There is no server to connect to; columns are checked when a file is imported.' };
  }
  if (src.authType === 'db_view') {
    return { ok: false, message: 'Database view access is not built yet. Confirm this method with the source owner first.' };
  }

  const base = checkBaseUrl(src.baseUrl, ctx.allowInsecure);
  const key = secret?.trim();

  switch (src.authType) {
    case 'jira_cloud': {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(src.username)) throw new ProbeError('Jira Cloud needs the service account email as the user.');
      if (!key) throw new ProbeError('Enter the API token.');
      const auth = Buffer.from(`${src.username}:${key}`).toString('base64');
      const r = await request(ctx.fetch, joinUrl(base, '/rest/api/3/myself'), {
        headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
      });
      if (r.status !== 200) return { ok: false, message: describeStatus(r.status, 'API token') };
      const b = r.body as { displayName?: string; emailAddress?: string } | null;
      return { ok: true, message: `Connected to Jira Cloud as ${b?.displayName ?? src.username}.` };
    }
    case 'jira_dc': {
      if (!key) throw new ProbeError('Enter the personal access token.');
      const r = await request(ctx.fetch, joinUrl(base, '/rest/api/2/myself'), {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      });
      if (r.status !== 200) return { ok: false, message: describeStatus(r.status, 'personal access token') };
      const b = r.body as { displayName?: string; name?: string } | null;
      return { ok: true, message: `Connected to Jira Data Center as ${b?.displayName ?? b?.name ?? 'the service account'}.` };
    }
    case 'api_key': {
      if (!key) throw new ProbeError('Enter the API key.');
      const r = await request(ctx.fetch, joinUrl(base, '/users/current.json'), {
        headers: { 'X-Redmine-API-Key': key, Accept: 'application/json' },
      });
      if (r.status !== 200) return { ok: false, message: describeStatus(r.status, 'API key') };
      const b = r.body as { user?: { login?: string } } | null;
      if (!b?.user) return { ok: false, message: 'The server answered, but not like Redmine. Check the base URL.' };
      return { ok: true, message: `Connected to Redmine as ${b.user.login ?? 'the service user'}.` };
    }
    case 'api': {
      // Pulse/Texpert: endpoints are not documented yet, so the admin supplies the
      // read-only path the source owner confirms. We do not guess endpoints.
      if (!src.testPath) throw new ProbeError(`Enter the test path the ${name} owner gave you (a read-only endpoint, for example /api/me).`);
      if (!key) throw new ProbeError('Enter the API key or token.');
      const header = src.authHeader || 'Authorization';
      const value = header.toLowerCase() === 'authorization' ? `Bearer ${key}` : key;
      const r = await request(ctx.fetch, joinUrl(base, src.testPath), { headers: { [header]: value, Accept: 'application/json' } });
      if (r.status < 200 || r.status >= 300) return { ok: false, message: describeStatus(r.status, 'key') };
      return { ok: true, message: `Connected to ${name}. ${src.testPath} answered ${r.status}.` };
    }
    default:
      return { ok: false, message: `${src.authType} is not a valid access method for ${name}.` };
  }
}
