import { useRef, useState } from 'react';
import { DEFAULT_TEMPLATES } from '../../../shared/defaults';
import { SOURCE_NAME, type AiAssistKind, type TemplateId } from '../../../shared/settings';
import { dailyTargetSeconds, formatDate, formatHours, plannedSends, to12h, weekWindow } from '../../../shared/calc';
import { PLACEHOLDERS, fillHtml, fillText, pendingTableHtml, unknownPlaceholders, type TemplateContext } from '../../../shared/templates';
import { useSettings } from '../lib/settings-context';
import { api } from '../lib/api';
import { Input, Notice, PageHead } from '../components/ui';

const TABS: [TemplateId, string][] = [
  ['R1', 'Reminder 1 · Thu'], ['R2', 'Reminder 2 · Fri'], ['R3', 'Reminder 3 · first pending'], ['REPEAT', 'Every 2 hours'], ['INDIVIDUAL', 'Individual'],
];
const SAMPLE = [
  { code: '201101', name: 'Sample Person A', filled: '24.5', required: '40', pending: '15.5' },
  { code: '201102', name: 'Sample Person B', filled: '38', required: '40', pending: '2' },
];
const KIND_LABEL: Record<AiAssistKind, string> = { polish: 'Polish', shorten: 'Shorten', firm: 'Firmer tone', friendly: 'Friendlier tone' };

