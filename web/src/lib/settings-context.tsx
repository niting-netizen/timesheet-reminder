import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type {
  EmailProviderConfig, SecretRef, Settings, SettingsResponse, SourceType, TestResult, TestTarget,
} from '../../../shared/settings';
import { sourceSecretRef } from '../../../shared/settings';
import { api, ApiError } from './api';

interface Ctx {
  data: SettingsResponse;
  draft: Settings;
  update: (fn: (s: Settings) => void) => void;
  dirty: boolean;
  secretDraft: (ref: SecretRef) => string;
  setSecret: (ref: SecretRef, value: string) => void;
  clearSecret: (ref: SecretRef) => void;
  pendingClear: Set<SecretRef>;
  errors: Map<string, string>;
  saving: boolean;
  save: () => Promise<boolean>;
  discard: () => void;
  test: (target: TestTarget) => Promise<TestResult>;
  testing: Set<TestTarget>;
  tests: SettingsResponse['tests'];
  saveError: string | null;
}

const SettingsCtx = createContext<Ctx | null>(null);

export function useSettings(): Ctx {
  const c = useContext(SettingsCtx);
  if (!c) throw new Error('useSettings outside SettingsProvider');
  return c;
}

export function SettingsProvider({ children, fallback }: { children: ReactNode; fallback: (error: string | null) => ReactNode }) {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [secrets, setSecrets] = useState<Partial<Record<SecretRef, string>>>({});
  const [pendingClear, setPendingClear] = useState<Set<SecretRef>>(new Set());
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [tests, setTests] = useState<SettingsResponse['tests']>({});
  const [testing, setTesting] = useState<Set<TestTarget>>(new Set());

  const apply = useCallback((r: SettingsResponse) => {
    setData(r);
    setDraft(structuredClone(r.settings));
    setTests(r.tests);
    setSecrets({});
    setPendingClear(new Set());
    setErrors(new Map());
    setSaveError(null);
  }, []);

  useEffect(() => {
    api<SettingsResponse>('GET', '/api/settings').then(apply, (e: Error) => setLoadError(e.message));
  }, [apply]);

  const update = useCallback((fn: (s: Settings) => void) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const next = structuredClone(prev);
      fn(next);
      return next;
    });
  }, []);

  const dirty = useMemo(
    () => !!data && !!draft && (JSON.stringify(data.settings) !== JSON.stringify(draft) || Object.values(secrets).some(Boolean) || pendingClear.size > 0),
    [data, draft, secrets, pendingClear],
  );

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  if (!data || !draft) return <>{fallback(loadError)}</>;

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const r = await api<SettingsResponse>('PUT', '/api/settings', {
        version: data.version,
        settings: draft,
        secrets: Object.fromEntries(Object.entries(secrets).filter(([, v]) => v)),
        clearSecrets: [...pendingClear],
      });
      apply(r);
      return true;
    } catch (e) {
      const err = e as ApiError;
      setSaveError(err.message);
      setErrors(new Map(err.fieldErrors.map((f) => [f.path, f.message])));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const test = async (target: TestTarget): Promise<TestResult> => {
    setTesting((s) => new Set(s).add(target));
    try {
      let r: TestResult;
      if (target.startsWith('source.')) {
        const type = target.slice(7) as SourceType;
        const source = draft.sources.find((s) => s.type === type)!;
        r = await api('POST', `/api/tests/source/${type}`, { source, apiKey: secrets[sourceSecretRef(type)] || undefined });
      } else if (target === 'email') {
        r = await api('POST', '/api/tests/email', {
          emailProvider: draft.emailProvider satisfies EmailProviderConfig,
          secrets: {
            gmailClientSecret: secrets['email.gmail.clientSecret'] || undefined,
            gmailRefreshToken: secrets['email.gmail.refreshToken'] || undefined,
            graphClientSecret: secrets['email.graph.clientSecret'] || undefined,
            smtpPassword: secrets['email.smtp.password'] || undefined,
          },
        });
      } else {
        r = await api('POST', '/api/tests/ai', { model: draft.ai.model, apiKey: secrets['ai.groq.apiKey'] || undefined });
      }
      setTests((t) => ({ ...t, [target]: r }));
      return r;
    } catch (e) {
      const r: TestResult = { ok: false, message: (e as Error).message, latencyMs: 0, testedAt: new Date().toISOString() };
      setTests((t) => ({ ...t, [target]: r }));
      return r;
    } finally {
      setTesting((s) => {
        const n = new Set(s);
        n.delete(target);
        return n;
      });
    }
  };

  const value: Ctx = {
    data, draft, update, dirty, errors, saving, save, saveError, tests, testing, test, pendingClear,
    discard: () => apply(data),
    secretDraft: (ref) => secrets[ref] ?? '',
    setSecret: (ref, v) => {
      setSecrets((s) => ({ ...s, [ref]: v }));
      setPendingClear((p) => {
        const n = new Set(p);
        n.delete(ref);
        return n;
      });
    },
    clearSecret: (ref) => {
      setSecrets((s) => ({ ...s, [ref]: '' }));
      setPendingClear((p) => new Set(p).add(ref));
    },
  };
  return <SettingsCtx.Provider value={value}>{children}</SettingsCtx.Provider>;
}
