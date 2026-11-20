/**
 * Sending side of the three email providers. Connection testing lives in testers/email.ts;
 * this module actually delivers a message. Network calls go through the injected fetch, and
 * SMTP delivery through an injectable hook, so the whole path is testable without a real server.
 */
import nodemailer from 'nodemailer';
import type { EmailProviderConfig } from '../../../shared/settings';
import { request, type FetchFn } from '../testers/http';
import type { EmailSecrets } from '../testers/email';

export class SendError extends Error {}

export interface SendableMessage {
  to: string[];
  cc: string[];
  subject: string;
  html: string;
}

export interface SendContext {
  fetch: FetchFn;
  /** Swappable for tests; returns the provider message id. */
  smtpSend?: (opts: SmtpSendOptions, msg: SendableMessage & { from: string; fromName: string; replyTo?: string }) => Promise<string>;
}

export interface SmtpSendOptions {
  host: string;
  port: number;
  secure: boolean;
  requireTLS: boolean;
  auth: { user: string; pass: string };
}

/** Delivers the message and returns a provider message id. Throws SendError on any failure. */
export async function sendEmail(cfg: EmailProviderConfig, secrets: EmailSecrets, msg: SendableMessage, ctx: SendContext): Promise<string> {
  if (!msg.to.length) throw new SendError('No recipient addresses.');
  if (cfg.type === 'gmail') return sendGmail(cfg, secrets, msg, ctx);
  if (cfg.type === 'graph') return sendGraph(cfg, secrets, msg, ctx);
  return sendSmtp(cfg, secrets, msg, ctx);
}

/* ---------- Gmail API ---------- */

async function gmailToken(cfg: EmailProviderConfig, secrets: EmailSecrets, fetchFn: FetchFn): Promise<string> {
  const body = new URLSearchParams({
    client_id: cfg.gmail.clientId,
    client_secret: secrets.gmailClientSecret ?? '',
    refresh_token: secrets.gmailRefreshToken ?? '',
    grant_type: 'refresh_token',
  });
  const r = await request(fetchFn, 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const b = r.body as { access_token?: string; error?: string; error_description?: string } | null;
  if (r.status !== 200 || !b?.access_token) {
    if (b?.error === 'invalid_grant') throw new SendError('The Gmail refresh token is expired or revoked. Authorise the sender mailbox again.');
    throw new SendError(b?.error_description ?? `Google rejected the credentials (${r.status}).`);
  }
  return b.access_token;
}

async function sendGmail(cfg: EmailProviderConfig, secrets: EmailSecrets, msg: SendableMessage, ctx: SendContext): Promise<string> {
  const token = await gmailToken(cfg, secrets, ctx.fetch);
  const raw = Buffer.from(rfc822(cfg, msg)).toString('base64url');
  const r = await request(ctx.fetch, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  const b = r.body as { id?: string; error?: { message?: string } } | null;
  if (r.status < 200 || r.status >= 300 || !b?.id) throw new SendError(b?.error?.message ?? `Gmail did not accept the message (${r.status}).`);
  return b.id;
}

/* ---------- Microsoft Graph ---------- */

async function graphToken(cfg: EmailProviderConfig, secrets: EmailSecrets, fetchFn: FetchFn): Promise<string> {
  const body = new URLSearchParams({
    client_id: cfg.graph.clientId,
    client_secret: secrets.graphClientSecret ?? '',
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const r = await request(fetchFn, `https://login.microsoftonline.com/${encodeURIComponent(cfg.graph.tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const b = r.body as { access_token?: string; error_description?: string } | null;
  if (r.status !== 200 || !b?.access_token) throw new SendError(b?.error_description?.split('\r\n')[0] ?? `Microsoft rejected the credentials (${r.status}).`);
  return b.access_token;
}

async function sendGraph(cfg: EmailProviderConfig, secrets: EmailSecrets, msg: SendableMessage, ctx: SendContext): Promise<string> {
  const token = await graphToken(cfg, secrets, ctx.fetch);
  const recipients = (addrs: string[]) => addrs.map((address) => ({ emailAddress: { address } }));
  const payload = {
    message: {
      subject: msg.subject,
      body: { contentType: 'HTML', content: msg.html },
      from: { emailAddress: { address: cfg.from } },
      toRecipients: recipients(msg.to),
      ccRecipients: recipients(msg.cc),
      ...(cfg.replyTo ? { replyTo: recipients([cfg.replyTo]) } : {}),
    },
    saveToSentItems: false,
  };
  const r = await request(ctx.fetch, `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(cfg.from)}/sendMail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (r.status < 200 || r.status >= 300) {
    const b = r.body as { error?: { message?: string } } | null;
    throw new SendError(b?.error?.message ?? `Microsoft Graph did not accept the message (${r.status}).`);
  }
  // sendMail returns 202 Accepted with no body; Graph does not expose a message id here.
  return `graph:${Date.now()}`;
}

/* ---------- SMTP ---------- */

async function sendSmtp(cfg: EmailProviderConfig, secrets: EmailSecrets, msg: SendableMessage, ctx: SendContext): Promise<string> {
  const opts: SmtpSendOptions = {
    host: cfg.smtp.host,
    port: cfg.smtp.port,
    secure: cfg.smtp.security === 'ssl',
    requireTLS: cfg.smtp.security === 'starttls',
    auth: { user: cfg.smtp.user, pass: secrets.smtpPassword ?? '' },
  };
  const full = { ...msg, from: cfg.from, fromName: cfg.fromName, replyTo: cfg.replyTo || undefined };
  const send =
    ctx.smtpSend ??
    (async (o: SmtpSendOptions, m: typeof full) => {
      const t = nodemailer.createTransport({ ...o, connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 20_000 });
      try {
        const info = await t.sendMail({
          from: m.fromName ? `"${m.fromName}" <${m.from}>` : m.from,
          to: m.to,
          cc: m.cc.length ? m.cc : undefined,
          replyTo: m.replyTo,
          subject: m.subject,
          html: m.html,
        });
        return info.messageId;
      } finally {
        t.close();
      }
    });
  try {
    return await send(opts, full);
  } catch (e) {
    const err = e as { code?: string; responseCode?: number; message?: string };
    if (err.code === 'EAUTH' || err.responseCode === 535) throw new SendError('The SMTP server rejected the username or password.');
    if (err.code === 'ETIMEDOUT' || err.code === 'ECONNECTION' || err.code === 'ESOCKET') throw new SendError(`Could not reach ${opts.host}:${opts.port}.`);
    throw new SendError(`SMTP send failed: ${err.message ?? 'unknown error'}`);
  }
}

/* ---------- helpers ---------- */

/** RFC 822 message for the Gmail API. Non-ASCII subjects use an encoded-word. */
function rfc822(cfg: EmailProviderConfig, msg: SendableMessage): string {
  const fromHeader = cfg.fromName ? `${encodeWordIfNeeded(cfg.fromName)} <${cfg.from}>` : cfg.from;
  const lines = [
    `From: ${fromHeader}`,
    `To: ${msg.to.join(', ')}`,
    ...(msg.cc.length ? [`Cc: ${msg.cc.join(', ')}`] : []),
    ...(cfg.replyTo ? [`Reply-To: ${cfg.replyTo}`] : []),
    `Subject: ${encodeWordIfNeeded(msg.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(msg.html, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'),
  ];
  return lines.join('\r\n');
}

function encodeWordIfNeeded(s: string): string {
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\x7F]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}
