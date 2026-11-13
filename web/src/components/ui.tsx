import { useId, useState, type ReactNode } from 'react';
import type { SecretRef, TestResult, TestTarget } from '../../../shared/settings';
import { useSettings } from '../lib/settings-context';

export const fmtWhen = (iso?: string) =>
  iso ? new Date(iso).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit' }) : '';

export function Field(props: { label: string; error?: string; help?: ReactNode; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className={`field${props.error ? ' has-error' : ''}`}>
      <label htmlFor={id}>{props.label}</label>
      {props.children(id)}
      {props.error ? <p className="field-error">{props.error}</p> : props.help ? <p className="help">{props.help}</p> : null}
    </div>
  );
}

/** Text/number/email input bound to a settings path. */
export function Input(props: {
  label: string;
  path: string;
  value: string | number;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  help?: ReactNode;
  disabled?: boolean;
  min?: number;
  max?: number;
  step?: number;
}) {
  const { errors } = useSettings();
  return (
    <Field label={props.label} error={errors.get(props.path)} help={props.help}>
      {(id) => (
        <input
          id={id}
          type={props.type ?? 'text'}
          value={props.value}
          placeholder={props.placeholder}
          disabled={props.disabled}
          min={props.min}
          max={props.max}
          step={props.step}
          autoComplete="off"
          onChange={(e) => props.onChange(e.target.value)}
        />
      )}
    </Field>
  );
}

export function Select<T extends string>(props: {
  label: string;
  path: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (v: T) => void;
  help?: ReactNode;
  disabled?: boolean;
}) {
  const { errors } = useSettings();
  return (
    <Field label={props.label} error={errors.get(props.path)} help={props.help}>
      {(id) => (
        <select id={id} value={props.value} disabled={props.disabled} onChange={(e) => props.onChange(e.target.value as T)}>
          {props.options.map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
      )}
    </Field>
  );
}

/** One address per line, stored as a string[]. Keeps the raw text while typing. */
export function ListInput(props: { label: string; path: string; value: string[]; onChange: (v: string[]) => void; help?: ReactNode; rows?: number; placeholder?: string }) {
  const { errors } = useSettings();
  const [text, setText] = useState(props.value.join('\n'));
  const parsed = text.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  // The list changed from outside (discard or save): show the stored list again.
  if (parsed.join('\n') !== props.value.join('\n')) setText(props.value.join('\n'));
  const err = [...errors.entries()].find(([k]) => k === props.path || k.startsWith(props.path + '.'))?.[1];
  return (
    <Field label={props.label} error={err} help={props.help}>
      {(id) => (
        <textarea
          id={id}
          className="code"
          rows={props.rows ?? 3}
          spellCheck={false}
          placeholder={props.placeholder}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            props.onChange(e.target.value.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean));
          }}
        />
      )}
    </Field>
  );
}

export function Switch(props: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  const id = useId();
  return (
    <label className="switch" htmlFor={id}>
      <input id={id} type="checkbox" checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} /> {props.label}
    </label>
  );
}

/** Write-only secret field: shows whether a value is stored, never the value itself. */
export function SecretInput(props: { label: string; secretRef: SecretRef; placeholder?: string; disabled?: boolean; help?: ReactNode }) {
  const { data, secretDraft, setSecret, clearSecret, pendingClear } = useSettings();
  const [show, setShow] = useState(false);
  const stored = data.secrets[props.secretRef];
  const clearing = pendingClear.has(props.secretRef);
  const typed = secretDraft(props.secretRef);
  return (
    <Field label={props.label} help={props.help}>
      {(id) => (
        <>
          <div className="secret">
            <input
              id={id}
              type={show ? 'text' : 'password'}
              autoComplete="new-password"
              spellCheck={false}
              disabled={props.disabled}
              value={typed}
              placeholder={stored.set && !clearing ? '•••••••• saved. Type to replace' : props.placeholder}
              onChange={(e) => setSecret(props.secretRef, e.target.value)}
            />
            <button type="button" className="btn ghost sm" onClick={() => setShow(!show)} disabled={!typed}>
              {show ? 'Hide' : 'Show'}
            </button>
          </div>
          <div className="secret-status">
            {clearing ? (
              <span className="chip warn">Will be removed when you save</span>
            ) : typed ? (
              <span className="chip info">New value, not saved yet</span>
            ) : stored.set ? (
              <span className="chip ok">Saved {fmtWhen(stored.updatedAt)}</span>
            ) : (
              <span className="chip idle">Not set</span>
            )}
            {stored.set && !clearing && (
              <button type="button" className="btn ghost sm" onClick={() => clearSecret(props.secretRef)}>Remove</button>
            )}
          </div>
        </>
      )}
    </Field>
  );
}

export function StatusChip({ result, enabled = true }: { result?: TestResult; enabled?: boolean }) {
  if (!enabled) return <span className="chip idle">Turned off</span>;
  if (!result) return <span className="chip idle">Not tested</span>;
  return result.ok ? <span className="chip ok">Connected</span> : <span className="chip bad">Connection failed</span>;
}

export function TestPanel({ target, disabled, call }: { target: TestTarget; disabled?: boolean; call: string }) {
  const { test, tests, testing } = useSettings();
  const r = tests[target];
  const busy = testing.has(target);
  return (
    <>
      <div className="inline">
        <button type="button" className="btn" onClick={() => test(target)} disabled={disabled || busy} aria-busy={busy}>
          {busy ? 'Testing…' : 'Test connection'}
        </button>
      </div>
      <div className="test-out" aria-live="polite">
        {r ? (
          <>
            <span className={r.ok ? 'ok' : 'bad'}>{r.ok ? '✓ ' : '✗ '}{r.message}</span>
            <span className="mono">{fmtWhen(r.testedAt)}{r.latencyMs ? ` · ${r.latencyMs} ms` : ''}</span>
          </>
        ) : (
          <span className="chip idle">Not tested yet</span>
        )}
      </div>
      <p className="mono">Test call: {call}. Uses the values on screen, even before you save.</p>
    </>
  );
}

export function Notice({ kind, children }: { kind: 'info' | 'warn' | 'bad' | 'ok'; children: ReactNode }) {
  return <div className={`notice ${kind}`}><div>{children}</div></div>;
}

export function PageHead({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <p className="sub">{sub}</p>}
      </div>
      {children}
    </div>
  );
}
