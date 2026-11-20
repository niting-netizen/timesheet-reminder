/**
 * Sends reminder emails and records every send (real, dry-run, test or failed) in email_messages.
 *
 * Dry-run (spec): when settings.dryRun is on, nothing is actually delivered; each message that
 * WOULD go out is recorded with status 'dry_run' so an admin can review it safely.
 *
 * De-duplication (spec §6): a reminder is identified by (week_start, event_id, cycle_no, recipient).
 * If a 'sent' or 'dry_run' row already exists for that key, the send is skipped. This makes a
 * scheduled run idempotent across restarts and across ticks in the same minute.
 */
import {
  type EmailMessage, type EmailStatus, type EventId, type SendSummary, type Settings,
} from '../../../shared/settings';
import { buildEventMessages, type OutgoingMessage } from '../../../shared/reminders';
import { plannedSends, to12h } from '../../../shared/calc';
import { nowIso, type Db } from '../db';
import { AppError } from '../errors';
import type { SettingsService } from '../settings/service';
import type { SecretStore } from '../settings/secrets';
import type { RunService } from '../runs/service';
import type { EmailSecrets } from '../testers/email';
import { sendEmail, SendError, type SendableMessage, type SendContext } from './providers';

export interface EmailDeps {
  db: Db;
  settings: SettingsService;
  secrets: SecretStore;
  runs: RunService;
  fetch: SendContext['fetch'];
  smtpSend?: SendContext['smtpSend'];
  now?: () => Date;
}

interface Row {
  id: number; week_start: string; event_id: string; cycle_no: number; mode: string; recipient: string;
  to_list: string; cc_list: string; subject: string; status: string; provider: string;
  provider_message_id: string; error: string; employee_id: number | null; trigger: string; sent_at: string; actor: string;
}

export interface SendEventOptions {
  eventId: EventId;
  weekOf?: string;
  cycleNo?: number;
  trigger?: 'manual' | 'scheduled';
  actor: string;
}

export class EmailService {
  constructor(private d: EmailDeps) {}

  private emailSecrets(): EmailSecrets {
    return {
      gmailClientSecret: this.d.secrets.get('email.gmail.clientSecret'),
      gmailRefreshToken: this.d.secrets.get('email.gmail.refreshToken'),
      graphClientSecret: this.d.secrets.get('email.graph.clientSecret'),
      smtpPassword: this.d.secrets.get('email.smtp.password'),
    };
  }

  /** Does a 'sent' or 'dry_run' row already exist for this reminder and recipient? */
  private alreadyHandled(weekStart: string, eventId: string, cycleNo: number, recipient: string): boolean {
    const r = this.d.db
      .prepare(
        `SELECT 1 FROM email_messages WHERE week_start = ? AND event_id = ? AND cycle_no = ? AND recipient = ?
         AND status IN ('sent', 'dry_run') LIMIT 1`,
      )
      .get(weekStart, eventId, cycleNo, recipient);
    return !!r;
  }

  /** Human time of the next repeat after this cycle, for {next_run_time}. */
  private nextRunTime(settings: Settings, eventId: EventId, cycleNo: number): string | undefined {
    const plan = plannedSends(settings).filter((p) => !p.skipReason);
    const idx = plan.findIndex((p) => p.eventId === eventId && (p.reportNumber ?? 1) === cycleNo);
    const next = idx >= 0 ? plan[idx + 1] : undefined;
    return next ? to12h(next.time) : undefined;
  }

  async sendEvent(opts: SendEventOptions): Promise<SendSummary> {
    const { settings } = this.d.settings.current();
    const event = settings.schedule.events.find((e) => e.id === opts.eventId);
    if (!event) throw new AppError(400, `Unknown reminder event ${opts.eventId}.`);
    const week = this.d.runs.week(opts.weekOf);
    const cycleNo = opts.cycleNo ?? 1;
    const trigger = opts.trigger ?? 'manual';

    const messages = buildEventMessages({
      settings, week, eventId: opts.eventId, reportNumber: cycleNo,
      nextRunTime: this.nextRunTime(settings, opts.eventId, cycleNo),
    });

    const recorded: EmailMessage[] = [];
    let sent = 0, dryRunCount = 0, skipped = 0, failed = 0;
    const secrets = this.emailSecrets();
    const ctx: SendContext = { fetch: this.d.fetch, smtpSend: this.d.smtpSend };

    for (const m of messages) {
      if (this.alreadyHandled(week.weekStart, opts.eventId, cycleNo, m.dedupeRecipient)) {
        skipped++;
        continue;
      }
      let status: EmailStatus;
      let providerId = '';
      let error = '';
      if (!m.to.length) {
        status = 'failed';
        error = `No recipient address for ${m.mode} mode. Add addresses on the Recipients page.`;
        failed++;
      } else if (settings.dryRun) {
        status = 'dry_run';
        dryRunCount++;
      } else {
        try {
          providerId = await sendEmail(settings.emailProvider, secrets, msgOf(m), ctx);
          status = 'sent';
          sent++;
        } catch (e) {
          if (!(e instanceof SendError)) throw e;
          status = 'failed';
          error = e.message;
          failed++;
        }
      }
      recorded.push(this.record({
        weekStart: week.weekStart, eventId: opts.eventId, cycleNo, m, status,
        provider: settings.emailProvider.type, providerId, error, trigger, actor: opts.actor,
      }));
    }

    this.d.settings.audit(opts.actor, 'email.send',
      `${opts.eventId} #${cycleNo} ${trigger}${settings.dryRun ? ' (dry run)' : ''}: ${sent} sent, ${dryRunCount} dry-run, ${skipped} skipped, ${failed} failed`);

    return { weekStart: week.weekStart, eventId: opts.eventId, cycleNo, dryRun: settings.dryRun, sent, dryRunCount, skipped, failed, messages: recorded };
  }

