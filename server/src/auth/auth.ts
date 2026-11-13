/**
 * Interim admin login: one admin password from the environment, exchanged for a
 * signed, expiring bearer token. Replace with company SSO and manager/viewer roles
 * before production (plan Phase 9).
 */
import { createHmac } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../errors';
import { safeEqual } from '../crypto';

export type Role = 'admin';
export interface Session { sub: string; role: Role; exp: number }

const TTL_MS = 8 * 60 * 60 * 1000;
const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export class Auth {
  private attempts = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private key: Buffer,
    private adminPassword: string,
  ) {}

  login(password: string, ip: string): { token: string; session: Session } {
    this.throttle(ip);
    if (!safeEqual(password, this.adminPassword)) throw new AppError(401, 'That password is not correct.');
    this.attempts.delete(ip);
    const session: Session = { sub: 'admin', role: 'admin', exp: Date.now() + TTL_MS };
    const payload = b64url(JSON.stringify(session));
    return { token: `${payload}.${this.sign(payload)}`, session };
  }

  verify(token: string | undefined): Session | null {
    if (!token) return null;
    const [payload, sig] = token.split('.');
    if (!payload || !sig || !safeEqual(sig, this.sign(payload))) return null;
    try {
      const s = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Session;
      return s.exp > Date.now() ? s : null;
    } catch {
      return null;
    }
  }

  /** Fastify preHandler that requires an admin session. */
  requireAdmin = async (req: FastifyRequest, _reply: FastifyReply) => {
    const header = req.headers.authorization;
    const session = this.verify(header?.startsWith('Bearer ') ? header.slice(7) : undefined);
    if (!session) throw new AppError(401, 'Sign in to continue.');
    if (session.role !== 'admin') throw new AppError(403, 'Only administrators can change settings.');
    req.session = session;
  };

  private sign(payload: string) {
    return createHmac('sha256', this.key).update(payload).digest('base64url');
  }

  /** At most 10 failed attempts per IP per 15 minutes. */
  private throttle(ip: string) {
    const now = Date.now();
    const a = this.attempts.get(ip);
    if (!a || a.resetAt < now) {
      this.attempts.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
      return;
    }
    a.count++;
    if (a.count > 10) throw new AppError(429, 'Too many sign-in attempts. Wait 15 minutes and try again.');
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    session?: Session;
  }
}
