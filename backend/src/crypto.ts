import * as crypto from 'crypto';

// AES-256-GCM for secrets we must be able to read back (users' LLM API keys).
// GCM is authenticated: tampering with the stored blob fails decryption instead
// of silently returning garbage.
//
// Layout of the stored string: base64( iv[12] | authTag[16] | ciphertext )

const IV_BYTES = 12;
const TAG_BYTES = 16;

// The env secret is arbitrary text, so derive a fixed 32-byte key from it.
function deriveKey(secret: string): Buffer {
  if (!secret) throw new Error('KEY_ENCRYPTION_SECRET is not set');
  return crypto.createHash('sha256').update(secret).digest();
}

export function encryptSecret(plaintext: string, secret: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

// Returns null when the blob is corrupt, truncated, or was encrypted under a
// different secret — callers treat that as "no usable key" rather than crashing.
export function decryptSecret(blob: string, secret: string): string | null {
  try {
    const raw = Buffer.from(blob, 'base64');
    if (raw.length <= IV_BYTES + TAG_BYTES) return null;
    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(secret), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// Safe to show in a UI: "AQ.Ab8…VDrK". Never log or return the full key.
export function maskKey(key: string): string {
  if (key.length <= 10) return '••••';
  return `${key.slice(0, 5)}…${key.slice(-4)}`;
}
