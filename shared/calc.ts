/**
 * Deterministic week and target-hours calculation.
 * All durations are integer seconds so totals never drift from floating-point rounding.
 */
import { DAYS, type Settings, type Weekday, type ScheduleEvent } from './settings';

export type WeekConfig = Settings['week'];
export const HOUR = 3600;

export function workingDays(week: Pick<WeekConfig, 'startDay' | 'endDay'>): Weekday[] {
  const s = DAYS.indexOf(week.startDay);
  const e = DAYS.indexOf(week.endDay);
  return e >= s ? DAYS.slice(s, e + 1) : [];
}

/** Daily target in seconds: the override if set, otherwise weekly hours spread over working days. */
export function dailyTargetSeconds(week: WeekConfig): number {
  if (week.dailyOverride > 0) return Math.round(week.dailyOverride * HOUR);
  const days = workingDays(week).length;
  return days ? Math.round((week.weeklyHours * HOUR) / days) : 0;
}

export interface Adjustments {
  /** Approved full days off: leave, or public holidays the company treats as non-working. */
  approvedDaysOff: number;
  /** Other approved reductions, in seconds (for example a half-day). */
  otherSeconds?: number;
}

export function targetSeconds(week: WeekConfig, adj: Adjustments = { approvedDaysOff: 0 }): number {
  const base = Math.round(week.weeklyHours * HOUR);
  const off = adj.approvedDaysOff * dailyTargetSeconds(week) + (adj.otherSeconds ?? 0);
  return Math.max(0, base - off);
}

export type TimesheetStatus = 'complete' | 'pending' | 'source_missing';

export interface Evaluation {
  loggedSeconds: number;
  targetSeconds: number;
  pendingSeconds: number;
  completionPct: number;
  status: TimesheetStatus;
}

/**
 * Never marks someone complete or pending when one of their sources did not return data.
 */
export function evaluate(input: { loggedSeconds: number; targetSeconds: number; sourcesComplete: boolean }): Evaluation {
  const { loggedSeconds, targetSeconds } = input;
  const pendingSeconds = Math.max(0, targetSeconds - loggedSeconds);
  const completionPct = targetSeconds === 0 ? 100 : Math.min(100, Math.round((loggedSeconds / targetSeconds) * 1000) / 10);
  const status: TimesheetStatus = !input.sourcesComplete ? 'source_missing' : pendingSeconds === 0 ? 'complete' : 'pending';
  return { loggedSeconds, targetSeconds, pendingSeconds, completionPct, status };
}

/** Hours for display: at most two decimals, trailing zeros dropped (33.8, 40, 6.25). */
export function formatHours(seconds: number): string {
  return String(Math.round((seconds / HOUR) * 100) / 100);
}

/* ---------- dates in the company timezone ---------- */

export interface LocalDate { year: number; month: number; day: number } // month 1-12

