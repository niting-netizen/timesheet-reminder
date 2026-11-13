import { Fragment, useCallback, useEffect, useState } from 'react';
import { SOURCE_NAME, type CheckRun, type EmployeeStatus, type SourceType, type WeekTimesheets } from '../../../shared/settings';
import { formatDate, formatHours, parseIsoDate } from '../../../shared/calc';
import { api, getToken } from '../lib/api';
import { Notice, PageHead, fmtWhen } from '../components/ui';

const STATUS: Record<EmployeeStatus, [string, string]> = {
  complete: ['ok', 'Complete'],
  pending: ['bad', 'Pending'],
  source_missing: ['warn', 'Source data missing'],
  unmapped: ['warn', 'No source account'],
  not_checked: ['idle', 'Not checked'],
};
const RUN_STATUS: Record<CheckRun['status'], [string, string]> = {
  success: ['ok', 'All sources received'], partial: ['warn', 'Some sources missing'], failed: ['bad', 'Check failed'], running: ['info', 'Running'],
};

interface Log { source: SourceType; issueKey: string; project: string; workDate: string; seconds: number; origin: string }

export function Dashboard() {
  const [weekOf, setWeekOf] = useState('');
  const [data, setData] = useState<WeekTimesheets | null>(null);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const [q, setQ] = useState('');
  const [fStatus, setFStatus] = useState('');
  const [fSource, setFSource] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const [logs, setLogs] = useState<Log[] | null>(null);

  const load = useCallback(() => {
    api<WeekTimesheets>('GET', `/api/timesheets${weekOf ? `?week=${weekOf}` : ''}`).then(
      (r) => { setData(r); setError(''); },
      (e: Error) => setError(e.message),
    );
  }, [weekOf]);
  useEffect(load, [load]);

  const runCheck = async () => {
    setRunning(true);
    setError('');
    try {
      await api('POST', '/api/runs', weekOf ? { weekOf } : {});
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };
  const exportCsv = async () => {
    setError('');
    const res = await fetch(`/api/timesheets/export.csv${weekOf ? `?week=${weekOf}` : ''}`, { headers: { Authorization: `Bearer ${getToken()}` } }).catch(() => null);
    if (!res?.ok) return setError('Could not export the report. Check that the server is running and try again.');
    const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'timesheet.csv';
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const toggle = async (id: number) => {
    if (open === id) return setOpen(null);
    setOpen(id);
    setLogs(null);
    setLogs(await api<Log[]>('GET', `/api/timesheets/${id}/worklogs${weekOf ? `?week=${weekOf}` : ''}`).catch(() => []));
  };

  if (!data) return error ? <Notice kind="bad">{error}</Notice> : <p className="hint">Loading…</p>;
  const run = data.run;
  const rows = data.rows.filter(
    (r) => (!q || `${r.name} ${r.employeeCode} ${r.team}`.toLowerCase().includes(q.toLowerCase())) && (!fStatus || r.status === fStatus) && (!fSource || r.sources.includes(fSource as SourceType)),
  );
  const count = (s: EmployeeStatus) => data.rows.filter((r) => r.status === s).length;

  return (
    <>
      <PageHead title={`Week ${data.isoWeek} · ${formatDate(parseIsoDate(data.weekStart))} to ${formatDate(parseIsoDate(data.weekEnd))}`}
        sub={run ? `Last checked ${fmtWhen(run.completedAt ?? run.startedAt)} by ${run.actor} (${run.trigger})` : 'Not checked yet this week'}>
        <div className="inline">
          <div className="field">
            <label htmlFor="week-of">Week of</label>
            <input id="week-of" type="date" value={weekOf} onChange={(e) => setWeekOf(e.target.value)} />
          </div>
          <button className="btn primary" onClick={runCheck} disabled={running} aria-busy={running} style={{ alignSelf: 'flex-end' }}>
            {running ? 'Checking all sources…' : 'Run timesheet check'}
          </button>
          <button className="btn" onClick={exportCsv} disabled={!run} style={{ alignSelf: 'flex-end' }}
            title={run ? 'EMP ID, EMP Name, Filled Hours, Need to fill hours, Pending hours' : 'Run a check first'}>
            Export CSV
          </button>
        </div>
      </PageHead>
      {error && <Notice kind="bad">{error}</Notice>}

      {run && (
        <section className="card">
          <div className="card-head">
            <h2>Sources this check</h2>
            <span className={`chip ${RUN_STATUS[run.status][0]}`}>{RUN_STATUS[run.status][1]}</span>
          </div>
          {run.error && <Notice kind="bad">{run.error}</Notice>}
          <div className="check-list">
            {run.sources.map((s) => (
              <div className="check-row" key={s.source}>
                <div><b>{SOURCE_NAME[s.source]}</b> <span className="hint">· {s.origin === 'import' ? 'file import' : 'API'}</span><br /><span className="hint">{s.message}</span></div>
                <span className={`chip ${s.status === 'ok' ? 'ok' : 'bad'}`}>{s.status === 'ok' ? `${s.worklogs} worklogs` : s.status === 'failed' ? 'Failed' : 'Not received'}</span>
              </div>
            ))}
          </div>
          {run.sources.some((s) => s.status !== 'ok') && (
            <p className="help">Employees who use a missing source show "Source data missing" and are left out of reports until the data arrives.</p>
          )}
        </section>
      )}

      <div className="stats">
        <div className="stat"><div className="k">Active employees</div><div className="v">{data.rows.length}</div></div>
        <div className="stat ok"><div className="k">Complete</div><div className="v">{count('complete')}</div></div>
        <div className="stat bad"><div className="k">Pending</div><div className="v">{count('pending')}</div></div>
        <div className="stat warn"><div className="k">Source data missing</div><div className="v">{count('source_missing')}</div></div>
        <div className="stat warn"><div className="k">No source account</div><div className="v">{count('unmapped')}</div></div>
      </div>

      {run && run.unmapped.length > 0 && (
        <section className="card">
          <h2>Worklogs from people not in the employee master</h2>
          <p className="hint">These accounts logged time but are not mapped to any employee, so their hours are not counted. Add the account ID on the <a href="#employees">Employees</a> page.</p>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Source</th><th>Account ID</th><th>Name in source</th><th className="num">Hours</th></tr></thead>
              <tbody>
                {run.unmapped.map((u) => (
                  <tr key={`${u.source}${u.externalUserId}`}>
                    <td>{SOURCE_NAME[u.source]}</td><td><code>{u.externalUserId}</code></td><td>{u.authorName || '–'}</td><td className="num">{formatHours(u.seconds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="card">
        <h2>Employees</h2>
        {data.rows.length === 0 ? (
          <p className="empty">No active employees. Add them on the <a href="#employees">Employees</a> page.</p>
        ) : (
          <>
            <div className="filters">
              <input type="search" placeholder="Search name, ID or team" aria-label="Search employees" value={q} onChange={(e) => setQ(e.target.value)} />
              <select aria-label="Filter by source" value={fSource} onChange={(e) => setFSource(e.target.value)}>
                <option value="">All sources</option>
                {(Object.keys(SOURCE_NAME) as SourceType[]).map((s) => <option key={s} value={s}>{SOURCE_NAME[s]}</option>)}
              </select>
              <select aria-label="Filter by status" value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
                <option value="">All statuses</option>
                {(Object.keys(STATUS) as EmployeeStatus[]).map((s) => <option key={s} value={s}>{STATUS[s][1]}</option>)}
              </select>
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>EMP ID</th><th>Employee</th><th>Sources</th><th className="num">Logged</th><th className="num">Required</th><th className="num">Pending</th><th>Completion</th><th>Status</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <Fragment key={r.employeeId}>
                      <tr onClick={() => toggle(r.employeeId)} style={{ cursor: 'pointer' }} aria-expanded={open === r.employeeId}>
                        <td className="num" style={{ textAlign: 'left' }}>{r.employeeCode}</td>
                        <td><div className="who">{r.name}<small>{r.team}</small></div></td>
                        <td>{r.sources.map((s) => SOURCE_NAME[s]).join(' + ') || '–'}</td>
                        <td className="num">{r.status === 'not_checked' ? '–' : formatHours(r.loggedSeconds)}</td>
                        <td className="num">{formatHours(r.targetSeconds)}{r.daysOff > 0 && <><br /><small className="hint">{r.daysOff} day{r.daysOff === 1 ? '' : 's'} off</small></>}</td>
                        <td className={`num${r.status === 'pending' ? ' red' : ''}`}>{r.status === 'pending' || r.status === 'complete' ? formatHours(r.pendingSeconds) : '–'}</td>
                        <td className="num" style={{ textAlign: 'left' }}>
                          {r.status === 'not_checked' ? '–' : <><span className={`bar${r.completionPct >= 100 ? ' full' : ''}`}><i style={{ width: `${r.completionPct}%` }} /></span>{Math.round(r.completionPct)}%</>}
                        </td>
                        <td><span className={`chip ${STATUS[r.status][0]}`}>{STATUS[r.status][1]}</span></td>
                      </tr>
                      {open === r.employeeId && (
                        <tr>
                          <td colSpan={8} style={{ background: 'var(--sunken)' }}>
                            {!logs ? <span className="hint">Loading worklogs…</span> : logs.length === 0 ? <span className="hint">No worklogs this week.</span> : (
                              <table>
                                <thead><tr><th>Date</th><th>Source</th><th>Issue</th><th>Project</th><th className="num">Hours</th></tr></thead>
                                <tbody>
                                  {logs.map((l, i) => (
                                    <tr key={i}><td>{l.workDate}</td><td>{SOURCE_NAME[l.source]}{l.origin === 'import' ? ' (file)' : ''}</td><td>{l.issueKey || '–'}</td><td>{l.project || '–'}</td><td className="num">{formatHours(l.seconds)}</td></tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="help">Click an employee to see their worklogs. Nothing is emailed yet; sending arrives in a later phase.</p>
          </>
        )}
      </section>
    </>
  );
}
