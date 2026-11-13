/**
 * Redmine time entries. The service user needs the "View spent time" permission on every
 * project in scope, otherwise entries are silently missing: confirm with the Redmine admin.
 */
import type { SourceConfig } from '../../../shared/settings';
import { checkBaseUrl, joinUrl, ProbeError } from '../testers/http';
import { getJson } from './http';
import { SourceUnavailable, type ConnectorContext, type FetchedWorklog, type FetchRange } from './types';

interface Entry {
  id: number;
  project?: { id: number; name?: string };
  issue?: { id: number };
  user?: { id: number; name?: string };
  hours: number;
  spent_on: string;
}

export async function fetchRedmine(src: SourceConfig, secret: string | undefined, range: FetchRange, ctx: ConnectorContext): Promise<FetchedWorklog[]> {
  let base: URL;
  try {
    base = checkBaseUrl(src.baseUrl, ctx.allowInsecure);
  } catch (e) {
    throw new SourceUnavailable((e as ProbeError).message);
  }
  if (!secret) throw new SourceUnavailable('No API key is saved for Redmine.');
  const out: FetchedWorklog[] = [];
  for (let offset = 0, page = 0; page < 1000; page++) {
    const q = new URLSearchParams({ from: range.from, to: range.to, limit: '100', offset: String(offset) });
    const r = await getJson<{ time_entries?: Entry[]; total_count?: number }>(
      ctx, joinUrl(base, `/time_entries.json?${q}`), { 'X-Redmine-API-Key': secret }, 'API key',
    );
    const entries = r.time_entries ?? [];
    for (const e of entries) {
      if (!e.user || !(e.hours > 0) || e.spent_on < range.from || e.spent_on > range.to) continue;
      out.push({
        externalId: String(e.id),
        externalUserId: String(e.user.id),
        authorName: e.user.name ?? '',
        issueKey: e.issue ? `#${e.issue.id}` : '',
        project: e.project?.name ?? '',
        workDate: e.spent_on,
        seconds: Math.round(e.hours * 3600),
      });
    }
    offset += entries.length;
    if (!entries.length || offset >= (r.total_count ?? 0)) break;
  }
  return out;
}
