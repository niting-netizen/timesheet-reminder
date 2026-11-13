import { useEffect, useState } from 'react';
import { SOURCE_NAME, SOURCE_TYPES, type FieldError, type SourceType, type WeekTimesheets } from '../../../shared/settings';
import { formatHours } from '../../../shared/calc';
import { api, ApiError } from '../lib/api';
import { useSettings } from '../lib/settings-context';
import { Notice, PageHead, fmtWhen } from '../components/ui';

interface ImportRow { id: number; source: SourceType; from: string; to: string; rows: number; importedAt: string; importedBy: string }
const SAMPLE = 'EMP ID,EMP Name,Filled Hours,Need to fill hours,Pending hours\n103298,Employee Name,27.8,40.0,-12.2\n';

export function Imports() {
  const { data: settingsData } = useSettings();
  const fileSources = settingsData.settings.sources.filter((s) => s.enabled && s.authType === 'csv_import').map((s) => s.type);
  const [source, setSource] = useState<SourceType>(fileSources[0] ?? 'pulse');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'bad'; text: string; rows?: FieldError[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<ImportRow[]>([]);

  const loadHistory = () => api<ImportRow[]>('GET', '/api/imports').then(setHistory, () => {});
  useEffect(() => {
    loadHistory();
    api<WeekTimesheets>('GET', '/api/timesheets').then((w) => { setFrom(w.weekStart); setTo(w.weekEnd); }, () => {});
  }, []);

  const onFile = (f: File | undefined) => {
    if (!f) return;
    if (/\.xlsx?$/i.test(f.name)) {
      setMsg({ kind: 'bad', text: 'Excel files need to be saved as CSV first (File → Save As → CSV UTF-8).' });
      return;
    }
    setFileName(f.name);
    const reader = new FileReader();
    reader.onload = () => setCsv(String(reader.result ?? ''));
    reader.readAsText(f);
  };
  const submit = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ rows: number; seconds: number }>('POST', '/api/imports/worklogs', { source, from, to, csv });
      setMsg({ kind: 'ok', text: `Imported ${r.rows} worklogs (${formatHours(r.seconds)} h) for ${SOURCE_NAME[source]}, ${from} to ${to}. Run a timesheet check on the Dashboard to use them.` });
      setCsv('');
      setFileName('');
      loadHistory();
    } catch (e) {
      const err = e as ApiError;
      setMsg({ kind: 'bad', text: err.message, rows: err.fieldErrors });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHead title="Worklog import" sub="Load worklogs from a file for sources without a working API, such as Pulse while its API access is being arranged." />
      {fileSources.length === 0 && (
        <Notice kind="warn">No source is set to file import. On <a href="#sources">Sources &amp; API keys</a>, set Pulse’s access method to "CSV / Excel export" so checks use imported files.</Notice>
      )}
      <section className="card">
        <h2>Import a file</h2>
        <div className="fields cols">
          <div className="field">
            <label htmlFor="imp-src">Source</label>
            <select id="imp-src" value={source} onChange={(e) => setSource(e.target.value as SourceType)}>
              {SOURCE_TYPES.map((s) => <option key={s} value={s}>{SOURCE_NAME[s]}{fileSources.includes(s) ? '' : ' (not set to file import)'}</option>)}
            </select>
          </div>
          <div className="field"><label htmlFor="imp-from">Period from</label><input id="imp-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div className="field"><label htmlFor="imp-to">Period to</label><input id="imp-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        </div>
        <div className="help" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <p>The file must cover the whole period. Importing again for the same period replaces the earlier file. Two layouts are accepted:</p>
          <p>
            <b>Weekly report</b> (one row per employee): <code>EMP ID, EMP Name, Filled Hours, Need to fill hours, Pending hours</code>.
            EMP ID must match the Employee ID on the Employees page. Only Filled Hours is read; Need to fill and Pending are
            recalculated from the weekly target, leave and holidays. The Dashboard’s Export CSV produces this layout.
          </p>
          <p>
            <b>Daily worklogs</b>: <code>user_id</code> (account ID in that source), <code>date</code> (YYYY-MM-DD or DD/MM/YYYY),
            <code> hours</code>, and optionally <code>issue_key</code>, <code>project</code>, <code>author_name</code>.
          </p>
        </div>
        <div className="field">
          <label htmlFor="imp-file">CSV file</label>
          <input id="imp-file" type="file" accept=".csv,text/csv,.xlsx,.xls" onChange={(e) => onFile(e.target.files?.[0])} />
        </div>
        <div className="field">
          <label htmlFor="imp-csv">Or paste CSV{fileName && ` (loaded from ${fileName})`}</label>
          <textarea id="imp-csv" className="code" rows={8} spellCheck={false} placeholder={SAMPLE} value={csv} onChange={(e) => setCsv(e.target.value)} />
        </div>
        {msg && (
          <Notice kind={msg.kind}>
            {msg.text}
            {msg.rows && msg.rows.length > 0 && <ul>{msg.rows.slice(0, 15).map((r) => <li key={r.path}>{r.path}: {r.message}</li>)}</ul>}
          </Notice>
        )}
        <div className="inline"><button className="btn primary" disabled={busy || !csv.trim() || !from || !to} onClick={submit}>{busy ? 'Importing…' : 'Import worklogs'}</button></div>
      </section>
      <section className="card">
        <h2>Previous imports</h2>
        {history.length === 0 ? <p className="empty">No files imported yet.</p> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>When</th><th>Source</th><th>Period</th><th className="num">Rows</th><th>By</th></tr></thead>
              <tbody>{history.map((h) => <tr key={h.id}><td>{fmtWhen(h.importedAt)}</td><td>{SOURCE_NAME[h.source]}</td><td>{h.from} to {h.to}</td><td className="num">{h.rows}</td><td>{h.importedBy}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
