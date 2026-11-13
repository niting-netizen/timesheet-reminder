import nodemailer from 'nodemailer';
import type { EmailProviderConfig } from '../../../shared/settings';
import { describeStatus, ProbeError, request, type FetchFn, type ProbeResult } from './http';

export interface EmailSecrets {
  gmailClientSecret?: string;
  gmailRefreshToken?: string;
  graphClientSecret?: string;
  smtpPassword?: string;
}

export interface EmailTestContext {
  fetch: FetchFn;
  /** Swappable for tests. */
  smtpVerify?: (opts: SmtpOptions) => Promise<void>;
}

export interface SmtpOptions {
  host: string;
  port: number;
  secure: boolean;
  requireTLS: boolean;
  auth: { user: string; pass: string };
}

const need = (v: string | undefined, label: string) => {
  if (!v || !v.trim()) throw new ProbeError(`Enter the ${label}.`);
  return v.trim();
};

/**
 * Proves the provider accepts the credentials. It does not send mail: sending a
 * test message arrives with the email phase, behind dry-run.
 */
export async function testEmail(cfg: EmailProviderConfig, s: EmailSecrets, ctx: EmailTestContext): Promise<ProbeResult> {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cfg.from)) throw new ProbeError('Enter a valid From address.');

  if (cfg.type === 'gmail') {
    const body = new URLSearchParams({
      client_id: need(cfg.gmail.clientId, 'OAuth client ID'),
      client_secret: need(s.gmailClientSecret, 'OAuth client secret'),
      refresh_token: need(s.gmailRefreshToken, 'refresh token'),
      grant_type: 'refresh_token',
    });
    const r = await request(ctx.fetch, 'https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const b = r.body as { access_token?: string; scope?: string; error?: string; error_description?: string } | null;
    if (r.status !== 200 || !b?.access_token) {
      if (b?.error === 'invalid_grant') return { ok: false, message: 'The refresh token is expired or revoked. Authorise the sender mailbox again.' };
      if (b?.error === 'invalid_client') return { ok: false, message: 'Google rejected the client ID or client secret.' };
      return { ok: false, message: b?.error_description ?? describeStatus(r.status, 'OAuth credentials') };
    }
    const scopes = (b.scope ?? '').split(' ');
    const canSend = scopes.some((sc) => sc.endsWith('/gmail.send') || sc === 'https://mail.google.com/');
    return canSend
      ? { ok: true, message: `Google issued a token with permission to send mail as ${cfg.from}.` }
      : { ok: false, message: 'Google issued a token, but without the gmail.send permission. Authorise again with that scope.' };
  }

  if (cfg.type === 'graph') {
    const tenant = need(cfg.graph.tenantId, 'tenant ID');
    if (!/^[A-Za-z0-9.-]+$/.test(tenant)) throw new ProbeError('The tenant ID looks wrong. Use the directory (tenant) ID or domain.');
    const body = new URLSearchParams({
      client_id: need(cfg.graph.clientId, 'application (client) ID'),
      client_secret: need(s.graphClientSecret, 'client secret'),
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    });
    const r = await request(ctx.fetch, `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const b = r.body as { access_token?: string; error_description?: string } | null;
    if (r.status !== 200 || !b?.access_token) {
      return { ok: false, message: b?.error_description?.split('\r\n')[0] ?? describeStatus(r.status, 'client secret') };
    }
    const roles = decodeJwtRoles(b.access_token);
    return roles.includes('Mail.Send')
      ? { ok: true, message: 'Microsoft issued a token with the Mail.Send permission.' }
      : { ok: false, message: 'Microsoft issued a token, but the app lacks the Mail.Send application permission. Ask an admin to grant it.' };
  }

  // SMTP
  const opts: SmtpOptions = {
    host: need(cfg.smtp.host, 'SMTP host'),
    port: cfg.smtp.port,
    secure: cfg.smtp.security === 'ssl',
    requireTLS: cfg.smtp.security === 'starttls',
    auth: { user: need(cfg.smtp.user, 'SMTP username'), pass: need(s.smtpPassword, 'SMTP password') },
  };
  const verify =
    ctx.smtpVerify ??
    (async (o: SmtpOptions) => {
      const t = nodemailer.createTransport({ ...o, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 10_000 });
      try {
        await t.verify();
      } finally {
        t.close();
      }
    });
  try {
    await verify(opts);
  } catch (e) {
    const err = e as { code?: string; responseCode?: number; message?: string };
    if (err.code === 'EAUTH' || err.responseCode === 535) return { ok: false, message: 'The SMTP server rejected the username or password.' };
    if (err.code === 'ETIMEDOUT' || err.code === 'ECONNECTION' || err.code === 'ESOCKET') {
      return { ok: false, message: `Could not reach ${opts.host}:${opts.port}. Check the host, port and security setting.` };
    }
    if (err.code === 'EDNS') return { ok: false, message: 'Could not find that SMTP host. Check the spelling.' };
    return { ok: false, message: `SMTP check failed: ${err.message ?? 'unknown error'}` };
  }
  return { ok: true, message: `Signed in to ${opts.host}:${opts.port} as ${opts.auth.user}.` };
}

function decodeJwtRoles(token: string): string[] {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as { roles?: string[] };
    return payload.roles ?? [];
  } catch {
    return [];
  }
}
