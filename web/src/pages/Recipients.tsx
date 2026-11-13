import { useState } from 'react';
import { DAY_LABEL, type RecipientMode, type Settings } from '../../../shared/settings';
import { to12h } from '../../../shared/calc';
import { useSettings } from '../lib/settings-context';
import { useEmployees } from '../lib/useEmployees';
import { ListInput, Notice, PageHead } from '../components/ui';

const MODE_OPTS: [RecipientMode, string][] = [
  ['broadcast', 'Broadcast: everyone pending, one email'],
  ['individual', 'Individual: one email per person'],
  ['custom', 'Custom list: selected addresses only'],
];
const MODE_LABEL: Record<RecipientMode, string> = { broadcast: 'Broadcast', individual: 'Individual', custom: 'Custom list' };

export function Recipients() {
  const { draft, update, errors } = useSettings();
  const { list: employees } = useEmployees();
  const [previewIdx, setPreviewIdx] = useState(2);
  const ev = draft.schedule.events;
  const empEmails = new Set((employees ?? []).map((e) => e.email));
  const custom = draft.recipients.customList;
  const others = custom.filter((a) => !empEmails.has(a));
  const toggle = (email: string, on: boolean) =>
    update((s) => {
      const set = new Set(s.recipients.customList);
      if (on) set.add(email);
      else set.delete(email);
      s.recipients.customList = [...set];
    });

  return (
    <>
      <PageHead title="Recipients (To)" sub="Pick who receives each reminder. The preview updates as you edit." />
      <div className="modes">
        <div className="mode"><b>Broadcast</b>One email to the broadcast list with a table of everyone who has not completed their timesheet.</div>
        <div className="mode"><b>Individual</b>A separate email to each pending person, showing only their own hours. Nobody sees anyone else.</div>
        <div className="mode"><b>Custom list</b>The pending table goes only to the addresses you select below.</div>
      </div>

      <section className="card">
        <h2>To, per reminder</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Reminder</th><th>When</th><th>To</th></tr></thead>
            <tbody>
              {ev.map((e, i) => (
                <tr key={e.id}>
                  <td>{e.label}{!e.enabled && <span className="hint"> (off)</span>}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{e.id === 'REPEAT' ? `Every ${e.intervalHours} h after R3` : `${DAY_LABEL[e.day]} ${to12h(e.time)}`}</td>
                  <td style={{ minWidth: 240 }}>
                    <select aria-label={`To for ${e.label}`} value={e.mode}
                      onChange={(x) => update((s) => { s.schedule.events[i]!.mode = x.target.value as RecipientMode; })}>
                      {MODE_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="split">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          <section className="card">
            <h2>Broadcast list</h2>
            <ListInput label="Addresses (one per line)" path="recipients.broadcastList" value={draft.recipients.broadcastList}
              placeholder="timesheet-all@yourcompany.com" help="Usually a distribution list, such as all staff or managers and leads."
              onChange={(v) => update((s) => { s.recipients.broadcastList = v; })} />
          </section>
          <section className="card">
            <h2>Custom list</h2>
            {errors.get('recipients.customList') && <p className="field-error">{errors.get('recipients.customList')}</p>}
            <p className="hint">Select people from the employee master, or type other addresses.</p>
            {employees && employees.length > 0 ? (
              <div className="picker">
                {employees.filter((e) => e.active).map((e) => (
                  <label key={e.id} className="check">
                    <input type="checkbox" checked={custom.includes(e.email)} onChange={(x) => toggle(e.email, x.target.checked)} />
                    {e.name} <small>{e.email}</small>
                  </label>
                ))}
              </div>
            ) : (
              <p className="hint">No employees yet. Add them on the <a href="#employees">Employees</a> page to pick from a list.</p>
            )}
            <ListInput label="Other addresses" path="recipients.customListOther" value={others} rows={2} placeholder="project-lead@yourcompany.com"
              onChange={(v) => update((s) => { s.recipients.customList = [...s.recipients.customList.filter((a) => empEmails.has(a)), ...v]; })} />
          </section>
          <section className="card">
            <h2>CC on every email</h2>
            <ListInput label="Addresses (optional)" path="recipients.cc" value={draft.recipients.cc} rows={2}
              help="Not used in Individual mode, so personal hours stay private."
              onChange={(v) => update((s) => { s.recipients.cc = v; })} />
          </section>
        </div>
        <section className="card">
          <div className="card-head">
            <h2>Who will receive this?</h2>
            <select aria-label="Reminder to preview" style={{ width: 'auto' }} value={previewIdx} onChange={(e) => setPreviewIdx(Number(e.target.value))}>
              {ev.map((e, i) => <option key={e.id} value={i}>{e.label}</option>)}
            </select>
          </div>
          <Preview settings={draft} index={previewIdx} activeEmployees={(employees ?? []).filter((e) => e.active).length} />
        </section>
      </div>
    </>
  );
}

function Preview({ settings, index, activeEmployees }: { settings: Settings; index: number; activeEmployees: number }) {
  const ev = settings.schedule.events[index]!;
  const general = ev.id === 'R1' || ev.id === 'R2';
  if (ev.mode === 'individual') {
    return (
      <>
        <p><span className="chip info">{MODE_LABEL[ev.mode]}</span></p>
        <p>One separate email to each employee who is still pending when the reminder runs. Each person sees only their own hours. No CC.</p>
        <p className="hint">{activeEmployees} active employees in the master list. Who is pending is decided at send time from live worklogs.</p>
      </>
    );
  }
  const list = ev.mode === 'custom' ? settings.recipients.customList : settings.recipients.broadcastList;
  return (
    <>
      <p><span className="chip info">{MODE_LABEL[ev.mode]}</span></p>
      <p>
        One email to {ev.mode === 'custom' ? `only the ${list.length} selected address${list.length === 1 ? '' : 'es'}` : `${list.length} broadcast address${list.length === 1 ? '' : 'es'}`}
        {general ? ' with the general reminder (no table).' : ' with the table of everyone still pending.'}
      </p>
      {list.length === 0 && <Notice kind="bad">This list is empty, so this reminder would send nothing. You can save in dry run, but live sending needs at least one address.</Notice>}
      <div className="addr" style={{ marginTop: 4 }}>{list.map((a) => <span key={a}>{a}</span>)}</div>
      {settings.recipients.cc.length > 0 && <p className="hint">CC: {settings.recipients.cc.join(', ')}</p>}
    </>
  );
}
