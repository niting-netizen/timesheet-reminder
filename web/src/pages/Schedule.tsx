import { DAYS, DAY_LABEL, type Weekday } from '../../../shared/settings';
import { HOUR, dailyTargetSeconds, formatHours, plannedSends, targetSeconds, to12h, workingDays } from '../../../shared/calc';
import { useSettings } from '../lib/settings-context';
import { Input, Notice, PageHead, Select, Switch } from '../components/ui';

const DAY_OPTS = DAYS.map((d) => [d, DAY_LABEL[d]] as const);
const TIMEZONES = ['Asia/Kolkata', 'UTC', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'America/New_York'];
const SKIP: Record<string, string> = { not_working_day: 'Skipped: not a working day', outside_window: 'Skipped: outside allowed hours' };

export function Schedule() {
  const { draft, update, errors } = useSettings();
  const w = draft.week;
  const days = workingDays(w).length;
  const daily = dailyTargetSeconds(w);
  const tzOpts = (TIMEZONES.includes(w.timezone) ? TIMEZONES : [w.timezone, ...TIMEZONES]).map((t) => [t, t] as const);
  const plan = plannedSends(draft);

  return (
    <>
      <PageHead title="Schedule & week" sub="Define the working week, the hour target and when each reminder goes out." />
      <div className="grid2">
        <section className="card">
          <h2>Working week</h2>
          <div className="fields cols">
            <Select label="Week starts on" path="week.startDay" value={w.startDay} options={DAY_OPTS} onChange={(v: Weekday) => update((s) => { s.week.startDay = v; })} />
            <Select label="Week ends on" path="week.endDay" value={w.endDay} options={DAY_OPTS} onChange={(v: Weekday) => update((s) => { s.week.endDay = v; })} />
            <Input label="Weekly hours target" path="week.weeklyHours" type="number" min={1} max={80} step={0.5} value={w.weeklyHours}
              onChange={(v) => update((s) => { s.week.weeklyHours = Number(v) || 0; })} />
            <Input label="Daily hours (0 = automatic)" path="week.dailyOverride" type="number" min={0} max={24} step={0.5} value={w.dailyOverride}
              onChange={(v) => update((s) => { s.week.dailyOverride = Number(v) || 0; })} />
            <Select label="Timezone" path="week.timezone" value={w.timezone} options={tzOpts} onChange={(v) => update((s) => { s.week.timezone = v; })} />
          </div>
          {days > 0 && w.weeklyHours > 0 ? (
            <Notice kind="ok">
              <b>{days} working days</b> ({DAY_LABEL[w.startDay]} to {DAY_LABEL[w.endDay]}) · <b>{formatHours(daily)} h per day</b> · {w.weeklyHours} h per week.
              One approved leave day lowers the target to {formatHours(targetSeconds(w, { approvedDaysOff: 1 }))} h.
              {w.dailyOverride > 0 && Math.abs(daily * days - w.weeklyHours * HOUR) > 60 && ' Note: the daily override times the working days does not equal the weekly target.'}
            </Notice>
          ) : (
            <Notice kind="bad">The week must end on or after the day it starts, and the weekly target must be above 0.</Notice>
          )}
        </section>
        <section className="card">
          <h2>Limits</h2>
          <div className="fields cols">
            <Input label="Friday cutoff" path="schedule.cutoff" type="time" value={draft.schedule.cutoff} onChange={(v) => update((s) => { s.schedule.cutoff = v; })} />
            <Input label="Max pending reports" path="schedule.maxReminders" type="number" min={1} max={12} value={draft.schedule.maxReminders}
              onChange={(v) => update((s) => { s.schedule.maxReminders = Math.round(Number(v)) || 0; })} />
            <Input label="Allowed from" path="schedule.windowFrom" type="time" value={draft.schedule.windowFrom} onChange={(v) => update((s) => { s.schedule.windowFrom = v; })} />
            <Input label="Allowed until" path="schedule.windowTo" type="time" value={draft.schedule.windowTo} onChange={(v) => update((s) => { s.schedule.windowTo = v; })} />
          </div>
          <Switch label="Pause all reminders" checked={draft.schedule.paused} onChange={(v) => update((s) => { s.schedule.paused = v; })} />
          <p className="help">Reminders never go out outside the allowed hours or on non-working days.</p>
        </section>
      </div>

      <section className="card">
        <h2>Reminder events</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>On</th><th>Event</th><th>Day</th><th>Time</th><th>Content</th></tr></thead>
            <tbody>
              {draft.schedule.events.map((e, i) => {
                const on = (
                  <input type="checkbox" aria-label={`Enable ${e.label}`} checked={e.enabled}
                    onChange={(x) => update((s) => { s.schedule.events[i]!.enabled = x.target.checked; })} />
                );
                if (e.id === 'REPEAT') {
                  return (
                    <tr key={e.id}>
                      <td>{on}</td><td>{e.label}</td>
                      <td colSpan={2}>
                        <div className="inline">Every
                          <input type="number" min={0.5} max={6} step={0.5} style={{ width: 80 }} aria-label="Repeat interval in hours" value={e.intervalHours}
                            onChange={(x) => update((s) => { s.schedule.events[i]!.intervalHours = Number(x.target.value) || 0; })} />
                          hours after R3, until the cutoff
                        </div>
                        {errors.get(`schedule.events.${i}.intervalHours`) && <p className="field-error">{errors.get(`schedule.events.${i}.intervalHours`)}</p>}
                      </td>
                      <td>Refreshed pending table</td>
                    </tr>
                  );
                }
                return (
                  <tr key={e.id}>
                    <td>{on}</td><td>{e.label}</td>
                    <td style={{ minWidth: 130 }}>
                      <select aria-label={`Day for ${e.label}`} value={e.day} onChange={(x) => update((s) => { s.schedule.events[i]!.day = x.target.value as Weekday; })}>
                        {DAY_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </select>
                    </td>
                    <td style={{ minWidth: 120 }}>
                      <input type="time" aria-label={`Time for ${e.label}`} value={e.time} onChange={(x) => update((s) => { s.schedule.events[i]!.time = x.target.value; })} />
                    </td>
                    <td>{e.id === 'R3' ? 'First pending table' : 'Instructions only, no table'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="help">The To setting for each event is on the <a href="#recipients">Recipients</a> page.</p>
      </section>

      <section className="card">
        <div className="card-head"><h2>Weekly send plan</h2><span className="hint">Recalculated as you edit</span></div>
        <div className="timeline">
          {plan.length === 0 && <p className="hint">No reminders are turned on.</p>}
          {plan.map((p) => (
            <div className="tl" key={`${p.day}${p.time}${p.eventId}`}>
              <span className="when">{DAY_LABEL[p.day].slice(0, 3)} {to12h(p.time)}</span>
              <span>{p.reportNumber ? `${p.eventId === 'R3' ? 'R3' : 'Repeat'} · Pending list #${p.reportNumber}` : `${p.eventId} · General reminder`}</span>
              {p.skipReason ? <span className="chip warn">{SKIP[p.skipReason]}</span> : <span className="chip ok">Scheduled</span>}
            </div>
          ))}
        </div>
        <p className="help">Pending reports stop early once nobody is pending. Sending starts in a later phase; nothing is sent yet.</p>
      </section>
    </>
  );
}