/** The calendar date of an instant as seen in a timezone. */
export function localDateIn(instant: Date, timeZone: string): LocalDate {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

const toUtc = (d: LocalDate) => Date.UTC(d.year, d.month - 1, d.day);
const fromUtc = (ms: number): LocalDate => {
  const x = new Date(ms);
  return { year: x.getUTCFullYear(), month: x.getUTCMonth() + 1, day: x.getUTCDate() };
};
export const isoDate = (d: LocalDate) =>
  `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;

/** Monday = 0 … Sunday = 6 */
export function weekdayIndex(d: LocalDate): number {
  return (new Date(toUtc(d)).getUTCDay() + 6) % 7;
}

export function isoWeekNumber(d: LocalDate): number {
  const ms = toUtc(d);
  const thursday = ms + (3 - weekdayIndex(d)) * 86400000;
  const yearStart = Date.UTC(new Date(thursday).getUTCFullYear(), 0, 1);
  return Math.floor((thursday - yearStart) / 86400000 / 7) + 1;
}

export interface WeekWindow {
  start: LocalDate;
  end: LocalDate;
  isoWeek: number;
  days: number;
}

/** The configured working week that contains `instant`, in the company timezone. */
export function weekWindow(week: WeekConfig, instant: Date): WeekWindow {
  const today = localDateIn(instant, week.timezone);
  const monday = toUtc(today) - weekdayIndex(today) * 86400000;
  const start = fromUtc(monday + DAYS.indexOf(week.startDay) * 86400000);
  const end = fromUtc(monday + Math.max(DAYS.indexOf(week.endDay), DAYS.indexOf(week.startDay)) * 86400000);
  return { start, end, isoWeek: isoWeekNumber(start), days: workingDays(week).length };
}

/** Parse 'YYYY-MM-DD'. */
export function parseIsoDate(s: string): LocalDate {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error(`Not a date: ${s}`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}
export const addDaysIso = (s: string, n: number) => isoDate(fromUtc(toUtc(parseIsoDate(s)) + n * 86400000));

/** The configured working week containing the calendar date `iso` (company calendar). */
export function weekWindowFor(week: WeekConfig, iso: string): WeekWindow {
  const d = parseIsoDate(iso);
  const monday = toUtc(d) - weekdayIndex(d) * 86400000;
  const start = fromUtc(monday + DAYS.indexOf(week.startDay) * 86400000);
  const end = fromUtc(monday + Math.max(DAYS.indexOf(week.endDay), DAYS.indexOf(week.startDay)) * 86400000);
  return { start, end, isoWeek: isoWeekNumber(start), days: workingDays(week).length };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const formatDate = (d: LocalDate) => `${String(d.day).padStart(2, '0')} ${MONTHS[d.month - 1]} ${d.year}`;

/* ---------- schedule ---------- */

export const toMinutes = (t: string) => {
  const m = /^(\d{2}):(\d{2})$/.exec(t);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};
export const fromMinutes = (n: number) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
export function to12h(t: string): string {
  const n = toMinutes(t);
  if (Number.isNaN(n)) return t;
  const h = Math.floor(n / 60);
  return `${h % 12 || 12}:${String(n % 60).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

export interface PlannedSend {
  eventId: ScheduleEvent['id'];
  day: Weekday;
  time: string;
  reportNumber?: number;
  mode: ScheduleEvent['mode'];
  skipReason?: 'not_working_day' | 'outside_window';
}

/** Every send the schedule would make in one week (before stop-when-nobody-pending). */
export function plannedSends(settings: Pick<Settings, 'schedule' | 'week'>): PlannedSend[] {
  const { schedule, week } = settings;
  const [r1, r2, r3, rep] = schedule.events as [ScheduleEvent, ScheduleEvent, ScheduleEvent, ScheduleEvent];
  const days = new Set(workingDays(week));
  const from = toMinutes(schedule.windowFrom);
  const to = toMinutes(schedule.windowTo);
  const skip = (day: Weekday, t: string): PlannedSend['skipReason'] => {
    if (!days.has(day)) return 'not_working_day';
    const m = toMinutes(t);
    return m < from || m > to ? 'outside_window' : undefined;
  };
  const out: PlannedSend[] = [];
  for (const e of [r1, r2]) if (e.enabled) out.push({ eventId: e.id, day: e.day, time: e.time, mode: e.mode, skipReason: skip(e.day, e.time) });
  if (r3.enabled) {
    let n = 1;
    out.push({ eventId: 'R3', day: r3.day, time: r3.time, reportNumber: n, mode: r3.mode, skipReason: skip(r3.day, r3.time) });
    if (rep.enabled) {
      const step = Math.round(rep.intervalHours * 60);
      for (let t = toMinutes(r3.time) + step; t <= toMinutes(schedule.cutoff) && t < 24 * 60 && n < schedule.maxReminders; t += step) {
        n++;
        const time = fromMinutes(t);
        out.push({ eventId: 'REPEAT', day: r3.day, time, reportNumber: n, mode: rep.mode, skipReason: skip(r3.day, time) });
      }
    }
  }
  return out.sort((a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day) || toMinutes(a.time) - toMinutes(b.time));
}
