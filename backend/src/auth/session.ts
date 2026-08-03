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

export function setSessionCookie(res: Response, userId: string, config: Config = defaultConfig): void {
  res.cookie(SESSION_COOKIE, signSession(userId, config), {
    httpOnly: true,
    // Secure requires HTTPS, which local dev does not have.
    secure: config.isProduction,
    sameSite: 'lax',
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

export function clearSessionCookie(res: Response, config: Config = defaultConfig): void {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'lax',
    path: '/',
  });
}
