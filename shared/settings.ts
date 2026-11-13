/**
 * Settings model shared by the API and the dashboard.
 * Secrets (API keys, passwords, tokens) are NOT part of this model: they are
 * stored encrypted on the server and addressed by a SecretRef.
 */
import { z } from 'zod';

export const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;
export type Weekday = (typeof DAYS)[number];
export const DAY_LABEL: Record<Weekday, string> = {
  MON: 'Monday', TUE: 'Tuesday', WED: 'Wednesday', THU: 'Thursday', FRI: 'Friday', SAT: 'Saturday', SUN: 'Sunday',
};

export const SOURCE_TYPES = ['jira', 'redmine', 'pulse', 'texpert'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];
export const SOURCE_NAME: Record<SourceType, string> = { jira: 'Jira', redmine: 'Redmine', pulse: 'Pulse', texpert: 'Texpert' };

export const RECIPIENT_MODES = ['broadcast', 'individual', 'custom'] as const;
export type RecipientMode = (typeof RECIPIENT_MODES)[number];

export const EVENT_IDS = ['R1', 'R2', 'R3', 'REPEAT'] as const;
export type EventId = (typeof EVENT_IDS)[number];
export const TEMPLATE_IDS = ['R1', 'R2', 'R3', 'REPEAT', 'INDIVIDUAL'] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

export const SECRET_REFS = [
  'source.jira.apiKey',
  'source.redmine.apiKey',
  'source.pulse.apiKey',
  'source.texpert.apiKey',
  'email.gmail.clientSecret',
  'email.gmail.refreshToken',
  'email.graph.clientSecret',
  'email.smtp.password',
  'ai.groq.apiKey',
] as const;
export type SecretRef = (typeof SECRET_REFS)[number];
export const sourceSecretRef = (t: SourceType): SecretRef => `source.${t}.apiKey` as SecretRef;

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour time, for example 13:00');
const email = z.string().trim().toLowerCase().email('Enter a valid email address');
const optionalEmail = z.union([z.literal(''), email]);
const url = z
  .string()
  .trim()
  .refine((v) => v === '' || /^https?:\/\/[^\s/]+/i.test(v), 'Enter a full URL starting with https://');

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const SourceConfigSchema = z.object({
  type: z.enum(SOURCE_TYPES),
  enabled: z.boolean(),
  /** jira_cloud = email + API token; jira_dc = personal access token; api_key = Redmine key;
   *  api / db_view / csv_import = Pulse or Texpert access method (to be confirmed). */
  authType: z.enum(['jira_cloud', 'jira_dc', 'api_key', 'api', 'db_view', 'csv_import']),
  baseUrl: url,
  username: z.string().trim().max(200),
  /** Pulse/Texpert API only: a read-only path the owner confirms for connection tests. */
  testPath: z.string().trim().max(300).refine((v) => v === '' || v.startsWith('/'), 'Path must start with /'),
  /** Pulse/Texpert API only: header that carries the key. "Authorization" sends "Bearer <key>". */
  authHeader: z.string().trim().max(100).regex(/^[A-Za-z0-9-]*$/, 'Use letters, digits and dashes only'),
});
export type SourceConfig = z.infer<typeof SourceConfigSchema>;

export const EmailProviderSchema = z.object({
  type: z.enum(['gmail', 'graph', 'smtp']),
  from: email,
  fromName: z.string().trim().min(1, 'Enter a sender name').max(100),
  replyTo: optionalEmail,
  gmail: z.object({ clientId: z.string().trim().max(300) }),
  graph: z.object({ tenantId: z.string().trim().max(100), clientId: z.string().trim().max(100) }),
  smtp: z.object({
    host: z.string().trim().max(255),
    port: z.number().int().min(1).max(65535),
    security: z.enum(['starttls', 'ssl', 'none']),
    user: z.string().trim().max(255),
  }),
});
export type EmailProviderConfig = z.infer<typeof EmailProviderSchema>;

export const ScheduleEventSchema = z.object({
  id: z.enum(EVENT_IDS),
  label: z.string().trim().min(1).max(80),
  enabled: z.boolean(),
  day: z.enum(DAYS),
  time,
  intervalHours: z.number().min(0.5).max(6),
  mode: z.enum(RECIPIENT_MODES),
});
export type ScheduleEvent = z.infer<typeof ScheduleEventSchema>;

export const TemplateSchema = z.object({
  subject: z.string().trim().min(1, 'Subject is required').max(300),
  body: z.string().min(1, 'Body is required').max(20000),
});

