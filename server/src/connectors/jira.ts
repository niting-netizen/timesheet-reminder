/**
 * Jira worklogs, attributed to the worklog AUTHOR (not the issue assignee).
 * 1. Find issues with worklogs in the range (JQL worklogDate, widened a day each side
 *    because Jira evaluates it in the API user's timezone).
 * 2. Read each issue's worklogs and keep those whose start falls in the range in the
 *    company timezone.
 */
import type { SourceConfig } from '../../../shared/settings';
import { addDaysIso, isoDate, localDateIn } from '../../../shared/calc';
import { checkBaseUrl, joinUrl, ProbeError } from '../testers/http';
import { getJson, mapLimit } from './http';
import { SourceUnavailable, type ConnectorContext, type FetchedWorklog, type FetchRange } from './types';

const MAX_PAGES = 500;

interface JiraWorklog {
  id: string;
  started: string;
  timeSpentSeconds: number;
  author?: { accountId?: string; name?: string; key?: string; displayName?: string };
}
interface WorklogPage { startAt: number; maxResults: number; total: number; worklogs: JiraWorklog[] }
interface Issue { key: string; fields?: { project?: { key?: string } } }

/** Jira sends "2026-11-10T09:00:00.000+0530"; add the colon so every runtime parses it. */
export function parseJiraTime(s: string): Date {
  return new Date(s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
}

export async function fetchJira(src: SourceConfig, secret: string | undefined, range: FetchRange, ctx: ConnectorContext): Promise<FetchedWorklog[]> {
  let base: URL;
  try {
    base = checkBaseUrl(src.baseUrl, ctx.allowInsecure);
  } catch (e) {
    throw new SourceUnavailable((e as ProbeError).message);
  }
  if (!secret) throw new SourceUnavailable('No API token is saved for Jira.');
  const cloud = src.authType === 'jira_cloud';
  const api = cloud ? '/rest/api/3' : '/rest/api/2';
  const headers = cloud
    ? { Authorization: `Basic ${Buffer.from(`${src.username}:${secret}`).toString('base64')}` }
    : { Authorization: `Bearer ${secret}` };
  const cred = cloud ? 'API token' : 'personal access token';

  const jql = `worklogDate >= "${addDaysIso(range.from, -1)}" AND worklogDate <= "${addDaysIso(range.to, 1)}" ORDER BY key`;
  const issues: Issue[] = [];
  if (cloud) {
    let token: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const q = new URLSearchParams({ jql, fields: 'project', maxResults: '100' });
      if (token) q.set('nextPageToken', token);
      const r = await getJson<{ issues?: Issue[]; nextPageToken?: string; isLast?: boolean }>(ctx, joinUrl(base, `${api}/search/jql?${q}`), headers, cred);
      issues.push(...(r.issues ?? []));
      token = r.nextPageToken;
      if (r.isLast || !token) break;
    }
  } else {
    for (let startAt = 0, page = 0; page < MAX_PAGES; page++) {
      const q = new URLSearchParams({ jql, fields: 'project', maxResults: '100', startAt: String(startAt) });
      const r = await getJson<{ issues?: Issue[]; total?: number }>(ctx, joinUrl(base, `${api}/search?${q}`), headers, cred);
      const got = r.issues ?? [];
      issues.push(...got);
      startAt += got.length;
      if (!got.length || startAt >= (r.total ?? 0)) break;
    }
  }

  const after = Date.parse(`${addDaysIso(range.from, -1)}T00:00:00Z`);
  const before = Date.parse(`${addDaysIso(range.to, 2)}T00:00:00Z`);
  const perIssue = await mapLimit(issues, 4, async (issue) => {
    const out: FetchedWorklog[] = [];
    for (let startAt = 0, page = 0; page < MAX_PAGES; page++) {
      const q = new URLSearchParams({ startAt: String(startAt), maxResults: '1000', startedAfter: String(after), startedBefore: String(before) });
      const r = await getJson<WorklogPage>(ctx, joinUrl(base, `${api}/issue/${encodeURIComponent(issue.key)}/worklog?${q}`), headers, cred);
      for (const w of r.worklogs ?? []) {
        const user = cloud ? w.author?.accountId : (w.author?.name ?? w.author?.key);
        const started = parseJiraTime(w.started);
        if (!user || Number.isNaN(started.getTime()) || !(w.timeSpentSeconds > 0)) continue;
        const workDate = isoDate(localDateIn(started, range.timezone));
        if (workDate < range.from || workDate > range.to) continue;
        out.push({
          externalId: w.id,
          externalUserId: user,
          authorName: w.author?.displayName ?? '',
          issueKey: issue.key,
          project: issue.fields?.project?.key ?? issue.key.split('-')[0] ?? '',
          workDate,
          seconds: Math.round(w.timeSpentSeconds),
        });
      }
      const n = r.worklogs?.length ?? 0;
      startAt += n;
      if (!n || startAt >= (r.total ?? 0)) break;
    }
    return out;
  });
  return perIssue.flat();
}
