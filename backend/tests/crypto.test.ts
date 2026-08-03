import { describe, it, expect, afterAll } from 'vitest';
import { encryptSecret, decryptSecret, maskKey } from '../src/crypto';
import { closePool } from '../src/db/pool';

const SECRET = 'unit-test-encryption-secret';
// Fake, non-functional key shaped like a real one. Never put a live key in tests.
const KEY = 'AQ.Bx0000000000000000000000000000000000000000000000';

describe('secret encryption', () => {
  afterAll(closePool);

  it('round-trips a key', () => {
    expect(decryptSecret(encryptSecret(KEY, SECRET), SECRET)).toBe(KEY);
  });

  it('produces a different ciphertext each time (random IV)', () => {
    expect(encryptSecret(KEY, SECRET)).not.toBe(encryptSecret(KEY, SECRET));
  });

  it('never leaves the plaintext visible in the stored blob', () => {
    const blob = encryptSecret(KEY, SECRET);
    expect(blob).not.toContain(KEY);
    expect(Buffer.from(blob, 'base64').toString('utf8')).not.toContain(KEY);
  });

  it('fails closed under the wrong secret', () => {
    expect(decryptSecret(encryptSecret(KEY, SECRET), 'a-different-secret')).toBeNull();
  });

  it('fails closed on a tampered blob', () => {
    const raw = Buffer.from(encryptSecret(KEY, SECRET), 'base64');
    raw[raw.length - 1] ^= 0xff; // flip a bit in the ciphertext
    expect(decryptSecret(raw.toString('base64'), SECRET)).toBeNull();
  });

  it('fails closed on garbage rather than throwing', () => {
    expect(decryptSecret('not-base64-at-all!!', SECRET)).toBeNull();
    expect(decryptSecret('', SECRET)).toBeNull();
    expect(decryptSecret('c2hvcnQ=', SECRET)).toBeNull();
  });

  it('masks a key without revealing the middle', () => {
    const masked = maskKey(KEY);
    expect(masked.startsWith('AQ.Bx')).toBe(true);
    expect(masked.endsWith('0000')).toBe(true);
    expect(masked.length).toBeLessThan(KEY.length);
    expect(maskKey('short')).toBe('••••');
  });
});
