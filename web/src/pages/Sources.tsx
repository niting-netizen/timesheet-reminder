import { SOURCE_NAME, sourceSecretRef, type SourceConfig } from '../../../shared/settings';
import { useSettings } from '../lib/settings-context';
import { Input, Notice, PageHead, SecretInput, Select, StatusChip, Switch, TestPanel } from '../components/ui';

const HINT: Record<SourceConfig['type'], string> = {
  jira: 'Use a read-only service account.',
  redmine: 'REST API must be enabled in Redmine administration.',
  pulse: 'Internal app. Confirm the access method with the Pulse owner.',
  texpert: 'Planned. Connect later through an API or a file import.',
};

const METHODS: Record<SourceConfig['type'], readonly (readonly [SourceConfig['authType'], string])[]> = {
  jira: [['jira_cloud', 'Jira Cloud (email + API token)'], ['jira_dc', 'Jira Data Center / Server (personal access token)']],
  redmine: [['api_key', 'REST API key']],
  pulse: [['api', 'API'], ['db_view', 'Read-only database view'], ['csv_import', 'CSV / Excel export']],
  texpert: [['api', 'API'], ['csv_import', 'CSV / Excel import']],
};

export function Sources() {
  const { draft } = useSettings();
  return (
    <>
      <PageHead title="Sources & API keys" sub="Connect each timesheet application with a read-only service account, then test the connection." />
      <Notice kind="info">
        Keys are encrypted on the server when you save, and are never shown again. To replace one, type the new value.
        Test connection uses what is on screen, so you can test before saving.
      </Notice>
      <div className="grid2">
        {draft.sources.map((s, i) => <SourceCard key={s.type} src={s} index={i} />)}
      </div>
    </>
  );
}

function SourceCard({ src, index }: { src: SourceConfig; index: number }) {
  const { update, tests } = useSettings();
  const p = `sources.${index}`;
  const set = <K extends keyof SourceConfig>(k: K, v: SourceConfig[K]) => update((s) => { s.sources[index]![k] = v; });
  const off = !src.enabled;
  const isJira = src.type === 'jira';
  const method = src.authType;

  let call = '';
  if (method === 'jira_cloud') call = 'GET /rest/api/3/myself';
  else if (method === 'jira_dc') call = 'GET /rest/api/2/myself';
  else if (method === 'api_key') call = 'GET /users/current.json';
  else if (method === 'api') call = src.testPath ? `GET ${src.testPath}` : 'the test path you enter';
  else if (method === 'csv_import') call = 'none (file import)';
  else call = 'not available yet';

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>{SOURCE_NAME[src.type]}</h2>
          <p className="hint">{HINT[src.type]}</p>
        </div>
        <Switch label="Enabled" checked={src.enabled} onChange={(v) => set('enabled', v)} />
      </div>
      <div><StatusChip result={tests[`source.${src.type}`]} enabled={src.enabled} /></div>

      {METHODS[src.type].length > 1 && (
        <Select label="Access method" path={`${p}.authType`} value={method} options={METHODS[src.type]} disabled={off} onChange={(v) => set('authType', v)} />
      )}

      {method === 'csv_import' && <p className="help">Weekly exports are imported as files. Column mapping is set up in the import phase.</p>}
      {method === 'db_view' && <Notice kind="warn">Database view access is not built yet. Confirm this method with the source owner first.</Notice>}

      {(method === 'jira_cloud' || method === 'jira_dc' || method === 'api_key' || method === 'api') && (
        <div className="fields">
          <Input label="Base URL" path={`${p}.baseUrl`} type="url" value={src.baseUrl} disabled={off}
            placeholder={isJira ? 'https://yourcompany.atlassian.net' : `https://${src.type}.yourcompany.com`}
            onChange={(v) => set('baseUrl', v)} />
          {method === 'jira_cloud' && (
            <Input label="Service account email" path={`${p}.username`} type="email" value={src.username} disabled={off}
              placeholder="svc-timesheet@yourcompany.com" onChange={(v) => set('username', v)} />
          )}
          {method === 'api' && (
            <div className="fields cols">
              <Input label="Test path" path={`${p}.testPath`} value={src.testPath} disabled={off} placeholder="/api/me"
                help="A read-only endpoint the owner confirms." onChange={(v) => set('testPath', v)} />
              <Input label="Key header" path={`${p}.authHeader`} value={src.authHeader} disabled={off} placeholder="Authorization"
                help={'"Authorization" sends Bearer <key>.'} onChange={(v) => set('authHeader', v)} />
            </div>
          )}
          <SecretInput
            label={method === 'jira_cloud' ? 'API token' : method === 'jira_dc' ? 'Personal access token' : method === 'api_key' ? 'API key' : 'API key or token'}
            secretRef={sourceSecretRef(src.type)} disabled={off} placeholder="Paste the key" />
        </div>
      )}
      <TestPanel target={`source.${src.type}`} disabled={off} call={call} />
    </section>
  );
}
