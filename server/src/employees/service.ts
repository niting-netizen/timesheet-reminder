import { z } from 'zod';
import { SOURCE_TYPES, type Employee, type SourceType } from '../../../shared/settings';
import { nowIso, tx, type Db } from '../db';
import { AppError, badRequest, fromZod, notFound } from '../errors';

export const EmployeeInput = z.object({
  employeeCode: z.string().trim().min(1, 'Employee ID is required').max(40),
  name: z.string().trim().min(1, 'Name is required').max(120),
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  team: z.string().trim().max(80).default(''),
  active: z.boolean().default(true),
  accounts: z.record(z.enum(SOURCE_TYPES), z.string().trim().max(200)).default({}),
});
export type EmployeeInput = z.infer<typeof EmployeeInput>;

interface Row { id: number; employee_code: string; name: string; email: string; team: string; active: number }

export class EmployeeService {
  constructor(private db: Db) {}

  list(): Employee[] {
    const rows = this.db.prepare('SELECT id, employee_code, name, email, team, active FROM employees ORDER BY name').all() as unknown as Row[];
    const accts = this.db.prepare('SELECT employee_id, source, external_user_id FROM source_accounts').all() as {
      employee_id: number; source: SourceType; external_user_id: string;
    }[];
    const byEmp = new Map<number, Employee['accounts']>();
    for (const a of accts) byEmp.set(a.employee_id, { ...byEmp.get(a.employee_id), [a.source]: a.external_user_id });
    return rows.map((r) => ({
      id: r.id, employeeCode: r.employee_code, name: r.name, email: r.email, team: r.team, active: !!r.active, accounts: byEmp.get(r.id) ?? {},
    }));
  }

  /** Create, or update the employee with the same employee ID. */
  upsert(body: unknown): Employee {
    const parsed = EmployeeInput.safeParse(body);
    if (!parsed.success) throw fromZod(parsed.error);
    const id = tx(this.db, () => this.write(parsed.data));
    return this.get(id);
  }

  update(id: number, body: unknown): Employee {
    const parsed = EmployeeInput.safeParse(body);
    if (!parsed.success) throw fromZod(parsed.error);
    this.get(id);
    tx(this.db, () => {
      const clash = this.db.prepare('SELECT id FROM employees WHERE employee_code = ? AND id <> ?').get(parsed.data.employeeCode, id);
      if (clash) throw badRequest(`Another employee already has ID ${parsed.data.employeeCode}.`);
      this.db
        .prepare('UPDATE employees SET employee_code = ?, name = ?, email = ?, team = ?, active = ?, updated_at = ? WHERE id = ?')
        .run(parsed.data.employeeCode, parsed.data.name, parsed.data.email, parsed.data.team, parsed.data.active ? 1 : 0, nowIso(), id);
      this.writeAccounts(id, parsed.data.accounts);
    });
    return this.get(id);
  }

  remove(id: number) {
    const r = this.db.prepare('DELETE FROM employees WHERE id = ?').run(id);
    if (!r.changes) throw notFound('That employee no longer exists.');
  }

  get(id: number): Employee {
    const e = this.list().find((x) => x.id === id);
    if (!e) throw notFound('That employee no longer exists.');
    return e;
  }

  /**
   * CSV columns: employee_code,name,email,team,active,jira,redmine,pulse,texpert
   * Validates every row first; imports nothing if any row is invalid.
   */
  importCsv(csv: string): { created: number; updated: number } {
    const rows = parseCsv(csv.trim());
    const header = rows.shift()?.map((h) => h.trim().toLowerCase());
    if (!header || !header.includes('employee_code') || !header.includes('email')) {
      throw badRequest('The first line must be a header with at least employee_code, name and email.');
    }
    const col = (r: string[], name: string) => (header.indexOf(name) >= 0 ? (r[header.indexOf(name)] ?? '').trim() : '');
    const inputs: EmployeeInput[] = [];
    const errors: { path: string; message: string }[] = [];
    rows.forEach((r, i) => {
      if (r.every((c) => !c.trim())) return;
      const accounts = Object.fromEntries(SOURCE_TYPES.map((s) => [s, col(r, s)]).filter(([, v]) => v));
      const activeRaw = col(r, 'active').toLowerCase();
      const res = EmployeeInput.safeParse({
        employeeCode: col(r, 'employee_code'), name: col(r, 'name'), email: col(r, 'email'), team: col(r, 'team'),
        active: !['false', 'no', '0', 'inactive'].includes(activeRaw), accounts,
      });
      if (res.success) inputs.push(res.data);
      else errors.push({ path: `line ${i + 2}`, message: res.error.issues[0]?.message ?? 'Invalid row' });
    });
    if (errors.length) throw new AppError(400, `${errors.length} line(s) have problems. Nothing was imported.`, errors);
    let created = 0;
    let updated = 0;
    tx(this.db, () => {
      for (const input of inputs) {
        const exists = this.db.prepare('SELECT 1 FROM employees WHERE employee_code = ?').get(input.employeeCode);
        this.write(input);
        if (exists) updated++;
        else created++;
      }
    });
    return { created, updated };
  }

  private write(e: EmployeeInput): number {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO employees (employee_code, name, email, team, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (employee_code) DO UPDATE SET name = excluded.name, email = excluded.email, team = excluded.team,
           active = excluded.active, updated_at = excluded.updated_at`,
      )
      .run(e.employeeCode, e.name, e.email, e.team, e.active ? 1 : 0, now, now);
    const { id } = this.db.prepare('SELECT id FROM employees WHERE employee_code = ?').get(e.employeeCode) as { id: number };
    this.writeAccounts(id, e.accounts);
    return id;
  }

  private writeAccounts(id: number, accounts: Partial<Record<SourceType, string>>) {
    this.db.prepare('DELETE FROM source_accounts WHERE employee_id = ?').run(id);
    for (const [source, ext] of Object.entries(accounts)) {
      if (!ext) continue;
      const taken = this.db
        .prepare('SELECT e.name FROM source_accounts a JOIN employees e ON e.id = a.employee_id WHERE a.source = ? AND a.external_user_id = ?')
        .get(source, ext) as { name: string } | undefined;
      if (taken) throw badRequest(`The ${source} account ${ext} is already mapped to ${taken.name}.`);
      this.db.prepare('INSERT INTO source_accounts (employee_id, source, external_user_id) VALUES (?, ?, ?)').run(id, source, ext);
    }
  }
}

/** RFC 4180-style CSV: quoted fields, doubled quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  row.push(field);
  rows.push(row);
  return rows;
}
