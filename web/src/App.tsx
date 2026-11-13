import { useEffect, useState, type FormEvent } from 'react';
import { api, getToken, setToken, setUnauthorizedHandler } from './lib/api';
import { SettingsProvider, useSettings } from './lib/settings-context';
import { Switch } from './components/ui';
import { Overview } from './pages/Overview';
import { Dashboard } from './pages/Dashboard';
import { Imports } from './pages/Imports';
import { Leave } from './pages/Leave';
import { Sources } from './pages/Sources';
import { Provider } from './pages/Provider';
import { Recipients } from './pages/Recipients';
import { Schedule } from './pages/Schedule';
import { Templates } from './pages/Templates';
import { Ai } from './pages/Ai';
import { Employees } from './pages/Employees';

const VIEWS = {
  dashboard: { label: 'Dashboard', group: 'Timesheets', Page: Dashboard },
  imports: { label: 'Worklog import', group: 'Timesheets', Page: Imports },
  leave: { label: 'Leave & holidays', group: 'Timesheets', Page: Leave },
  employees: { label: 'Employees', group: 'Timesheets', Page: Employees },
  overview: { label: 'Setup overview', group: 'Configuration', Page: Overview },
  sources: { label: 'Sources & API keys', group: 'Configuration', Page: Sources },
  provider: { label: 'Email provider', group: 'Configuration', Page: Provider },
  recipients: { label: 'Recipients (To)', group: 'Configuration', Page: Recipients },
  schedule: { label: 'Schedule & week', group: 'Configuration', Page: Schedule },
  templates: { label: 'Email templates', group: 'Configuration', Page: Templates },
  ai: { label: 'AI assist (Groq)', group: 'Configuration', Page: Ai },
} as const;
type ViewKey = keyof typeof VIEWS;

const currentView = (): ViewKey => {
  const h = location.hash.slice(1);
  return h in VIEWS ? (h as ViewKey) : 'dashboard';
};

export function App() {
  const [authed, setAuthed] = useState(!!getToken());
  useEffect(() => setUnauthorizedHandler(() => setAuthed(false)), []);
  if (!authed) return <Login onDone={() => setAuthed(true)} />;
  return (
    <SettingsProvider
      fallback={(err) => (
        <div className="login"><div className="card">{err ? <p className="field-error">{err}</p> : <p className="hint">Loading settings…</p>}</div></div>
      )}
    >
      <Shell onSignOut={() => { setToken(null); setAuthed(false); }} />
    </SettingsProvider>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api<{ token: string }>('POST', '/api/auth/login', { password });
      setToken(r.token);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <h1>Timesheet Reminder</h1>
        <p className="hint">Sign in as administrator to manage settings.</p>
        <div className="field">
          <label htmlFor="pw">Admin password</label>
          <input id="pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
        </div>
        {error && <p className="field-error">{error}</p>}
        <button className="btn primary" disabled={busy || !password}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}

function Shell({ onSignOut }: { onSignOut: () => void }) {
  const [view, setView] = useState<ViewKey>(currentView);
  const { draft, update, dirty, save, saving, discard, saveError, tests } = useSettings();
  const [toast, setToast] = useState('');

  useEffect(() => {
    const on = () => { setView(currentView()); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 3800);
    return () => clearTimeout(t);
  }, [toast]);

  const onSave = async () => {
    if (await save()) setToast('Settings saved.');
  };

  const Page = VIEWS[view].Page;
  const enabled = draft.sources.filter((s) => s.enabled);
  const connected = enabled.filter((s) => tests[`source.${s.type}`]?.ok).length;
  let group = '';

  return (
    <>
      <header className="top">
        <div className="brand">
          <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true"><rect x="1" y="1" width="24" height="24" rx="6" fill="var(--accent)" /><rect x="5" y="14" width="2.6" height="7" rx="1" fill="var(--on-accent)" /><rect x="8.8" y="10" width="2.6" height="11" rx="1" fill="var(--on-accent)" /><rect x="12.6" y="7" width="2.6" height="14" rx="1" fill="var(--on-accent)" /><rect x="16.4" y="12" width="2.6" height="9" rx="1" fill="var(--on-accent)" /></svg>
          <b>Timesheet Reminder</b>
        </div>
        <Switch label="Dry run" checked={draft.dryRun} onChange={(v) => update((s) => { s.dryRun = v; })} />
        <div className="savebar">
          {dirty && <span className="dirty">Unsaved changes</span>}
          <button className="btn ghost" onClick={discard} disabled={!dirty || saving}>Discard</button>
          <button className="btn primary" onClick={onSave} disabled={!dirty || saving}>{saving ? 'Saving…' : 'Save settings'}</button>
          <button className="btn ghost" onClick={onSignOut}>Sign out</button>
        </div>
      </header>
      <div className="app">
        <nav aria-label="Sections">
          {(Object.keys(VIEWS) as ViewKey[]).map((k) => {
            const v = VIEWS[k];
            const label = v.group !== group ? (group = v.group) : null;
            return (
              <span key={k} style={{ display: 'contents' }}>
                {label && <div className="nav-label">{label}</div>}
                <a href={`#${k}`} aria-current={k === view ? 'page' : undefined}>
                  <span>{v.label}</span>
                  {k === 'sources' && <span className="count">{connected}/{enabled.length}</span>}
                </a>
              </span>
            );
          })}
        </nav>
        <main>
          {saveError && <div className="notice bad"><div>{saveError}</div></div>}
          <Page />
        </main>
      </div>
      <div className="toast" role="status" aria-live="polite" hidden={!toast}>{toast}</div>
    </>
  );
}
