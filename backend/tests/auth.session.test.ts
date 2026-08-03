import { describe, it, expect, afterAll } from 'vitest';
import { signSession, verifySession } from '../src/auth/session';
import { closePool } from '../src/db/pool';
import { Config, config } from '../src/config';

const withSecret = (secret: string): Config => ({ ...config, sessionSecret: secret });

describe('session tokens', () => {
  afterAll(closePool);

  const c = withSecret('test-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaa');

  it('round-trips a user id', () => {
    const token = signSession('user-123', c);
    expect(verifySession(token, c)).toBe('user-123');
  });

  it('rejects a token signed with a different secret', () => {
    const token = signSession('user-123', withSecret('other-secret-bbbbbbbbbbbbbbbbbbbb'));
    expect(verifySession(token, c)).toBeNull();
  });

  it('rejects a tampered token', () => {
    const token = signSession('user-123', c);
    const [h, p, s] = token.split('.');
    // Flip the payload to a different user id, keeping the original signature.
    const forged = `${h}.${Buffer.from(JSON.stringify({ uid: 'attacker' })).toString('base64url')}.${s}`;
    expect(verifySession(forged, c)).toBeNull();
  });

  it('rejects missing or malformed tokens', () => {
    expect(verifySession(undefined, c)).toBeNull();
    expect(verifySession('', c)).toBeNull();
    expect(verifySession('not-a-jwt', c)).toBeNull();
  });

  it('returns null when no secret is configured', () => {
    expect(verifySession('anything', withSecret(''))).toBeNull();
  });
});
