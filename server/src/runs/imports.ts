/**
 * Worklog file import for sources without a usable API yet (Pulse now, Texpert later).
 * A file covers an explicit period; importing replaces that source's imported worklogs
 * for the period, so re-importing a corrected file is safe.
 */
import { z } from 'zod';
import { SOURCE_TYPES, type SourceType } from '../../../shared/settings';
import { parseCsv } from '../employees/service';
import { nowIso, tx, type Db } from '../db';
import { AppError, badRequest, fromZod } from '../errors';

export const ImportRequest = z
  .object({
    source: z.enum(SOURCE_TYPES),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
    csv: z.string().min(1).max(10_000_000),
  })
  .refine((r) => r.from <= r.to, { message: 'The period must end on or after it starts', path: ['to'] });

/** The weekly report layout shared by export and import (normalised header names). */
export const TOTALS_HEADER = ['emp_id', 'emp_name', 'filled_hours'];
export const REPORT_COLUMNS = ['EMP ID', 'EMP Name', 'Filled Hours', 'Need to fill hours', 'Pending hours'];
/** Worklogs imported by company employee ID rather than a source account ID. */
export const EMP_PREFIX = 'emp:';

/** "27.8", "40", "32:30" (hh:mm) → seconds. */
export function parseHours(s: string): number | null {
  const t = s.trim();
  const hm = /^(\d{1,3}):([0-5]\d)$/.exec(t);
  if (hm) return Number(hm[1]) * 3600 + Number(hm[2]) * 60;
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  return Math.round(Number(t) * 3600);
}