export function Templates() {
  const { draft, update, errors, data } = useSettings();
  const [tab, setTab] = useState<TemplateId>('R1');
  const [suggestion, setSuggestion] = useState<{ kind: AiAssistKind; text: string } | null>(null);
  const [aiBusy, setAiBusy] = useState<AiAssistKind | null>(null);
  const [aiError, setAiError] = useState('');
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const t = draft.templates[tab];
  const phs = tab === 'INDIVIDUAL' ? PLACEHOLDERS.individual : tab === 'R3' || tab === 'REPEAT' ? PLACEHOLDERS.pending : PLACEHOLDERS.general;
  const aiReady = data.settings.ai.enabled && data.secrets['ai.groq.apiKey'].set;

  const setBody = (body: string) => update((s) => { s.templates[tab].body = body; });
  const insert = (ph: string) => {
    const ta = bodyRef.current;
    const token = `{${ph}}`;
    const start = ta?.selectionStart ?? t.body.length;
    const end = ta?.selectionEnd ?? start;
    setBody(t.body.slice(0, start) + token + t.body.slice(end));
    requestAnimationFrame(() => { ta?.focus(); ta?.setSelectionRange(start + token.length, start + token.length); });
  };
  const runAi = async (kind: AiAssistKind) => {
    setAiBusy(kind);
    setAiError('');
    setSuggestion(null);
    try {
      const r = await api<{ text: string }>('POST', '/api/ai/assist', { kind, text: t.body });
      setSuggestion({ kind, text: r.text });
    } catch (e) {
      setAiError((e as Error).message);
    } finally {
      setAiBusy(null);
    }
  };

  // Preview context built from the current settings and clearly-marked sample people.
  const w = weekWindow(draft.week, new Date());
  const plan = plannedSends(draft).filter((p) => p.reportNumber);
  const reportNo = tab === 'REPEAT' ? 2 : 1;
  const next = plan.find((p) => p.reportNumber === reportNo + 1);
  const ctx: TemplateContext = {
    week_start: formatDate(w.start), week_end: formatDate(w.end), week_number: w.isoWeek,
    applications: draft.sources.filter((s) => s.enabled).map((s) => SOURCE_NAME[s.type]).join(' / ') || 'timesheet',
    daily_hours: formatHours(dailyTargetSeconds(draft.week)), weekly_hours: draft.week.weeklyHours,
    leave_ticket: draft.tickets.leave || '[leave ticket not set]',
    public_holiday_ticket: draft.tickets.holiday || '[holiday ticket not set]',
    bench_ticket: draft.tickets.bench || '[bench ticket not set]',
    sender_name: draft.signature.name || '[sender name not set]',
    sender_title: draft.signature.title, office_addresses: draft.signature.addresses || '[office addresses not set]',
    report_number: reportNo, pending_count: SAMPLE.length, next_run_time: next ? to12h(next.time) : 'the final check',
    source_notes: 'Data received from all enabled sources.',
    pending_table: pendingTableHtml(SAMPLE),
    employee_name: SAMPLE[0]!.name, required: SAMPLE[0]!.required, logged: SAMPLE[0]!.filled, pending: SAMPLE[0]!.pending,
  };
  const unknown = unknownPlaceholders(t.subject + '\n' + t.body);
  const event = draft.schedule.events.find((e) => e.id === tab);
  const to =
    tab === 'INDIVIDUAL' || event?.mode === 'individual' ? 'each pending employee'
      : (event?.mode === 'custom' ? draft.recipients.customList : draft.recipients.broadcastList).join(', ') || '(no recipients)';

  return (
    <>
      <PageHead title="Email templates" sub="Edit the subject and text for each reminder. Words in braces are filled in when the email is sent." />
      <div className="tabs" role="tablist">
        {TABS.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={k === tab} onClick={() => { setTab(k); setSuggestion(null); setAiError(''); }}>{l}</button>
        ))}
      </div>
      <div className="split">
        <section className="card">
          <Input label="Subject" path={`templates.${tab}.subject`} value={t.subject} onChange={(v) => update((s) => { s.templates[tab].subject = v; })} />
          <div className={`field${errors.get(`templates.${tab}.body`) ? ' has-error' : ''}`}>
            <label htmlFor="tpl-body">Body</label>
            <textarea id="tpl-body" ref={bodyRef} rows={18} value={t.body} onChange={(e) => setBody(e.target.value)} />
            {errors.get(`templates.${tab}.body`) && <p className="field-error">{errors.get(`templates.${tab}.body`)}</p>}
          </div>
          <div>
            <p className="label" style={{ marginBottom: 6 }}>Insert a placeholder</p>
            <div className="phs">{phs.map((p) => <button key={p} type="button" onClick={() => insert(p)}>{`{${p}}`}</button>)}</div>
          </div>
          <div className="inline">
            <button className="btn ghost" onClick={() => update((s) => { s.templates[tab] = { ...DEFAULT_TEMPLATES[tab] }; })}>Reset to default</button>
          </div>
          <div style={{ borderTop: '1px solid var(--line)', paddingTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="card-head">
              <h3>AI assist</h3>
              {aiReady ? <span className="chip ok">Groq ready</span> : <span className="chip idle">Off</span>}
            </div>
            <div className="inline">
              {(Object.keys(KIND_LABEL) as AiAssistKind[]).map((k) => (
                <button key={k} className="btn sm" disabled={!aiReady || !!aiBusy} onClick={() => runAi(k)}>
                  {aiBusy === k ? 'Working…' : KIND_LABEL[k]}
                </button>
              ))}
            </div>
            {!aiReady && <p className="help">Turn on AI assist and save a Groq key on the <a href="#ai">AI assist</a> page to use these.</p>}
            <p className="help">Only the template text is sent. Suggestions are never applied without your click.</p>
            {aiError && <Notice kind="warn">{aiError}</Notice>}
            {suggestion && (
              <div className="suggest">
                <div className="card-head"><h3>Suggested: {KIND_LABEL[suggestion.kind].toLowerCase()}</h3></div>
                <pre>{suggestion.text}</pre>
                <div className="inline">
                  <button className="btn primary sm" onClick={() => { setBody(suggestion.text); setSuggestion(null); }}>Apply</button>
                  <button className="btn ghost sm" onClick={() => setSuggestion(null)}>Discard</button>
                </div>
              </div>
            )}
          </div>
        </section>
        <section className="card" style={{ gap: 10 }}>
          <div className="card-head"><h2>Preview</h2><span className="hint">Sample people, real settings</span></div>
          {event?.mode === 'individual' && tab !== 'INDIVIDUAL' && (
            <Notice kind="info">This reminder is set to Individual, so each person receives the Individual template instead.</Notice>
          )}
          {unknown.length > 0 && <Notice kind="warn">Unknown placeholder: {unknown.map((u) => `{${u}}`).join(', ')}. It will be sent as typed.</Notice>}
          <div className="mail">
            <dl className="mail-head">
              <dt>From</dt><dd>{draft.emailProvider.fromName} &lt;{draft.emailProvider.from}&gt;</dd>
              <dt>To</dt><dd>{to}</dd>
              <dt>Subject</dt><dd><b>{fillText(t.subject, ctx)}</b></dd>
            </dl>
            {/* fillHtml escapes all template text and values; only the generated table is HTML. */}
            <div className="mail-body" dangerouslySetInnerHTML={{ __html: fillHtml(t.body, ctx, { markUnknown: true }) }} />
          </div>
        </section>
      </div>
      <section className="card">
        <h2>Values used in templates</h2>
        <div className="fields cols">
          <Input label="Leave ticket" path="tickets.leave" value={draft.tickets.leave} placeholder="for example HR-LEAVE" onChange={(v) => update((s) => { s.tickets.leave = v; })} />
          <Input label="Public holiday ticket" path="tickets.holiday" value={draft.tickets.holiday} placeholder="for example HR-HOLIDAY" onChange={(v) => update((s) => { s.tickets.holiday = v; })} />
          <Input label="Bench ticket" path="tickets.bench" value={draft.tickets.bench} placeholder="for example BENCH-01" onChange={(v) => update((s) => { s.tickets.bench = v; })} />
          <Input label="Sender name" path="signature.name" value={draft.signature.name} onChange={(v) => update((s) => { s.signature.name = v; })} />
          <Input label="Sender title" path="signature.title" value={draft.signature.title} onChange={(v) => update((s) => { s.signature.title = v; })} />
        </div>
        <div className="field">
          <label htmlFor="sig-addr">Office addresses</label>
          <textarea id="sig-addr" rows={2} value={draft.signature.addresses} placeholder="Full office addresses for the footer"
            onChange={(e) => update((s) => { s.signature.addresses = e.target.value; })} />
        </div>
      </section>
    </>
  );
}
