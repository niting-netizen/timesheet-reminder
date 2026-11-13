/** Template placeholder filling, shared by the preview (web) and the sender (server). */

export const PLACEHOLDERS = {
  general: ['week_start', 'week_end', 'applications', 'daily_hours', 'weekly_hours', 'leave_ticket', 'public_holiday_ticket', 'bench_ticket', 'sender_name', 'sender_title', 'office_addresses'],
  pending: ['pending_table', 'pending_count', 'report_number', 'next_run_time', 'source_notes', 'applications', 'week_start', 'week_end', 'sender_name'],
  individual: ['employee_name', 'week_number', 'week_start', 'week_end', 'required', 'logged', 'pending'],
} as const;

export const KNOWN_PLACEHOLDERS = new Set<string>([
  ...PLACEHOLDERS.general, ...PLACEHOLDERS.pending, ...PLACEHOLDERS.individual, 'week_number',
]);

export type TemplateContext = Record<string, string | number>;

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function placeholdersIn(text: string): string[] {
  return [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!))];
}

export function unknownPlaceholders(text: string): string[] {
  return placeholdersIn(text).filter((p) => !KNOWN_PLACEHOLDERS.has(p));
}

/** Plain-text fill, used for subjects. Unknown placeholders are left as typed. */
export function fillText(text: string, ctx: TemplateContext): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k === 'pending_table' ? '' : k in ctx ? String(ctx[k]) : m));
}

/**
 * HTML fill for email bodies. Template text and values are escaped; only `pending_table`
 * (built by `pendingTableHtml`) is inserted as HTML. Newlines become <br>.
 */
export function fillHtml(text: string, ctx: TemplateContext, opts: { markUnknown?: boolean } = {}): string {
  return escapeHtml(text)
    .replace(/\{(\w+)\}/g, (m, k: string) => {
      if (!(k in ctx)) return opts.markUnknown ? `<mark class="unknown">${m}</mark>` : m;
      return k === 'pending_table' ? String(ctx[k]) : escapeHtml(String(ctx[k]));
    })
    .replace(/\n/g, '<br>');
}

export interface PendingRow { code: string; name: string; filled: string; required: string; pending: string }

export function pendingTableHtml(rows: PendingRow[]): string {
  const cell = 'border:1px solid #cfd6df;padding:5px 10px;';
  const head = ['EMP ID', 'Employee', 'Filled', 'Required', 'Pending']
    .map((h) => `<th style="${cell}background:#eef1f5;text-align:left">${h}</th>`)
    .join('');
  const body = rows.length
    ? rows
        .map(
          (r) =>
            `<tr><td style="${cell}">${escapeHtml(r.code)}</td><td style="${cell}">${escapeHtml(r.name)}</td>` +
            `<td style="${cell}">${escapeHtml(r.filled)}</td><td style="${cell}">${escapeHtml(r.required)}</td>` +
            `<td style="${cell}color:#c22a2a;font-weight:700">${escapeHtml(r.pending)}</td></tr>`,
        )
        .join('')
    : `<tr><td style="${cell}" colspan="5">Nobody is pending.</td></tr>`;
  return `<table style="border-collapse:collapse;margin:6px 0"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}
