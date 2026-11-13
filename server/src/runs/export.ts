/**
 * Weekly report CSV in the company's existing layout:
 *   EMP ID, EMP Name, Filled Hours, Need to fill hours, Pending hours
 * Hours have one decimal. Pending is shown as Filled − Need (negative while hours are
 * missing, 0.0 once the target is met), matching the manual report.
 */
import type { EmployeeStatus, WeekTimesheets } from '../../../shared/settings';
import { REPORT_COLUMNS } from './imports';

const NOT_JUDGED: Partial<Record<EmployeeStatus, string>> = {
  source_missing: 'Source data missing',
  unmapped: 'No source account',
  not_checked: 'Not checked',
};

const hours1 = (seconds: number) => {
  const v = (seconds / 3600).toFixed(1);
  return v === '-0.0' ? '0.0' : v;
};

/** Quote when needed, and stop spreadsheet formula injection from names like "=cmd()". */
export function csvCell(v: string): string {
  const safe = /^[=+\-@\t\r]/.test(v) && !/^-?\d+(\.\d+)?$/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function weeklyReportCsv(w: WeekTimesheets): string {
  const lines = [REPORT_COLUMNS.join(',')];
  for (const r of w.rows) {
    const note = NOT_JUDGED[r.status];
    lines.push(
      [
        r.employeeCode,
        r.name,
        r.status === 'not_checked' ? '' : hours1(r.loggedSeconds),
        hours1(r.targetSeconds),
        note ?? hours1(-r.pendingSeconds),
      ]
        .map(csvCell)
        .join(','),
    );
  }
  // BOM so Excel opens UTF-8 names correctly; CRLF line endings for Excel on Windows.
  return '﻿' + lines.join('\r\n') + '\r\n';
}
