import { useState, type FormEvent } from 'react';
import { SOURCE_NAME, SOURCE_TYPES, type Employee, type FieldError } from '../../../shared/settings';
import { api, ApiError } from '../lib/api';
import { useEmployees } from '../lib/useEmployees';
import { Notice, PageHead } from '../components/ui';

type Form = Omit<Employee, 'id'> & { id?: number };
const blank = (): Form => ({ employeeCode: '', name: '', email: '', team: '', active: true, accounts: {} });
const SAMPLE_CSV = 'employee_code,name,email,team,active,jira,redmine,pulse\n201101,Asha Rao,asha.rao@yourcompany.com,QA,yes,5b10ac8d82e05b22cc7d4ef5,arao,\n';

export function Employees() {
  const { list, error, reload } = useEmployees();
  const [form, setForm] = useState<Form | null>(null);
  const [formError, setFormError] = useState('');
  const [csv, setCsv] = useState('');
  const [importMsg, setImportMsg] = useState<{ kind: 'ok' | 'bad'; text: string; rows?: FieldError[] } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [q, setQ] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setFormError('');
    try {
      const { id, ...body } = form;
      if (id) await api('PUT', `/api/employees/${id}`, body);
      else await api('POST', '/api/employees', body);
      setForm(null);
      reload();
    } catch (err) {
      setFormError((err as Error).message);
    }
  };
  const doImport = async () => {
    setImportMsg(null);
    try {
      const r = await api<{ created: number; updated: number }>('POST', '/api/employees/import', { csv });
      setImportMsg({ kind: 'ok', text: `Imported: ${r.created} added, ${r.updated} updated.` });
      setCsv('');
      reload();
    } catch (err) {
      const e = err as ApiError;
      setImportMsg({ kind: 'bad', text: e.message, rows: e.fieldErrors });
    }
  };
  const remove = async (id: number) => {
    await api('DELETE', `/api/employees/${id}`).catch((e: Error) => setFormError(e.message));
    setConfirmDelete(null);
    reload();
  };

  const shown = (list ?? []).filter((e) => !q || `${e.name} ${e.employeeCode} ${e.email} ${e.team}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <>
      <PageHead title="Employees" sub="The employee master: who is in scope, their email, and their account ID in each source.">
        <button className="btn primary" onClick={() => { setForm(blank()); setFormError(''); }}>Add employee</button>
      </PageHead>
      {error && <Notice kind="bad">{error}</Notice>}

      {form && (
        <form className="card" onSubmit={submit}>
          <h2>{form.id ? `Edit ${form.name}` : 'Add employee'}</h2>
          <div className="fields cols">
            {([['employeeCode', 'Employee ID'], ['name', 'Name'], ['email', 'Email'], ['team', 'Team']] as const).map(([k, l]) => (
              <div className="field" key={k}>
                <label htmlFor={`emp-${k}`}>{l}</label>
                <input id={`emp-${k}`} type={k === 'email' ? 'email' : 'text'} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
              </div>
            ))}
            {SOURCE_TYPES.map((s) => (
              <div className="field" key={s}>
                <label htmlFor={`emp-acc-${s}`}>{SOURCE_NAME[s]} account ID</label>
                <input id={`emp-acc-${s}`} value={form.accounts[s] ?? ''} placeholder={s === 'jira' ? 'Atlassian account ID' : 'User ID or login'}
                  onChange={(e) => setForm({ ...form, accounts: { ...form.accounts, [s]: e.target.value } })} />
              </div>
            ))}
          </div>
          <label className="check"><input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Active (in scope for reminders)</label>
          {formError && <p className="field-error">{formError}</p>}
          <div className="inline">
            <button className="btn primary">Save employee</button>
            <button type="button" className="btn ghost" onClick={() => setForm(null)}>Cancel</button>
          </div>
        </form>
      )}

      <section className="card">
        <div className="card-head">
          <h2>{list ? `${list.length} employees` : 'Employees'}</h2>
          <input type="search" placeholder="Search name, ID, email or team" aria-label="Search employees" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 280 }} />
        </div>
        {list && list.length === 0 ? (
          <p className="empty">No employees yet. Add one, or import a CSV below.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>EMP ID</th><th>Name</th><th>Email</th><th>Team</th><th>Accounts</th><th>Status</th><th /></tr></thead>
              <tbody>
                {shown.map((e) => (
                  <tr key={e.id}>
                    <td className="num" style={{ textAlign: 'left' }}>{e.employeeCode}</td>
                    <td>{e.name}</td>
                    <td>{e.email}</td>
                    <td>{e.team}</td>
                    <td>{Object.keys(e.accounts).map((s) => SOURCE_NAME[s as keyof typeof SOURCE_NAME]).join(', ') || <span className="chip warn">None mapped</span>}</td>
                    <td>{e.active ? <span className="chip ok">Active</span> : <span className="chip idle">Inactive</span>}</td>
                    <td>
                      <div className="row-actions">
                        {confirmDelete === e.id ? (
                          <>
                            <button className="btn sm danger" onClick={() => remove(e.id)}>Confirm delete</button>
                            <button className="btn sm ghost" onClick={() => setConfirmDelete(null)}>Keep</button>
                          </>
                        ) : (
                          <>
                            <button className="btn sm" onClick={() => { setForm({ ...e }); setFormError(''); window.scrollTo(0, 0); }}>Edit</button>
                            <button className="btn sm ghost" onClick={() => setConfirmDelete(e.id)}>Delete</button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2>Import from CSV</h2>
        <p className="hint">Paste rows with a header line. Columns: employee_code, name, email, team, active, jira, redmine, pulse, texpert. Existing employee IDs are updated. If any row is invalid, nothing is imported.</p>
        <div className="field">
          <label htmlFor="csv">CSV</label>
          <textarea id="csv" className="code" rows={6} spellCheck={false} value={csv} placeholder={SAMPLE_CSV} onChange={(e) => setCsv(e.target.value)} />
        </div>
        {importMsg && (
          <Notice kind={importMsg.kind}>
            {importMsg.text}
            {importMsg.rows && importMsg.rows.length > 0 && <ul>{importMsg.rows.slice(0, 10).map((r) => <li key={r.path}>{r.path}: {r.message}</li>)}</ul>}
          </Notice>
        )}
        <div className="inline"><button className="btn" disabled={!csv.trim()} onClick={doImport}>Import</button></div>
      </section>
    </>
  );
}
