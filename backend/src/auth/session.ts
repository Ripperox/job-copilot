import * as jwt from 'jsonwebtoken';
import { Response } from 'express';
import { Config, config as defaultConfig } from '../config';

// The session is a signed JWT in an httpOnly cookie. No passwords are ever stored,
// and the cookie is never readable from JavaScript.

export const SESSION_COOKIE = 'jc_session';
const SESSION_TTL_DAYS = 30;

export interface SessionPayload {
  uid: string; // users.id
}

export function signSession(userId: string, config: Config = defaultConfig): string {
  if (!config.sessionSecret) throw new Error('SESSION_SECRET is not set');
  return jwt.sign({ uid: userId } satisfies SessionPayload, config.sessionSecret, {
    expiresIn: `${SESSION_TTL_DAYS}d`,
  });
}

// Returns the user id, or null when the token is missing, tampered with, or expired.
export function verifySession(token: string | undefined, config: Config = defaultConfig): string | null {
  if (!token || !config.sessionSecret) return null;
  try {
    const decoded = jwt.verify(token, config.sessionSecret) as SessionPayload;
    return typeof decoded.uid === 'string' && decoded.uid ? decoded.uid : null;
  } catch {
    return null;
  }
}

/**
 * Cookie flags differ between dev and production, and getting this wrong makes
 * login fail silently.
 *
 * In dev the frontend (localhost:5176) and API (localhost:4500) differ only by
 * port, so the browser treats them as the SAME site and SameSite=Lax works.
 *
 * In production they are genuinely different sites (app.vercel.app calling
 * api.onrender.com). Lax would make the browser refuse to send the session
 * cookie on those cross-site XHRs, so it must be SameSite=None — which the spec
 * only permits together with Secure.
 */
export function sessionCookieOptions(config: Config = defaultConfig) {
  return {
    httpOnly: true,
    secure: config.isProduction, // Secure requires HTTPS, which local dev lacks
    sameSite: (config.isProduction ? 'none' : 'lax') as 'none' | 'lax',
    path: '/',
  };
}

export function setSessionCookie(res: Response, userId: string, config: Config = defaultConfig): void {
  res.cookie(SESSION_COOKIE, signSession(userId, config), {
    ...sessionCookieOptions(config),
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
  });
}

export function clearSessionCookie(res: Response, config: Config = defaultConfig): void {
  res.clearCookie(SESSION_COOKIE, sessionCookieOptions(config));
}
