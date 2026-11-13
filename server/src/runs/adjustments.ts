/**
 * Approved leave and public holidays. Only APPROVED entries reduce a target; leave is never
 * inferred from messages or tickets.
 */
import { z } from 'zod';
import type { Adjustment } from '../../../shared/settings';
import { nowIso, type Db } from '../db';
import { badRequest, fromZod, notFound } from '../errors';

const Input = z
  .object({
    employeeId: z.number().int().positive().nullable(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
    kind: z.enum(['leave', 'holiday']),
    hours: z.number().positive().max(24).nullable(),
    approved: z.boolean(),
    note: z.string().trim().max(300).default(''),
  })
  .refine((a) => a.kind === 'holiday' || a.employeeId !== null, { message: 'Leave must be for a specific employee', path: ['employeeId'] });

interface Row { id: number; employee_id: number | null; name: string | null; date: string; kind: 'leave' | 'holiday'; hours: number | null; approved: number; note: string }

export class AdjustmentService {
  constructor(private db: Db) {}

  list(from?: string, to?: string): Adjustment[] {
    const rows = this.db
      .prepare(
        `SELECT a.id, a.employee_id, e.name, a.date, a.kind, a.hours, a.approved, a.note
         FROM calendar_adjustments a LEFT JOIN employees e ON e.id = a.employee_id
         WHERE a.date BETWEEN ? AND ? ORDER BY a.date DESC, a.id DESC`,
      )
      .all(from ?? '0000-01-01', to ?? '9999-12-31') as unknown as Row[];
    return rows.map((r) => ({
      id: r.id, employeeId: r.employee_id, employeeName: r.name, date: r.date, kind: r.kind, hours: r.hours, approved: !!r.approved, note: r.note,
    }));
  }

  create(body: unknown, actor: string): Adjustment {
    const p = Input.safeParse(body);
    if (!p.success) throw fromZod(p.error);
    const a = p.data;
    if (a.employeeId !== null && !this.db.prepare('SELECT 1 FROM employees WHERE id = ?').get(a.employeeId)) {
      throw badRequest('That employee does not exist.');
    }
    const r = this.db
      .prepare('INSERT INTO calendar_adjustments (employee_id, date, kind, hours, approved, note, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(a.employeeId, a.date, a.kind, a.hours, a.approved ? 1 : 0, a.note, nowIso(), actor);
    return this.list().find((x) => x.id === Number(r.lastInsertRowid))!;
  }

  remove(id: number) {
    if (!this.db.prepare('DELETE FROM calendar_adjustments WHERE id = ?').run(id).changes) throw notFound('That entry no longer exists.');
  }

  /**
   * Approved days off for one employee in [from, to], counting only working days.
   * A holiday and a leave on the same day count once. Partial days become seconds.
   */
  daysOff(employeeId: number, from: string, to: string, isWorkingDay: (iso: string) => boolean): { fullDays: number; partialSeconds: number } {
    const rows = this.db
      .prepare(
        `SELECT date, hours FROM calendar_adjustments
         WHERE approved = 1 AND date BETWEEN ? AND ? AND (employee_id = ? OR (employee_id IS NULL AND kind = 'holiday'))`,
      )
      .all(from, to, employeeId) as { date: string; hours: number | null }[];
    const full = new Set<string>();
    const partial = new Map<string, number>();
    for (const r of rows) {
      if (!isWorkingDay(r.date)) continue;
      if (r.hours === null) full.add(r.date);
      else partial.set(r.date, Math.max(partial.get(r.date) ?? 0, r.hours));
    }
    let partialSeconds = 0;
    for (const [d, h] of partial) if (!full.has(d)) partialSeconds += Math.round(h * 3600);
    return { fullDays: full.size, partialSeconds };
  }
}
