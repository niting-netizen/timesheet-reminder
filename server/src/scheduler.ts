/**
 * Fires reminder events at their configured day and time. It wakes once a minute, reads the
 * CURRENT settings (so a schedule change takes effect on the next tick with no restart —
 * spec §11 "hot reload"), and for any event due this minute runs a fresh timesheet check and
 * then sends it.
 *
 * Stop conditions (spec §8): paused, outside the allowed window, a non-working day, after the
 * cutoff, past maxReminders, or nobody pending — the first five are already encoded by
 * plannedSends(); "nobody pending" is applied here for the pending reports.
 */
import { DAYS, type Settings } from '../../shared/settings';
import { localDateIn, isoDate, plannedSends, weekdayIndex } from '../../shared/calc';
import { carriesPendingTable, pendingRows } from '../../shared/reminders';
import type { SettingsService } from './settings/service';
import type { RunService } from './runs/service';
import type { EmailService } from './email/service';

export interface SchedulerDeps {
  settings: SettingsService;
  runs: RunService;
  email: EmailService;
  now?: () => Date;
  log?: (msg: string, err?: unknown) => void;
}

/** Current wall-clock time 'HH:mm' in a timezone. */
export function localTimeIn(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('hour')}:${get('minute')}`;
}

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private starter: ReturnType<typeof setTimeout> | null = null;
  private busy = false;

  constructor(private d: SchedulerDeps) {}

  private now() {
    return (this.d.now ?? (() => new Date()))();
  }
  private log(msg: string, err?: unknown) {
    (this.d.log ?? ((m: string, e?: unknown) => e !== undefined && console.error(m, e)))(msg, err);
  }

  /** Begin waking at the top of each minute. */
  start() {
    const msToNextMinute = 60_000 - (this.now().getTime() % 60_000);
    this.starter = setTimeout(() => {
      void this.safeTick();
      this.timer = setInterval(() => void this.safeTick(), 60_000);
    }, msToNextMinute);
  }

  stop() {
    if (this.starter) clearTimeout(this.starter);
    if (this.timer) clearInterval(this.timer);
    this.starter = this.timer = null;
  }

  private async safeTick() {
    if (this.busy) return; // a long check must not overlap the next minute
    this.busy = true;
    try {
      await this.tick();
    } catch (e) {
      this.log('scheduler tick failed', e);
    } finally {
      this.busy = false;
    }
  }

  /** Evaluate the current minute and send anything due. Exposed for tests. */
  async tick(): Promise<void> {
    const { settings } = this.d.settings.current();
    if (settings.schedule.paused) return;

    const now = this.now();
    const local = localDateIn(now, settings.week.timezone);
    const today = DAYS[weekdayIndex(local)]!;
    const time = localTimeIn(now, settings.week.timezone);

    const due = plannedSends(settings).filter((p) => !p.skipReason && p.day === today && p.time === time);
    if (!due.length) return;

    const weekOf = isoDate(local);
    // Refresh timesheet data before deciding who is pending and what to send.
    try {
      await this.d.runs.run({ weekOf, trigger: 'scheduled', actor: 'scheduler' });
    } catch (e) {
      this.log('scheduled check failed; skipping this minute', e);
      return;
    }

    for (const p of due) {
      if (carriesPendingTable(p.eventId) && pendingRows(this.d.runs.week(weekOf)).length === 0) {
        this.log(`skip ${p.eventId} #${p.reportNumber ?? 1}: nobody pending`);
        continue;
      }
      try {
        const r = await this.d.email.sendEvent({ eventId: p.eventId, weekOf, cycleNo: p.reportNumber ?? 1, trigger: 'scheduled', actor: 'scheduler' });
        this.log(`sent ${p.eventId} #${r.cycleNo}: ${r.sent} sent, ${r.dryRunCount} dry-run, ${r.skipped} skipped, ${r.failed} failed`);
      } catch (e) {
        this.log(`send ${p.eventId} failed`, e);
      }
    }
  }
}

/** True when the given settings schedule anything at all (used to decide whether to start). */
export function scheduleIsActive(settings: Settings): boolean {
  return !settings.schedule.paused && plannedSends(settings).some((p) => !p.skipReason);
}
