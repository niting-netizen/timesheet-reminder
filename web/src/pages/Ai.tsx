import { useSettings } from '../lib/settings-context';
import { PageHead, SecretInput, Select, StatusChip, Switch, TestPanel } from '../components/ui';

// Groq's catalogue changes; Test connection reports if the chosen model is no longer offered.
const MODELS = [
  ['openai/gpt-oss-120b', 'openai/gpt-oss-120b (best quality)'],
  ['openai/gpt-oss-20b', 'openai/gpt-oss-20b (faster)'],
  ['qwen/qwen3.8-27b', 'qwen/qwen3.8-27b'],
] as const;

export function Ai() {
  const { draft, update, tests } = useSettings();
  const a = draft.ai;
  const known = MODELS.some(([m]) => m === a.model);
  return (
    <>
      <PageHead title="AI assist (Groq)" sub="Optional help with wording email templates. It never decides hours, statuses or recipients." />
      <div className="grid2">
        <section className="card">
          <div className="card-head">
            <h2>Connection</h2>
            <Switch label="Enable AI assist" checked={a.enabled} onChange={(v) => update((s) => { s.ai.enabled = v; })} />
          </div>
          <div><StatusChip result={tests.ai} /></div>
          <div className="fields">
            <SecretInput label="Groq API key" secretRef="ai.groq.apiKey" placeholder="gsk_…" />
            <Select label="Model" path="ai.model" value={a.model}
              options={known ? MODELS : [...MODELS, [a.model, a.model] as const]}
              onChange={(v) => update((s) => { s.ai.model = v; })} />
          </div>
          <TestPanel target="ai" call="GET https://api.groq.com/openai/v1/models" />
        </section>
        <section className="card">
          <h2>What AI assist does</h2>
          <div className="fields" style={{ gap: 8 }}>
            <p><b>Used for:</b> polishing, shortening or changing the tone of template text.</p>
            <p><b>Never used for:</b> calculating hours, deciding who is pending, or choosing recipients.</p>
            <p><b>Data sent:</b> the template text only, with placeholders such as {'{employee_name}'} left as-is. No employee data.</p>
            <p><b>Safety check:</b> a suggestion that adds, drops or changes a placeholder is discarded automatically.</p>
            <p><b>If Groq is down:</b> template editing keeps working. Only the assist buttons stop.</p>
          </div>
        </section>
      </div>
    </>
  );
}
