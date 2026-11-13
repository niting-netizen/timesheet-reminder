import type { EmailProviderConfig } from '../../../shared/settings';
import { useSettings } from '../lib/settings-context';
import { Input, PageHead, SecretInput, Select, StatusChip, TestPanel } from '../components/ui';

const OPTIONS: [EmailProviderConfig['type'], string, string][] = [
  ['gmail', 'Gmail API', 'Google Workspace mailbox. Recommended for this company.'],
  ['graph', 'Microsoft Graph', 'Microsoft 365 mailbox.'],
  ['smtp', 'SMTP', 'Any approved SMTP relay.'],
];

export function Provider() {
  const { draft, update, tests } = useSettings();
  const e = draft.emailProvider;
  const set = (fn: (ep: EmailProviderConfig) => void) => update((s) => fn(s.emailProvider));

  return (
    <>
      <PageHead title="Email provider" sub="Choose how reminder emails are sent and who they come from." />
      <section className="card">
        <h2>Provider</h2>
        <div className="seg" role="radiogroup" aria-label="Email provider">
          {OPTIONS.map(([v, title, desc]) => (
            <label key={v} htmlFor={`prov-${v}`}>
              <input type="radio" id={`prov-${v}`} name="prov" checked={e.type === v} onChange={() => set((ep) => { ep.type = v; })} />
              <span><b>{title}</b><small>{desc}</small></span>
            </label>
          ))}
        </div>
      </section>
      <div className="grid2">
        <section className="card">
          <h2>Sender</h2>
          <div className="fields">
            <Input label="From address" path="emailProvider.from" type="email" value={e.from} placeholder="timesheet@yourcompany.com"
              help="This mailbox must be allowed to send through the provider above." onChange={(v) => set((ep) => { ep.from = v; })} />
            <Input label="From name" path="emailProvider.fromName" value={e.fromName} onChange={(v) => set((ep) => { ep.fromName = v; })} />
            <Input label="Reply-to (optional)" path="emailProvider.replyTo" type="email" value={e.replyTo} placeholder="hr-ops@yourcompany.com"
              onChange={(v) => set((ep) => { ep.replyTo = v; })} />
          </div>
        </section>
        <section className="card">
          <div className="card-head"><h2>Credentials</h2><StatusChip result={tests.email} /></div>
          <div className="fields">
            {e.type === 'gmail' && (
              <>
                <Input label="OAuth client ID" path="emailProvider.gmail.clientId" value={e.gmail.clientId}
                  placeholder="1234567890-abc.apps.googleusercontent.com" onChange={(v) => set((ep) => { ep.gmail.clientId = v; })} />
                <SecretInput label="OAuth client secret" secretRef="email.gmail.clientSecret" placeholder="Paste the client secret" />
                <SecretInput label="Refresh token" secretRef="email.gmail.refreshToken" placeholder="From authorising the sender mailbox"
                  help="Needs the https://www.googleapis.com/auth/gmail.send scope." />
              </>
            )}
            {e.type === 'graph' && (
              <>
                <Input label="Directory (tenant) ID" path="emailProvider.graph.tenantId" value={e.graph.tenantId}
                  onChange={(v) => set((ep) => { ep.graph.tenantId = v; })} />
                <Input label="Application (client) ID" path="emailProvider.graph.clientId" value={e.graph.clientId}
                  onChange={(v) => set((ep) => { ep.graph.clientId = v; })} />
                <SecretInput label="Client secret" secretRef="email.graph.clientSecret" placeholder="Paste the client secret"
                  help="The app needs the Mail.Send application permission." />
              </>
            )}
            {e.type === 'smtp' && (
              <>
                <div className="fields cols">
                  <Input label="SMTP host" path="emailProvider.smtp.host" value={e.smtp.host} onChange={(v) => set((ep) => { ep.smtp.host = v; })} />
                  <Input label="Port" path="emailProvider.smtp.port" type="number" min={1} max={65535} value={e.smtp.port}
                    onChange={(v) => set((ep) => { ep.smtp.port = Number(v) || 0; })} />
                  <Select label="Security" path="emailProvider.smtp.security" value={e.smtp.security}
                    options={[['starttls', 'STARTTLS'], ['ssl', 'SSL/TLS'], ['none', 'None']] as const}
                    onChange={(v) => set((ep) => { ep.smtp.security = v; })} />
                </div>
                <Input label="Username" path="emailProvider.smtp.user" value={e.smtp.user} onChange={(v) => set((ep) => { ep.smtp.user = v; })} />
                <SecretInput label="Password or app password" secretRef="email.smtp.password" placeholder="Paste the password" />
              </>
            )}
          </div>
          <TestPanel target="email" call={e.type === 'smtp' ? 'SMTP sign-in (no mail sent)' : e.type === 'gmail' ? 'Google token refresh (no mail sent)' : 'Microsoft token request (no mail sent)'} />
        </section>
      </div>
    </>
  );
}