/** Accepts 2026-11-10, 10/11/2026 and 10-11-2026 (day first, as used in India). */
export function normaliseDate(s: string): string | null {
  const t = s.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m) return `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`;
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(t);
  if (m) return `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  return null;
}

export class ImportService {
  constructor(private db: Db) {}

  importWorklogs(body: unknown, actor: string): { rows: number; seconds: number; from: string; to: string } {
    const parsed = ImportRequest.safeParse(body);
    if (!parsed.success) throw fromZod(parsed.error);
    const { source, from, to, csv } = parsed.data;

    const rows = parseCsv(csv.replace(/^﻿/, '').trim());
    const header = rows.shift()?.map((h) => h.trim().toLowerCase().replace(/[\s_]+/g, '_'));
    if (header && TOTALS_HEADER.every((h) => header.includes(h))) {
      return this.importTotals(source, from, to, header, rows, actor);
    }
    if (!header?.includes('user_id') || !header.includes('date') || !(header.includes('hours') || header.includes('seconds'))) {
      throw badRequest(
        'Unrecognised header. Use either the weekly report layout (EMP ID, EMP Name, Filled Hours, Need to fill hours, Pending hours) ' +
          'or daily worklogs (user_id, date, hours).',
      );
    }
    const col = (r: string[], name: string) => (header.includes(name) ? (r[header.indexOf(name)] ?? '').trim() : '');

    const errors: { path: string; message: string }[] = [];
    const items: { user: string; author: string; date: string; seconds: number; issue: string; project: string }[] = [];
    rows.forEach((r, i) => {
      if (r.every((c) => !c.trim())) return;
      const line = `line ${i + 2}`;
      const user = col(r, 'user_id');
      const date = normaliseDate(col(r, 'date'));
      const seconds = header.includes('seconds') && col(r, 'seconds') ? Number(col(r, 'seconds')) : Number(col(r, 'hours')) * 3600;
      if (!user) return void errors.push({ path: line, message: 'user_id is empty' });
      if (!date) return void errors.push({ path: line, message: `"${col(r, 'date')}" is not a date (use YYYY-MM-DD or DD/MM/YYYY)` });
      if (date < from || date > to) return void errors.push({ path: line, message: `${date} is outside the period ${from} to ${to}` });
      if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 24 * 3600) return void errors.push({ path: line, message: 'hours must be a number between 0 and 24' });
      items.push({ user, author: col(r, 'author_name'), date, seconds: Math.round(seconds), issue: col(r, 'issue_key'), project: col(r, 'project') });
    });
    if (errors.length) throw new AppError(400, `${errors.length} line(s) have problems. Nothing was imported.`, errors.slice(0, 50));
    if (!items.length) throw badRequest('The file has no worklog rows.');

    return tx(this.db, () => {
      const now = nowIso();
      const imp = this.db
        .prepare('INSERT INTO source_imports (source, from_date, to_date, rows, imported_at, imported_by) VALUES (?, ?, ?, ?, ?, ?)')
        .run(source, from, to, items.length, now, actor);
      this.db.prepare("DELETE FROM worklogs WHERE source = ? AND origin = 'import' AND work_date BETWEEN ? AND ?").run(source, from, to);
      const ins = this.db.prepare(
        `INSERT INTO worklogs (source, external_id, external_user_id, author_name, issue_key, project, work_date, seconds, origin, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'import', ?)`,
      );
      items.forEach((it, i) => ins.run(source, `import:${imp.lastInsertRowid}:${i}`, it.user, it.author, it.issue, it.project, it.date, it.seconds, now));
      return { rows: items.length, seconds: items.reduce((a, b) => a + b.seconds, 0), from, to };
    });
  }

  /**
   * Weekly report layout: one row per employee with their total for the period.
   * EMP ID is the company employee ID. Only Filled Hours is used; the app recalculates
   * "Need to fill" and "Pending" from the target, leave and holidays.
   */
  private importTotals(source: SourceType, from: string, to: string, header: string[], rows: string[][], actor: string) {
    const col = (r: string[], name: string) => (r[header.indexOf(name)] ?? '').trim();
    const errors: { path: string; message: string }[] = [];
    const items: { code: string; name: string; seconds: number }[] = [];
    const seen = new Set<string>();
    rows.forEach((r, i) => {
      if (r.every((c) => !c.trim())) return;
      const line = `line ${i + 2}`;
      const code = col(r, 'emp_id');
      const seconds = parseHours(col(r, 'filled_hours'));
      if (!code) return void errors.push({ path: line, message: 'EMP ID is empty' });
      if (seen.has(code)) return void errors.push({ path: line, message: `EMP ID ${code} appears more than once` });
      seen.add(code);
      if (seconds === null || seconds < 0 || seconds > 168 * 3600) {
        return void errors.push({ path: line, message: `Filled Hours "${col(r, 'filled_hours')}" must be a number between 0 and 168` });
      }
      items.push({ code, name: col(r, 'emp_name'), seconds });
    });
    if (errors.length) throw new AppError(400, `${errors.length} line(s) have problems. Nothing was imported.`, errors.slice(0, 50));
    if (!items.length) throw badRequest('The file has no employee rows.');

    return tx(this.db, () => {
      const now = nowIso();
      const imp = this.db
        .prepare('INSERT INTO source_imports (source, from_date, to_date, rows, imported_at, imported_by) VALUES (?, ?, ?, ?, ?, ?)')
        .run(source, from, to, items.length, now, actor);
      this.db.prepare("DELETE FROM worklogs WHERE source = ? AND origin = 'import' AND work_date BETWEEN ? AND ?").run(source, from, to);
      const ins = this.db.prepare(
        `INSERT INTO worklogs (source, external_id, external_user_id, author_name, issue_key, project, work_date, seconds, origin, fetched_at)
         VALUES (?, ?, ?, ?, 'Weekly total', '', ?, ?, 'import', ?)`,
      );
      // Totals are dated on the first day of the period. EMP ID rows are stored as "emp:<id>"
      // and matched to employees by their company employee ID.
      // Zero rows are kept: "0.0 filled" is a real answer, and it links the person to this source.
      items.forEach((it, i) => ins.run(source, `import:${imp.lastInsertRowid}:${i}`, `${EMP_PREFIX}${it.code}`, it.name, from, it.seconds, now));
      return { rows: items.length, seconds: items.reduce((a, b) => a + b.seconds, 0), from, to };
    });
  }

  /** Latest import that covers the whole range, if any. */
  coveringImport(source: SourceType, from: string, to: string): { imported_at: string; rows: number } | undefined {
    return this.db
      .prepare('SELECT imported_at, rows FROM source_imports WHERE source = ? AND from_date <= ? AND to_date >= ? ORDER BY id DESC LIMIT 1')
      .get(source, from, to) as { imported_at: string; rows: number } | undefined;
  }

  list(limit = 50) {
    return this.db
      .prepare('SELECT id, source, from_date AS "from", to_date AS "to", rows, imported_at AS importedAt, imported_by AS importedBy FROM source_imports ORDER BY id DESC LIMIT ?')
      .all(limit);
  }
}
