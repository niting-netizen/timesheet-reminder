import { z } from 'zod';
import {
  SECRET_REFS,
  SettingsSchema,
  type SaveSettingsRequest,
  type Settings,
  type SettingsResponse,
  type TestResult,
  type TestTarget,
} from '../../../shared/settings';
import { defaultSettings, mergeWithDefaults } from '../../../shared/defaults';
import { nowIso, tx, type Db } from '../db';
import { conflict, fromZod } from '../errors';
import type { SecretStore } from './secrets';

const SaveRequestSchema = z.object({
  version: z.number().int().min(0),
  settings: z.unknown(),
  secrets: z.record(z.enum(SECRET_REFS), z.string().max(8000)).optional(),
  clearSecrets: z.array(z.enum(SECRET_REFS)).optional(),
});

interface Row { version: number; json: string; updated_at: string; updated_by: string }

export class SettingsService {
  constructor(
    private db: Db,
    private secrets: SecretStore,
  ) {}

  /** Current settings. Stored JSON is merged over defaults so new fields always have values. */
  current(): { version: number; settings: Settings; updatedAt: string; updatedBy: string } {
    const row = this.db.prepare('SELECT version, json, updated_at, updated_by FROM settings WHERE id = 1').get() as Row | undefined;
    if (!row) return { version: 0, settings: defaultSettings(), updatedAt: '', updatedBy: '' };
    const parsed = SettingsSchema.safeParse(mergeWithDefaults(JSON.parse(row.json)));
    return {
      version: row.version,
      settings: parsed.success ? parsed.data : defaultSettings(),
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
    };
  }

  response(): SettingsResponse {
    const c = this.current();
    return { ...c, secrets: this.secrets.status(), tests: this.latestTests() };
  }

  save(body: unknown, actor: string): SettingsResponse {
    const req = SaveRequestSchema.parse(body) as SaveSettingsRequest;
    const parsed = SettingsSchema.safeParse(req.settings);
    if (!parsed.success) throw fromZod(parsed.error);
    const settings = parsed.data;

    tx(this.db, () => {
      const cur = this.current();
      if (req.version !== cur.version) {
        throw conflict('Someone else saved settings after you opened this page. Reload to see their changes, then apply yours again.');
      }
      const changed = changedSections(cur.settings, settings);
      const now = nowIso();
      this.db
        .prepare(
          `INSERT INTO settings (id, version, json, updated_at, updated_by) VALUES (1, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET version = excluded.version, json = excluded.json,
             updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        )
        .run(cur.version + 1, JSON.stringify(settings), now, actor);

      const secretChanges: string[] = [];
      for (const [ref, value] of Object.entries(req.secrets ?? {})) {
        if (value && value.trim()) {
          this.secrets.set(ref as (typeof SECRET_REFS)[number], value.trim(), actor);
          secretChanges.push(`${ref} replaced`);
        }
      }
      for (const ref of req.clearSecrets ?? []) {
        this.secrets.clear(ref);
        secretChanges.push(`${ref} cleared`);
      }
      // Never log secret values: only which refs changed.
      this.audit(actor, 'settings.save', [...changed.map((c) => `${c} changed`), ...secretChanges].join('; ') || 'no changes');
    });
    return this.response();
  }

  recordTest(target: TestTarget, result: Omit<TestResult, 'testedAt'>, actor: string): TestResult {
    const testedAt = nowIso();
    this.db
      .prepare('INSERT INTO connection_tests (target, ok, latency_ms, message, tested_at, tested_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(target, result.ok ? 1 : 0, result.latencyMs, result.message, testedAt, actor);
    return { ...result, testedAt, testedBy: actor };
  }

  testHistory(target: string, limit = 20): TestResult[] {
    const rows = this.db
      .prepare('SELECT ok, latency_ms, message, tested_at, tested_by FROM connection_tests WHERE target = ? ORDER BY id DESC LIMIT ?')
      .all(target, limit) as { ok: number; latency_ms: number; message: string; tested_at: string; tested_by: string }[];
    return rows.map((r) => ({ ok: !!r.ok, latencyMs: r.latency_ms, message: r.message, testedAt: r.tested_at, testedBy: r.tested_by }));
  }

  audit(actor: string, action: string, detail: string) {
    this.db.prepare('INSERT INTO audit_log (actor, action, detail, at) VALUES (?, ?, ?, ?)').run(actor, action, detail, nowIso());
  }

  auditLog(limit = 100) {
    return this.db.prepare('SELECT actor, action, detail, at FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
  }

  private latestTests(): SettingsResponse['tests'] {
    const rows = this.db
      .prepare(
        `SELECT t.target, t.ok, t.latency_ms, t.message, t.tested_at, t.tested_by FROM connection_tests t
         JOIN (SELECT target, MAX(id) AS id FROM connection_tests GROUP BY target) m ON m.id = t.id`,
      )
      .all() as { target: TestTarget; ok: number; latency_ms: number; message: string; tested_at: string; tested_by: string }[];
    return Object.fromEntries(
      rows.map((r) => [r.target, { ok: !!r.ok, latencyMs: r.latency_ms, message: r.message, testedAt: r.tested_at, testedBy: r.tested_by }]),
    );
  }
}

function changedSections(a: Settings, b: Settings): string[] {
  return (Object.keys(b) as (keyof Settings)[]).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}
