/**
 * A timesheet check: fetch every enabled source for one week, store normalised worklogs,
 * map them to employees, and compute each active employee's status.
 *
 * Rules (spec §8): attribute by worklog author; include active employees with zero hours;
 * never call someone complete or pending when a source they use did not return data.
 */
import {
  DAYS, SOURCE_NAME, sourceSecretRef,
  type CheckRun, type EmployeeStatus, type Settings, type SourceRunResult, type SourceType,
  type TimesheetRow, type UnmappedAccount, type WeekTimesheets,
} from '../../../shared/settings';
import {
  evaluate, isoDate, targetSeconds, weekWindowFor, weekdayIndex, parseIsoDate, localDateIn, workingDays,
} from '../../../shared/calc';
import { nowIso, tx, type Db } from '../db';
import { AppError } from '../errors';
import type { SettingsService } from '../settings/service';
import type { SecretStore } from '../settings/secrets';
import type { AdjustmentService } from './adjustments';
import { EMP_PREFIX, type ImportService } from './imports';
import { fetchJira } from '../connectors/jira';
import { fetchRedmine } from '../connectors/redmine';
import { SourceUnavailable, type ConnectorContext, type FetchedWorklog } from '../connectors/types';

export interface RunDeps {
  db: Db;
  settings: SettingsService;
  secrets: SecretStore;
  imports: ImportService;
  adjustments: AdjustmentService;
  connector: ConnectorContext;
  now?: () => Date;
}

interface RunRow { id: number; week_start: string; week_end: string; trigger: string; status: string; started_at: string; completed_at: string | null; actor: string; summary: string }

export class RunService {
  private running = false;

  constructor(private d: RunDeps) {}

  /** The configured week containing `weekOf` (default: today in the company timezone). */
  window(settings: Settings, weekOf?: string) {
    const ref = weekOf ?? isoDate(localDateIn((this.d.now ?? (() => new Date()))(), settings.week.timezone));
    const w = weekWindowFor(settings.week, ref);
    return { ...w, from: isoDate(w.start), to: isoDate(w.end) };
  }

  async run(opts: { weekOf?: string; trigger: CheckRun['trigger']; actor: string }): Promise<CheckRun> {
    if (this.running) throw new AppError(409, 'A check is already running. Wait for it to finish.');
    this.running = true;
    const { settings } = this.d.settings.current();
    const w = this.window(settings, opts.weekOf);
    const runId = Number(
      this.d.db
        .prepare("INSERT INTO check_runs (week_start, week_end, trigger, status, started_at, actor) VALUES (?, ?, ?, 'running', ?, ?)")
        .run(w.from, w.to, opts.trigger, nowIso(), opts.actor).lastInsertRowid,
    );
    try {
      const results = await this.fetchAll(settings, w.from, w.to);
      const summary = tx(this.d.db, () => this.storeAndEvaluate(settings, w, runId, results));
      const failed = summary.sources.filter((s) => s.status !== 'ok').length;
      const status: CheckRun['status'] = failed === 0 ? 'success' : failed === summary.sources.length && summary.sources.length > 0 ? 'failed' : 'partial';
      this.d.db
        .prepare('UPDATE check_runs SET status = ?, completed_at = ?, summary = ? WHERE id = ?')
        .run(status, nowIso(), JSON.stringify(summary), runId);
      this.d.settings.audit(opts.actor, 'check.run', `run ${runId} week ${w.from}: ${status}`);
      return this.getRun(runId)!;
    } catch (e) {
      this.d.db
        .prepare("UPDATE check_runs SET status = 'failed', completed_at = ?, summary = ? WHERE id = ?")
        .run(nowIso(), JSON.stringify({ error: (e as Error).message }), runId);
      throw e;
    } finally {
      this.running = false;
    }
  }

  private async fetchAll(settings: Settings, from: string, to: string) {
    const out: { result: SourceRunResult; worklogs: FetchedWorklog[] | null }[] = [];
    for (const src of settings.sources.filter((s) => s.enabled)) {
      const name = SOURCE_NAME[src.type];
      if (src.authType === 'csv_import') {
        const imp = this.d.imports.coveringImport(src.type, from, to);
        out.push({
          worklogs: null,
          result: imp
            ? { source: src.type, status: 'ok', origin: 'import', worklogs: imp.rows, message: `Using the file imported ${imp.imported_at.slice(0, 16).replace('T', ' ')} UTC.` }
            : { source: src.type, status: 'not_received', origin: 'import', worklogs: 0, message: `${name} data not received: no imported file covers ${from} to ${to}.` },
        });
        continue;
      }
      try {
        const secret = this.d.secrets.get(sourceSecretRef(src.type));
        const range = { from, to, timezone: settings.week.timezone };
        let worklogs: FetchedWorklog[];
        if (src.type === 'jira') worklogs = await fetchJira(src, secret, range, this.d.connector);
        else if (src.type === 'redmine') worklogs = await fetchRedmine(src, secret, range, this.d.connector);
        else throw new SourceUnavailable(`${name} API endpoints are not confirmed yet. Switch ${name} to CSV / Excel import until they are.`);
        out.push({ worklogs, result: { source: src.type, status: 'ok', origin: 'api', worklogs: worklogs.length, message: `${worklogs.length} worklogs fetched.` } });
      } catch (e) {
        if (!(e instanceof SourceUnavailable)) throw e;
        out.push({ worklogs: null, result: { source: src.type, status: 'failed', origin: 'api', worklogs: 0, message: `${name}: ${e.message}` } });
      }
    }
    return out;
  }

