import { Request, Response, NextFunction } from 'express';
import { SESSION_COOKIE, verifySession } from './session';

// The authenticated user id is attached here and NOWHERE else. Route handlers must
// read req.userId — never a user id from the body, query, or a header — so a client
// can never address another tenant's data.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

// Attaches req.userId when a valid session cookie or Bearer token is present; never rejects.
export function attachUser(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  const bearerToken = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : undefined;
  const token = bearerToken || req.cookies?.[SESSION_COOKIE];
  const userId = verifySession(token);
  if (userId) req.userId = userId;
  next();
}

// Rejects the request unless a valid session is present.
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.userId) {
    res.status(401).json({ error: 'Not signed in.' });
    return;
  }
  next();
}