export const SettingsSchema = z
  .object({
    sources: z.array(SourceConfigSchema).length(SOURCE_TYPES.length),
    emailProvider: EmailProviderSchema,
    recipients: z.object({
      broadcastList: z.array(email).max(50),
      customList: z.array(email).max(200),
      cc: z.array(email).max(20),
    }),
    week: z.object({
      startDay: z.enum(DAYS),
      endDay: z.enum(DAYS),
      weeklyHours: z.number().min(1).max(80),
      dailyOverride: z.number().min(0).max(24),
      timezone: z.string().refine(isValidTimezone, 'Unknown timezone'),
    }),
    schedule: z.object({
      events: z.array(ScheduleEventSchema).length(EVENT_IDS.length),
      cutoff: time,
      windowFrom: time,
      windowTo: time,
      maxReminders: z.number().int().min(1).max(12),
      paused: z.boolean(),
    }),
    templates: z.object({
      R1: TemplateSchema, R2: TemplateSchema, R3: TemplateSchema, REPEAT: TemplateSchema, INDIVIDUAL: TemplateSchema,
    }),
    tickets: z.object({
      leave: z.string().trim().max(100),
      holiday: z.string().trim().max(100),
      bench: z.string().trim().max(100),
    }),
    signature: z.object({
      name: z.string().trim().max(100),
      title: z.string().trim().max(100),
      addresses: z.string().trim().max(2000),
    }),
    ai: z.object({ enabled: z.boolean(), model: z.string().trim().min(1).max(100) }),
    dryRun: z.boolean(),
  })
  .superRefine((s, ctx) => {
    if (DAYS.indexOf(s.week.endDay) < DAYS.indexOf(s.week.startDay)) {
      ctx.addIssue({ code: 'custom', path: ['week', 'endDay'], message: 'The week must end on or after the day it starts' });
    }
    if (s.schedule.windowFrom >= s.schedule.windowTo) {
      ctx.addIssue({ code: 'custom', path: ['schedule', 'windowTo'], message: 'Allowed hours must end after they start' });
    }
    // Recipient lists are only required once emails can really go out, so an admin can
    // save source keys and other settings on a fresh install before lists are known.
    const live = !s.dryRun && !s.schedule.paused;
    s.schedule.events.forEach((e, i) => {
      if (e.id !== EVENT_IDS[i]) ctx.addIssue({ code: 'custom', path: ['schedule', 'events', i, 'id'], message: 'Events are out of order' });
      if (!e.enabled || !live) return;
      if (e.mode === 'custom' && s.recipients.customList.length === 0) {
        ctx.addIssue({ code: 'custom', path: ['recipients', 'customList'], message: `${e.label} uses the custom list, which is empty` });
      }
      if (e.mode === 'broadcast' && s.recipients.broadcastList.length === 0) {
        ctx.addIssue({ code: 'custom', path: ['recipients', 'broadcastList'], message: `${e.label} uses the broadcast list, which is empty` });
      }
    });
    s.sources.forEach((src, i) => {
      if (src.type !== SOURCE_TYPES[i]) ctx.addIssue({ code: 'custom', path: ['sources', i, 'type'], message: 'Sources are out of order' });
    });
  });
export type Settings = z.infer<typeof SettingsSchema>;

/* ---------- API contracts ---------- */

export interface TestResult {
  ok: boolean;
  message: string;
  latencyMs: number;
  testedAt: string;
  testedBy?: string;
}

export interface SecretStatus {
  set: boolean;
  updatedAt?: string;
}

export interface SettingsResponse {
  version: number;
  updatedAt: string;
  updatedBy: string;
  settings: Settings;
  secrets: Record<SecretRef, SecretStatus>;
  tests: Partial<Record<TestTarget, TestResult>>;
}

export interface SaveSettingsRequest {
  version: number;
  settings: Settings;
  /** New secret values. Omitted or empty = keep the stored value. */
  secrets?: Partial<Record<SecretRef, string>>;
  clearSecrets?: SecretRef[];
}

export type TestTarget = `source.${SourceType}` | 'email' | 'ai';

export interface FieldError {
  path: string;
  message: string;
}

export const AI_ASSIST_KINDS = ['polish', 'shorten', 'firm', 'friendly'] as const;
export type AiAssistKind = (typeof AI_ASSIST_KINDS)[number];

/* ---------- timesheet checks ---------- */

/** unmapped = active employee with no account in any enabled source. not_checked = no run yet this week. */
export type EmployeeStatus = 'complete' | 'pending' | 'source_missing' | 'unmapped' | 'not_checked';

export interface SourceRunResult {
  source: SourceType;
  status: 'ok' | 'failed' | 'not_received';
  origin: 'api' | 'import';
  message: string;
  worklogs: number;
}

export interface UnmappedAccount {
  source: SourceType;
  externalUserId: string;
  authorName: string;
  seconds: number;
}

export interface CheckRun {
  id: number;
  weekStart: string;
  weekEnd: string;
  trigger: 'manual' | 'scheduled';
  status: 'running' | 'success' | 'partial' | 'failed';
  startedAt: string;
  completedAt: string | null;
  actor: string;
  sources: SourceRunResult[];
  unmapped: UnmappedAccount[];
  counts: { employees: number; complete: number; pending: number; sourceMissing: number; unmapped: number };
  error?: string;
}

export interface TimesheetRow {
  employeeId: number;
  employeeCode: string;
  name: string;
  email: string;
  team: string;
  sources: SourceType[];
  loggedSeconds: number;
  targetSeconds: number;
  pendingSeconds: number;
  completionPct: number;
  status: EmployeeStatus;
  bySource: Partial<Record<SourceType, number>>;
  daysOff: number;
  checkedAt: string | null;
}

export interface WeekTimesheets {
  weekStart: string;
  weekEnd: string;
  isoWeek: number;
  run: CheckRun | null;
  rows: TimesheetRow[];
}

export interface Adjustment {
  id: number;
  /** null = applies to everyone (public holiday) */
  employeeId: number | null;
  employeeName: string | null;
  date: string;
  kind: 'leave' | 'holiday';
  /** null = full day */
  hours: number | null;
  approved: boolean;
  note: string;
}

export interface Employee {
  id: number;
  employeeCode: string;
  name: string;
  email: string;
  team: string;
  active: boolean;
  accounts: Partial<Record<SourceType, string>>;
}