  private storeAndEvaluate(
    settings: Settings,
    w: ReturnType<RunService['window']>,
    runId: number,
    results: { result: SourceRunResult; worklogs: FetchedWorklog[] | null }[],
  ): Omit<CheckRun, 'id' | 'weekStart' | 'weekEnd' | 'trigger' | 'status' | 'startedAt' | 'completedAt' | 'actor'> {
    const db = this.d.db;
    const now = nowIso();

    // Replace API worklogs for sources fetched successfully, so edits and deletions in the
    // source are reflected (scenario 8). Failed sources keep their old rows but are flagged.
    const ins = db.prepare(
      `INSERT OR REPLACE INTO worklogs (source, external_id, external_user_id, author_name, issue_key, project, work_date, seconds, origin, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'api', ?)`,
    );
    for (const { result, worklogs } of results) {
      if (!worklogs) continue;
      db.prepare("DELETE FROM worklogs WHERE source = ? AND origin = 'api' AND work_date BETWEEN ? AND ?").run(result.source, w.from, w.to);
      for (const l of worklogs) ins.run(result.source, l.externalId, l.externalUserId, l.authorName, l.issueKey, l.project, l.workDate, l.seconds, now);
    }

    const okSources = new Set(results.filter((r) => r.result.status === 'ok').map((r) => r.result.source));
    const enabled = new Set(settings.sources.filter((s) => s.enabled).map((s) => s.type));

    const accounts = db.prepare('SELECT employee_id, source, external_user_id FROM source_accounts').all() as {
      employee_id: number; source: SourceType; external_user_id: string;
    }[];
    const owner = new Map(accounts.map((a) => [`${a.source}|${a.external_user_id}`, a.employee_id]));
    // Weekly-total imports identify people by company employee ID ("emp:<id>") in any source.
    const byCode = new Map(
      (db.prepare('SELECT id, employee_code FROM employees').all() as { id: number; employee_code: string }[]).map((e) => [e.employee_code, e.id]),
    );
    const employeeSources = new Map<number, SourceType[]>();
    for (const a of accounts) if (enabled.has(a.source)) employeeSources.set(a.employee_id, [...(employeeSources.get(a.employee_id) ?? []), a.source]);

    // Sum worklogs in the week per employee and source; collect unknown authors.
    // Count only rows from each source's current method, so switching Pulse from file import
    // to API (or back) never double-counts.
    const origin = new Map(settings.sources.map((s) => [s.type, s.authType === 'csv_import' ? 'import' : 'api']));
    const sums = db
      .prepare(
        `SELECT source, origin, external_user_id, MAX(author_name) AS author_name, SUM(seconds) AS seconds
         FROM worklogs WHERE work_date BETWEEN ? AND ? GROUP BY source, origin, external_user_id`,
      )
      .all(w.from, w.to) as { source: SourceType; origin: string; external_user_id: string; author_name: string; seconds: number }[];
    const bySource = new Map<number, Partial<Record<SourceType, number>>>();
    const unmapped: UnmappedAccount[] = [];
    for (const s of sums) {
      if (!enabled.has(s.source) || origin.get(s.source) !== s.origin) continue;
      const emp = s.external_user_id.startsWith(EMP_PREFIX)
        ? byCode.get(s.external_user_id.slice(EMP_PREFIX.length))
        : owner.get(`${s.source}|${s.external_user_id}`);
      if (emp === undefined) {
        unmapped.push({ source: s.source, externalUserId: s.external_user_id, authorName: s.author_name, seconds: s.seconds });
        continue;
      }
      // Listed by EMP ID in a weekly file: that source now counts as one of theirs.
      const theirs = employeeSources.get(emp) ?? [];
      if (!theirs.includes(s.source)) employeeSources.set(emp, [...theirs, s.source]);
      const m = bySource.get(emp) ?? {};
      m[s.source] = (m[s.source] ?? 0) + s.seconds;
      bySource.set(emp, m);
    }

    const working = new Set(workingDays(settings.week));
    const isWorkingDay = (iso: string) => working.has(DAYS[weekdayIndex(parseIsoDate(iso))]!);
    const employees = db.prepare('SELECT id FROM employees WHERE active = 1').all() as { id: number }[];
    const counts = { employees: employees.length, complete: 0, pending: 0, sourceMissing: 0, unmapped: 0 };
    const upsert = db.prepare(
      `INSERT OR REPLACE INTO weekly_timesheets
       (employee_id, week_start, week_end, logged_seconds, target_seconds, pending_seconds, completion_pct, status, by_source, days_off, run_id, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    db.prepare('DELETE FROM weekly_timesheets WHERE week_start = ? AND employee_id NOT IN (SELECT id FROM employees WHERE active = 1)').run(w.from);

    for (const { id } of employees) {
      const sources = employeeSources.get(id) ?? [];
      const split = bySource.get(id) ?? {};
      const logged = Object.values(split).reduce((a, b) => a + (b ?? 0), 0);
      const off = this.d.adjustments.daysOff(id, w.from, w.to, isWorkingDay);
      const target = targetSeconds(settings.week, { approvedDaysOff: off.fullDays, otherSeconds: off.partialSeconds });
      const ev = evaluate({ loggedSeconds: logged, targetSeconds: target, sourcesComplete: sources.every((s) => okSources.has(s)) });
      const status: EmployeeStatus = sources.length === 0 ? 'unmapped' : ev.status;
      counts[status === 'source_missing' ? 'sourceMissing' : (status as 'complete' | 'pending' | 'unmapped')]++;
      upsert.run(id, w.from, w.to, logged, target, ev.pendingSeconds, ev.completionPct, status, JSON.stringify(split), off.fullDays, runId, now);
    }

    unmapped.sort((a, b) => b.seconds - a.seconds);
    return { sources: results.map((r) => r.result), unmapped, counts };
  }

  getRun(id: number): CheckRun | null {
    const r = this.d.db.prepare('SELECT * FROM check_runs WHERE id = ?').get(id) as RunRow | undefined;
    return r ? toRun(r) : null;
  }

  listRuns(limit = 20): CheckRun[] {
    return (this.d.db.prepare('SELECT * FROM check_runs ORDER BY id DESC LIMIT ?').all(limit) as unknown as RunRow[]).map(toRun);
  }

  week(weekOf?: string): WeekTimesheets {
    const { settings } = this.d.settings.current();
    const w = this.window(settings, weekOf);
    const run = this.d.db.prepare("SELECT * FROM check_runs WHERE week_start = ? AND status <> 'running' ORDER BY id DESC LIMIT 1").get(w.from) as RunRow | undefined;
    const enabled = new Set(settings.sources.filter((s) => s.enabled).map((s) => s.type));
    const rows = this.d.db
      .prepare(
        `SELECT e.id, e.employee_code, e.name, e.email, e.team,
                (SELECT GROUP_CONCAT(source) FROM source_accounts a WHERE a.employee_id = e.id) AS sources,
                t.logged_seconds, t.target_seconds, t.pending_seconds, t.completion_pct, t.status, t.by_source, t.days_off, t.checked_at
         FROM employees e LEFT JOIN weekly_timesheets t ON t.employee_id = e.id AND t.week_start = ?
         WHERE e.active = 1 ORDER BY e.name`,
      )
      .all(w.from) as {
        id: number; employee_code: string; name: string; email: string; team: string; sources: string | null;
        logged_seconds: number | null; target_seconds: number | null; pending_seconds: number | null; completion_pct: number | null;
        status: EmployeeStatus | null; by_source: string | null; days_off: number | null; checked_at: string | null;
      }[];
    const fallbackTarget = targetSeconds(settings.week);
    const out: TimesheetRow[] = rows.map((r) => ({
      employeeId: r.id, employeeCode: r.employee_code, name: r.name, email: r.email, team: r.team,
      // Account-mapped sources plus any source that listed them by EMP ID this week.
      sources: [...new Set([...(r.sources ?? '').split(','), ...Object.keys(r.by_source ? JSON.parse(r.by_source) : {})])]
        .filter((s): s is SourceType => enabled.has(s as SourceType)),
      loggedSeconds: r.logged_seconds ?? 0,
      targetSeconds: r.target_seconds ?? fallbackTarget,
      pendingSeconds: r.pending_seconds ?? fallbackTarget,
      completionPct: r.completion_pct ?? 0,
      status: r.status ?? 'not_checked',
      bySource: r.by_source ? JSON.parse(r.by_source) : {},
      daysOff: r.days_off ?? 0,
      checkedAt: r.checked_at,
    }));
    return { weekStart: w.from, weekEnd: w.to, isoWeek: w.isoWeek, run: run ? toRun(run) : null, rows: out };
  }
}

function toRun(r: RunRow): CheckRun {
  const s = JSON.parse(r.summary || '{}');
  return {
    id: r.id, weekStart: r.week_start, weekEnd: r.week_end, trigger: r.trigger as CheckRun['trigger'], status: r.status as CheckRun['status'],
    startedAt: r.started_at, completedAt: r.completed_at, actor: r.actor,
    sources: s.sources ?? [], unmapped: s.unmapped ?? [],
    counts: s.counts ?? { employees: 0, complete: 0, pending: 0, sourceMissing: 0, unmapped: 0 },
    error: s.error,
  };
}