  /** Send one template rendered with this week's data to a chosen address, ignoring dry-run and dedupe. */
  async sendTest(opts: { eventId: EventId; to: string; weekOf?: string; actor: string }): Promise<EmailMessage> {
    const { settings } = this.d.settings.current();
    const week = this.d.runs.week(opts.weekOf);
    const [first] = buildEventMessages({ settings, week, eventId: opts.eventId, reportNumber: 1 });
    if (!first) throw new AppError(400, 'Nothing to preview: no pending employees for an individual-mode event this week.');
    const message: OutgoingMessage = { ...first, to: [opts.to], cc: [], dedupeRecipient: opts.to };
    let providerId = '', error = '', status: EmailStatus = 'test';
    try {
      providerId = await sendEmail(settings.emailProvider, this.emailSecrets(), msgOf(message), { fetch: this.d.fetch, smtpSend: this.d.smtpSend });
    } catch (e) {
      if (!(e instanceof SendError)) throw e;
      status = 'failed';
      error = e.message;
    }
    const rec = this.record({
      weekStart: week.weekStart, eventId: opts.eventId, cycleNo: 1, m: message, status,
      provider: settings.emailProvider.type, providerId, error, trigger: 'test', actor: opts.actor,
    });
    this.d.settings.audit(opts.actor, 'email.test', `${opts.eventId} to ${opts.to}: ${status}${error ? ` (${error})` : ''}`);
    if (status === 'failed') throw new AppError(502, error);
    return rec;
  }

  private record(a: {
    weekStart: string; eventId: string; cycleNo: number; m: OutgoingMessage; status: EmailStatus;
    provider: string; providerId: string; error: string; trigger: string; actor: string;
  }): EmailMessage {
    const sentAt = this.d.now ? this.d.now().toISOString() : nowIso();
    const info = this.d.db
      .prepare(
        `INSERT INTO email_messages
         (week_start, event_id, cycle_no, mode, recipient, to_list, cc_list, subject, status, provider, provider_message_id, error, employee_id, trigger, sent_at, actor)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        a.weekStart, a.eventId, a.cycleNo, a.m.mode, a.m.dedupeRecipient, JSON.stringify(a.m.to), JSON.stringify(a.m.cc),
        a.m.subject, a.status, a.provider, a.providerId, a.error, a.m.employeeId ?? null, a.trigger, sentAt, a.actor,
      );
    return toMessage({
      id: Number(info.lastInsertRowid), week_start: a.weekStart, event_id: a.eventId, cycle_no: a.cycleNo, mode: a.m.mode,
      recipient: a.m.dedupeRecipient, to_list: JSON.stringify(a.m.to), cc_list: JSON.stringify(a.m.cc), subject: a.m.subject,
      status: a.status, provider: a.provider, provider_message_id: a.providerId, error: a.error,
      employee_id: a.m.employeeId ?? null, trigger: a.trigger, sent_at: sentAt, actor: a.actor,
    });
  }

  history(limit = 100): EmailMessage[] {
    const rows = this.d.db.prepare('SELECT * FROM email_messages ORDER BY id DESC LIMIT ?').all(limit) as unknown as Row[];
    return rows.map(toMessage);
  }
}

const msgOf = (m: OutgoingMessage): SendableMessage => ({ to: m.to, cc: m.cc, subject: m.subject, html: m.html });

function toMessage(r: Row): EmailMessage {
  return {
    id: r.id, weekStart: r.week_start, eventId: r.event_id, cycleNo: r.cycle_no, mode: r.mode as EmailMessage['mode'],
    recipient: r.recipient, to: safeArr(r.to_list), cc: safeArr(r.cc_list), subject: r.subject, status: r.status as EmailStatus,
    provider: r.provider, providerMessageId: r.provider_message_id, error: r.error, employeeId: r.employee_id,
    trigger: r.trigger as EmailMessage['trigger'], sentAt: r.sent_at, actor: r.actor,
  };
}
const safeArr = (s: string): string[] => {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
};
