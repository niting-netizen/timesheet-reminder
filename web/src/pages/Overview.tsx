import { DAY_LABEL, SOURCE_NAME } from '../../../shared/settings';
import { dailyTargetSeconds, formatDate, formatHours, weekWindow } from '../../../shared/calc';
import { useSettings } from '../lib/settings-context';
import { useEmployees } from '../lib/useEmployees';
import { Notice, PageHead, StatusChip, fmtWhen } from '../components/ui';

export function Overview() {
  const { data, draft, tests } = useSettings();
  const { list } = useEmployees();
  const s = data.settings; // saved settings, not unsaved edits
  const w = weekWindow(s.week, new Date());
  const enabled = s.sources.filter((x) => x.enabled);
  const active = (list ?? []).filter((e) => e.active);
  const unmapped = active.filter((e) => Object.keys(e.accounts).length === 0);

  const checks: { label: string; done: boolean; detail: string; href: string }[] = [
    ...enabled.map((x) => ({
      label: `${SOURCE_NAME[x.type]} connected`,
      done: !!tests[`source.${x.type}`]?.ok,
      detail: tests[`source.${x.type}`]?.message ?? 'Not tested yet',
      href: '#sources',
    })),
    { label: 'Email provider connected', done: !!tests.email?.ok, detail: tests.email?.message ?? 'Not tested yet', href: '#provider' },
    {
      label: 'Recipients set',
      done: s.recipients.broadcastList.length > 0,
      detail: s.recipients.broadcastList.length ? `${s.recipients.broadcastList.length} broadcast address(es)` : 'Broadcast list is empty',
      href: '#recipients',
    },
    {
      label: 'Employee master loaded',
      done: active.length > 0 && unmapped.length === 0,
      detail: list ? `${active.length} active · ${unmapped.length} without a source account` : 'Loading…',
      href: '#employees',
    },
    {
      label: 'Template values filled in',
      done: !!(s.tickets.leave && s.tickets.holiday && s.tickets.bench && s.signature.name),
      detail: 'Leave, holiday and bench tickets, and sender name',
      href: '#templates',
    },
  ];
  const done = checks.filter((c) => c.done).length;

  return (
    <>
      <PageHead title="Setup overview" sub={`Week ${w.isoWeek} · ${formatDate(w.start)} to ${formatDate(w.end)} · ${s.week.timezone}`} />
      {draft !== s && JSON.stringify(draft) !== JSON.stringify(s) && <Notice kind="warn">You have unsaved changes. This page shows saved settings.</Notice>}
      <div className="stats">
        <div className="stat"><div className="k">Setup steps done</div><div className="v">{done}/{checks.length}</div></div>
        <div className="stat"><div className="k">Working week</div><div className="v small">{DAY_LABEL[s.week.startDay]} to {DAY_LABEL[s.week.endDay]}</div></div>
        <div className="stat"><div className="k">Weekly target</div><div className="v">{s.week.weeklyHours} h</div></div>
        <div className="stat"><div className="k">Per day</div><div className="v">{formatHours(dailyTargetSeconds(s.week))} h</div></div>
        <div className="stat"><div className="k">Mode</div><div className="v small">{s.dryRun ? 'Dry run (no emails)' : 'Live sending'}</div></div>
      </div>
      <section className="card">
        <div className="card-head"><h2>Setup checklist</h2><span className="hint">Settings saved {data.updatedAt ? fmtWhen(data.updatedAt) : 'never'}</span></div>
        <div className="check-list">
          {checks.map((c) => (
            <div className="check-row" key={c.label}>
              <div><a href={c.href}><b>{c.label}</b></a><br /><span className="hint">{c.detail}</span></div>
              {c.done ? <span className="chip ok">Done</span> : <span className="chip warn">To do</span>}
            </div>
          ))}
        </div>
      </section>
      <section className="card">
        <h2>Sources</h2>
        <div className="check-list">
          {s.sources.map((x) => (
            <div className="check-row" key={x.type}>
              <span>{SOURCE_NAME[x.type]} <span className="hint">· {x.authType.replace('_', ' ')}</span></span>
              <StatusChip result={tests[`source.${x.type}`]} enabled={x.enabled} />
            </div>
          ))}
        </div>
      </section>
      <Notice kind="info">
        Scheduled sending, email history and Excel export arrive in the next phases. Run checks now from the <a href="#dashboard">Dashboard</a>.
      </Notice>
    </>
  );
}
