import type { Settings, TemplateId } from './settings';

const GENERAL = `Hi Team,

This is a gentle reminder to review and complete your {applications} timesheet from {week_start} to {week_end}.

Note: If you are going on leave or have planned leave, please update your timesheet in advance before going on leave.

Managers and Team Leads, it is your responsibility to ensure that resources submit their timesheets on time.

Please ensure the following while updating your logs:
• Log a minimum of {daily_hours} hours per working day, or more if you have worked additional hours.
• If you have taken leave, log the leave hours against {leave_ticket}.
• Public holiday hours must be logged against {public_holiday_ticket}.
• Verify that all hours are tagged to the correct {applications} tickets.
• If there is no project work assigned, log your hours under {bench_ticket}.
• Do not log hours under any Miscellaneous or Common ticket if you are actively working on a project; log them against the relevant project tickets only.

100% of employee work logs must be updated accurately by the end of the day to avoid any discrepancies.

Best Regards,
{sender_name}
{sender_title}
Iksula Services Pvt Ltd
{office_addresses}`;

const PENDING = `Hi Team,

Please see the list below of employees who are pending to fill their {applications} hours. Pending hours are highlighted in red.

A total of {pending_count} employees are still pending. Please update it soon; the next updated pending list will be shared after {next_run_time}.

Note: {source_notes}

{pending_table}

Best Regards,
{sender_name}`;

const INDIVIDUAL = `Hi {employee_name},

Our system shows the following status for your timesheet for Week {week_number} ({week_start} to {week_end}):
• Required hours: {required}
• Hours logged: {logged}
• Pending hours: {pending}

Please update your remaining hours at the earliest. Reminders stop automatically once your logged hours reach the required hours.

Regards,
Timesheet Automation System`;

export const DEFAULT_TEMPLATES: Settings['templates'] = {
  R1: { subject: 'Timesheet Reminder: {week_start} to {week_end}', body: GENERAL },
  R2: {
    subject: 'Timesheet Reminder (last day): {week_start} to {week_end}',
    body: GENERAL.replace(
      '{week_end}.\n',
      '{week_end}.\n\nToday is the last working day of the week, so please complete your hours before you log off.\n',
    ),
  },
  R3: { subject: 'Timesheet Pending List #{report_number}: {pending_count} employees pending', body: PENDING },
  REPEAT: {
    subject: 'Timesheet Pending List #{report_number} (updated): {pending_count} employees pending',
    body: PENDING.replace('Please see the list below', 'Here is the updated list'),
  },
  INDIVIDUAL: { subject: 'Action needed: complete your timesheet for {week_start} to {week_end}', body: INDIVIDUAL },
};

export function defaultTemplate(id: TemplateId) {
  return { ...DEFAULT_TEMPLATES[id] };
}

export function defaultSettings(): Settings {
  return {
    sources: [
      { type: 'jira', enabled: true, authType: 'jira_cloud', baseUrl: '', username: '', testPath: '', authHeader: 'Authorization' },
      { type: 'redmine', enabled: true, authType: 'api_key', baseUrl: '', username: '', testPath: '', authHeader: 'Authorization' },
      { type: 'pulse', enabled: true, authType: 'api', baseUrl: '', username: '', testPath: '', authHeader: 'Authorization' },
      { type: 'texpert', enabled: false, authType: 'csv_import', baseUrl: '', username: '', testPath: '', authHeader: 'Authorization' },
    ],
    emailProvider: {
      type: 'gmail',
      from: 'timesheet@example.com',
      fromName: 'Timesheet Reminder',
      replyTo: '',
      gmail: { clientId: '' },
      graph: { tenantId: '', clientId: '' },
      smtp: { host: 'smtp-relay.gmail.com', port: 587, security: 'starttls', user: '' },
    },
    recipients: { broadcastList: [], customList: [], cc: [] },
    week: { startDay: 'MON', endDay: 'FRI', weeklyHours: 40, dailyOverride: 0, timezone: 'Asia/Kolkata' },
    schedule: {
      events: [
        { id: 'R1', label: 'Reminder 1 · general', enabled: true, day: 'THU', time: '11:00', intervalHours: 2, mode: 'broadcast' },
        { id: 'R2', label: 'Reminder 2 · general', enabled: true, day: 'FRI', time: '11:00', intervalHours: 2, mode: 'broadcast' },
        { id: 'R3', label: 'Reminder 3 · first pending report', enabled: true, day: 'FRI', time: '13:00', intervalHours: 2, mode: 'broadcast' },
        { id: 'REPEAT', label: 'Repeat pending report', enabled: true, day: 'FRI', time: '15:00', intervalHours: 2, mode: 'broadcast' },
      ],
      cutoff: '19:00',
      windowFrom: '09:00',
      windowTo: '20:00',
      maxReminders: 5,
      paused: false,
    },
    templates: structuredClone(DEFAULT_TEMPLATES),
    tickets: { leave: '', holiday: '', bench: '' },
    signature: { name: '', title: '', addresses: '' },
    ai: { enabled: false, model: 'openai/gpt-oss-120b' },
    dryRun: true,
  };
}

/** Deep-merge stored settings over defaults so new fields get default values. Arrays replace. */
export function mergeWithDefaults(stored: unknown): unknown {
  return merge(defaultSettings(), stored);
}

function merge(base: unknown, over: unknown): unknown {
  if (over === undefined) return base;
  if (Array.isArray(base) || Array.isArray(over)) {
    if (Array.isArray(base) && Array.isArray(over) && base.length === over.length) {
      return over.map((v, i) => merge(base[i], v));
    }
    return over;
  }
  if (isObj(base) && isObj(over)) {
    const out: Record<string, unknown> = { ...base };
    for (const k of Object.keys(over)) out[k] = k in base ? merge(base[k], over[k]) : over[k];
    return out;
  }
  return over;
}
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
