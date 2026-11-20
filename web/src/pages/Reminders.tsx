import { useEffect, useMemo, useState } from 'react';
import {
  DAY_LABEL, type EmailMessage, type EmailStatus, type EventId, type RecipientMode, type SendSummary, type WeekTimesheets,
} from '../../../shared/settings';
import { to12h } from '../../../shared/calc';
import { api, ApiError } from '../lib/api';
import { useSettings } from '../lib/settings-context';
import { Notice, PageHead, fmtWhen } from '../components/ui';

const MODE_LABEL: Record<RecipientMode, string> = { broadcast: 'Broadcast', individual: 'Individual', custom: 'Custom' };
const STATUS_CHIP: Record<EmailStatus, [string, string]> = {
  sent: ['ok', 'Sent'], dry_run: ['info', 'Dry run'], failed: ['bad', 'Failed'], test: ['info', 'Test'],
};

export function Reminders() {
  const { data, dirty } = useSettings();
  const settings = data.settings; // sending uses the SAVED settings, not the unsaved draft
  const [week, setWeek] = useState<WeekTimesheets | null>(null);
  const [history, setHistory] = useState<EmailMessage[]>([]);
  const [busy, setBusy] = useState<string>('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'bad' | 'info'; text: string } | null>(null);
  const [testTo, setTestTo] = useState('');
  const [testEvent, setTestEvent] = useState<EventId>('R3');

  const loadHistory = () => api<EmailMessage[]>('GET', '/api/emails').then(setHistory, () => {});
  useEffect(() => {
    loadHistory();
    api<WeekTimesheets>('GET', '/api/timesheets').then(setWeek, () => {});
  }, []);

  const pendingCount = useMemo(() => (week ? week.rows.filter((r) => r.status === 'pending').length : 0), [week]);

  const recipientSummary = (mode: RecipientMode): string => {
    if (mode === 'individual') return `${pendingCount} pending employee${pendingCount === 1 ? '' : 's'}`;
    const list = mode === 'custom' ? settings.recipients.customList : settings.recipients.broadcastList;
    return list.length ? `${list.length} address${list.length === 1 ? '' : 'es'}` : 'no addresses set';
  };

  const send = async (eventId: EventId) => {
    setBusy(eventId);
    setMsg(null);
    try {
      const r = await api<SendSummary>('POST', '/api/reminders/send', { eventId });
      const parts = [r.sent && `${r.sent} sent`, r.dryRunCount && `${r.dryRunCount} recorded (dry run)`, r.skipped && `${r.skipped} already sent`, r.failed && `${r.failed} failed`].filter(Boolean);
      setMsg({ kind: r.failed ? 'bad' : 'ok', text: `${eventId}: ${parts.join(', ') || 'nothing to send'}.` });
      loadHistory();
    } catch (e) {
      setMsg({ kind: 'bad', text: (e as ApiError).message });
    } finally {
      setBusy('');
    }
  };

  const sendTest = async () => {
    setBusy('test');
    setMsg(null);
    try {
      await api<EmailMessage>('POST', '/api/reminders/test', { eventId: testEvent, to: testTo });
      setMsg({ kind: 'ok', text: `Test ${testEvent} sent to ${testTo}.` });
      loadHistory();
    } catch (e) {
      setMsg({ kind: 'bad', text: (e as ApiError).message });
    } finally {
      setBusy('');
    }
  };

  return (
    <>
      <PageHead title="Reminders" sub="Send a reminder now, or review every email the app has sent. Scheduled reminders also run automatically at the times set on Schedule & week." />

      <Notice kind={settings.dryRun ? 'info' : 'warn'}>
        {settings.dryRun
          ? 'Dry run is on. Reminders are rendered and recorded in the history below, but no email is delivered. Turn it off (top bar) and save to send for real.'
          : 'Live sending is on. Reminders go to real recipients using the saved email provider.'}
        {dirty && ' You have unsaved changes; sending uses the last saved settings until you save.'}
      </Notice>
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}

      <section className="card">
        <h2>Send a reminder now</h2>
        <p className="help">This uses the latest timesheet check for the week (run one on the Dashboard first). The same reminder is never delivered twice to the same recipient in a week.</p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Event</th><th>Scheduled</th><th>Mode</th><th>Who receives</th><th></th></tr></thead>
            <tbody>
              {settings.schedule.events.map((e) => (
                <tr key={e.id}>
                  <td><div className="who">{e.label}<small>{e.id}{e.enabled ? '' : ' · disabled'}</small></div></td>
                  <td>{DAY_LABEL[e.day]} {to12h(e.time)}{e.id === 'REPEAT' ? `, every ${e.intervalHours} h` : ''}</td>
                  <td>{MODE_LABEL[e.mode]}</td>
                  <td>{recipientSummary(e.mode)}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="btn" disabled={!!busy} aria-busy={busy === e.id} onClick={() => send(e.id)}>
                      {busy === e.id ? 'Sending…' : settings.dryRun ? 'Simulate' : 'Send now'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="help">Pending this week: <b>{pendingCount}</b>. Broadcast/Custom send one email with the pending table; Individual sends one private email to each pending employee.</p>
      </section>

      <section className="card">
        <h2>Send a test to yourself</h2>
        <p className="help">Delivers one rendered message to an address you choose, using this week’s data. It ignores dry run and is always delivered, so you can check formatting.</p>
        <div className="inline">
          <div className="field">
            <label htmlFor="test-event">Template</label>
            <select id="test-event" value={testEvent} onChange={(ev) => setTestEvent(ev.target.value as EventId)}>
              {settings.schedule.events.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="test-to">Your email</label>
            <input id="test-to" type="email" placeholder="you@company.com" value={testTo} onChange={(ev) => setTestTo(ev.target.value)} />
          </div>
          <button className="btn primary" style={{ alignSelf: 'flex-end' }} disabled={busy === 'test' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(testTo)} onClick={sendTest}>
            {busy === 'test' ? 'Sending…' : 'Send test'}
          </button>
        </div>
      </section>

      <section className="card">
        <h2>Email history</h2>
        {history.length === 0 ? <p className="empty">No emails yet. Send one above, or wait for a scheduled reminder.</p> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>When</th><th>Event</th><th>Mode</th><th>To</th><th>Subject</th><th>Status</th></tr></thead>
              <tbody>
                {history.map((m) => (
                  <tr key={m.id}>
                    <td>{fmtWhen(m.sentAt)}</td>
                    <td>{m.eventId}{m.cycleNo > 1 ? ` #${m.cycleNo}` : ''}<br /><small className="hint">{m.trigger}</small></td>
                    <td>{MODE_LABEL[m.mode]}</td>
                    <td>{m.to.join(', ') || m.recipient}</td>
                    <td>{m.subject}{m.error && <><br /><small className="red">{m.error}</small></>}</td>
                    <td><span className={`chip ${STATUS_CHIP[m.status][0]}`}>{STATUS_CHIP[m.status][1]}</span></td>
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
