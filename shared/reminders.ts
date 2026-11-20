/**
 * Builds the actual emails a reminder event sends, in each recipient mode. Pure and shared
 * by the server (sender) and the web (preview), so what an admin previews is byte-for-byte
 * what goes out.
 *
 * Privacy (spec §6): in Individual mode each message is rendered from a SINGLE employee row,
 * so one person's hours can never leak into another person's email. This is enforced here,
 * not left to the template text.
 */
import type { EventId, RecipientMode, Settings, SourceType, TemplateId, WeekTimesheets, TimesheetRow } from './settings';
import { SOURCE_NAME } from './settings';
import { dailyTargetSeconds, formatDate, formatHours, parseIsoDate } from './calc';
import { fillHtml, fillText, pendingTableHtml, type PendingRow, type TemplateContext } from './templates';

export interface OutgoingMessage {
  mode: RecipientMode;
  to: string[];
  cc: string[];
  subject: string;
  html: string;
  /** Identifies the recipient for de-duplication: an employee email, or the list name. */
  dedupeRecipient: string;
  /** Set in Individual mode so the record can be tied back to the employee. */
  employeeId?: number;
}

/** R3 and the repeat report carry the pending table; R1/R2 are general reminders. */
export const carriesPendingTable = (id: EventId): boolean => id === 'R3' || id === 'REPEAT';

/** Which template an event uses in a given mode. Individual mode always uses INDIVIDUAL. */
export function templateFor(id: EventId, mode: RecipientMode): TemplateId {
  return mode === 'individual' ? 'INDIVIDUAL' : id;
}

const hrs = (seconds: number) => `${formatHours(seconds)} h`;

/** "Jira", "Jira and Redmine", "Jira, Redmine and Pulse". */
function joinAnd(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export function enabledApplications(settings: Settings): string {
  return joinAnd(settings.sources.filter((s) => s.enabled).map((s) => SOURCE_NAME[s.type as SourceType])) || 'timesheet';
}

/** Employees still pending this week (sources complete, hours short). */
export function pendingRows(week: WeekTimesheets): TimesheetRow[] {
  return week.rows.filter((r) => r.status === 'pending');
}

function sourceNotes(week: WeekTimesheets): string {
  const missing = (week.run?.sources ?? []).filter((s) => s.status !== 'ok').map((s) => SOURCE_NAME[s.source]);
  return missing.length
    ? `${joinAnd(missing)} data was incomplete for this check, so a few people may be missing from the list.`
    : 'All sources were read successfully for this check.';
}

/** Context common to every reminder for this week. */
function baseContext(settings: Settings, week: WeekTimesheets, extra: TemplateContext): TemplateContext {
  return {
    week_start: formatDate(parseIsoDate(week.weekStart)),
    week_end: formatDate(parseIsoDate(week.weekEnd)),
    week_number: week.isoWeek,
    weekly_hours: formatHours(settings.week.weeklyHours * 3600),
    daily_hours: formatHours(dailyTargetSeconds(settings.week)),
    applications: enabledApplications(settings),
    leave_ticket: settings.tickets.leave || '(leave ticket)',
    public_holiday_ticket: settings.tickets.holiday || '(public holiday ticket)',
    bench_ticket: settings.tickets.bench || '(bench ticket)',
    sender_name: settings.signature.name || 'Timesheet Automation',
    sender_title: settings.signature.title,
    office_addresses: settings.signature.addresses,
    source_notes: sourceNotes(week),
    ...extra,
  };
}

function render(settings: Settings, templateId: TemplateId, ctx: TemplateContext) {
  const t = settings.templates[templateId];
  return { subject: fillText(t.subject, ctx), html: fillHtml(t.body, ctx) };
}

export interface BuildOptions {
  settings: Settings;
  week: WeekTimesheets;
  eventId: EventId;
  /** 1 for R1/R2/R3; increments for each REPEAT. Used in subjects and de-duplication. */
  reportNumber: number;
  /** Human time of the next repeat, for {next_run_time}. */
  nextRunTime?: string;
}

/**
 * The messages this event would send right now. Broadcast and Custom each produce one message
 * to a list; Individual produces one message per pending employee who has an email.
 */
export function buildEventMessages(opts: BuildOptions): OutgoingMessage[] {
  const { settings, week, eventId, reportNumber } = opts;
  const event = settings.schedule.events.find((e) => e.id === eventId);
  const mode: RecipientMode = event?.mode ?? 'broadcast';
  const pending = pendingRows(week);

  const sharedCtx = baseContext(settings, week, {
    pending_count: pending.length,
    report_number: reportNumber,
    next_run_time: opts.nextRunTime ?? '',
  });

  if (mode === 'individual') {
    return pending
      .filter((r) => r.email)
      .map((r) => {
        const ctx: TemplateContext = {
          ...sharedCtx,
          employee_name: r.name,
          required: hrs(r.targetSeconds),
          logged: hrs(r.loggedSeconds),
          pending: hrs(r.pendingSeconds),
        };
        const { subject, html } = render(settings, 'INDIVIDUAL', ctx);
        return { mode, to: [r.email], cc: [], subject, html, dedupeRecipient: r.email, employeeId: r.employeeId };
      });
  }

  const table: PendingRow[] = pending.map((r) => ({
    code: r.employeeCode,
    name: r.name,
    filled: hrs(r.loggedSeconds),
    required: hrs(r.targetSeconds),
    pending: hrs(r.pendingSeconds),
  }));
  const ctx: TemplateContext = { ...sharedCtx, pending_table: carriesPendingTable(eventId) ? pendingTableHtml(table) : '' };
  const { subject, html } = render(settings, templateFor(eventId, mode), ctx);

  const to = mode === 'custom' ? settings.recipients.customList : settings.recipients.broadcastList;
  return [{ mode, to: [...to], cc: [...settings.recipients.cc], subject, html, dedupeRecipient: mode }];
}
