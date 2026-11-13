import { useEffect, useState, type FormEvent } from 'react';
import type { Adjustment } from '../../../shared/settings';
import { api } from '../lib/api';
import { useEmployees } from '../lib/useEmployees';
import { Notice, PageHead } from '../components/ui';

export function Leave() {
  const { list: employees } = useEmployees();
  const [items, setItems] = useState<Adjustment[]>([]);
  const [who, setWho] = useState('all');
  const [date, setDate] = useState('');
  const [partial, setPartial] = useState(false);
  const [hours, setHours] = useState('4');
  const [approved, setApproved] = useState(true);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState<number | null>(null);

  const load = () => api<Adjustment[]>('GET', '/api/adjustments').then(setItems, (e: Error) => setError(e.message));
  useEffect(() => { load(); }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await api('POST', '/api/adjustments', {
        employeeId: who === 'all' ? null : Number(who),
        kind: who === 'all' ? 'holiday' : 'leave',
        date, hours: partial ? Number(hours) : null, approved, note,
      });
      setDate('');
      setNote('');
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const remove = async (id: number) => {
    await api('DELETE', `/api/adjustments/${id}`).catch((e: Error) => setError(e.message));
    setConfirm(null);
    load();
  };

  return (
    <>
      <PageHead title="Leave & holidays" sub="Approved leave and public holidays lower the weekly target. Unapproved entries are recorded but never change a target." />
      <Notice kind="info">Agree the authoritative source of approved leave with HR. Until that is connected, record approved leave here.</Notice>
      <form className="card" onSubmit={submit}>
        <h2>Add an entry</h2>
        <div className="fields cols">
          <div className="field">
            <label htmlFor="lv-who">Who</label>
            <select id="lv-who" value={who} onChange={(e) => setWho(e.target.value)}>
              <option value="all">Everyone (public holiday)</option>
              {(employees ?? []).filter((e) => e.active).map((e) => <option key={e.id} value={e.id}>{e.name} (leave)</option>)}
            </select>
          </div>
          <div className="field"><label htmlFor="lv-date">Date</label><input id="lv-date" type="date" required value={date} onChange={(e) => setDate(e.target.value)} /></div>
          <div className="field">
            <label htmlFor="lv-len">Length</label>
            <select id="lv-len" value={partial ? 'part' : 'full'} onChange={(e) => setPartial(e.target.value === 'part')}>
              <option value="full">Full day</option><option value="part">Part of a day</option>
            </select>
          </div>
          {partial && <div className="field"><label htmlFor="lv-h">Hours off</label><input id="lv-h" type="number" min={0.5} max={24} step={0.5} value={hours} onChange={(e) => setHours(e.target.value)} /></div>}
          <div className="field"><label htmlFor="lv-note">Note (optional)</label><input id="lv-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Diwali, HR ticket ref" /></div>
        </div>
        <label className="check"><input type="checkbox" checked={approved} onChange={(e) => setApproved(e.target.checked)} /> Approved</label>
        {error && <p className="field-error">{error}</p>}
        <div className="inline"><button className="btn primary" disabled={!date}>Add</button></div>
      </form>
      <section className="card">
        <h2>Entries</h2>
        {items.length === 0 ? <p className="empty">No leave or holidays recorded.</p> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Date</th><th>Who</th><th>Type</th><th>Length</th><th>Status</th><th>Note</th><th /></tr></thead>
              <tbody>
                {items.map((a) => (
                  <tr key={a.id}>
                    <td>{a.date}</td>
                    <td>{a.employeeName ?? 'Everyone'}</td>
                    <td>{a.kind === 'holiday' ? 'Public holiday' : 'Leave'}</td>
                    <td>{a.hours === null ? 'Full day' : `${a.hours} h`}</td>
                    <td>{a.approved ? <span className="chip ok">Approved</span> : <span className="chip idle">Not approved</span>}</td>
                    <td className="hint">{a.note}</td>
                    <td>
                      <div className="row-actions">
                        {confirm === a.id ? (
                          <><button className="btn sm danger" onClick={() => remove(a.id)}>Confirm delete</button><button className="btn sm ghost" onClick={() => setConfirm(null)}>Keep</button></>
                        ) : <button className="btn sm ghost" onClick={() => setConfirm(a.id)}>Delete</button>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
