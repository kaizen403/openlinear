import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(() => {
  process.env.TOKEN_ENCRYPTION_KEY = 'test-token-encryption-key-1234567890';
});

const { encryptToken, decryptToken, isEncryptedToken } = await import('@openlinear/db');

describe('token encryption', () => {
  it('round-trips a token through encrypt/decrypt', () => {
    const plaintext = 'ghp_exampleAccessToken_abc123';
    const ct = encryptToken(plaintext);
    expect(ct).not.toBe(plaintext);
    expect(isEncryptedToken(ct)).toBe(true);
    expect(decryptToken(ct)).toBe(plaintext);
  });

  it('produces different ciphertexts for the same plaintext (random IV)', () => {
    const plaintext = 'ghp_sameInput';
    const a = encryptToken(plaintext);
    const b = encryptToken(plaintext);
    expect(a).not.toBe(b);
    expect(decryptToken(a)).toBe(plaintext);
    expect(decryptToken(b)).toBe(plaintext);
  });

  it('treats unprefixed values as legacy plaintext (no decrypt)', () => {
    expect(decryptToken('ghp_legacyPlain')).toBe('ghp_legacyPlain');
    expect(isEncryptedToken('ghp_legacyPlain')).toBe(false);
  });

  it('throws when a tampered ciphertext is supplied', () => {
    const ct = encryptToken('ghp_target');
    const tampered = ct.slice(0, -2) + 'XX';
    expect(() => decryptToken(tampered)).toThrow();
  });

  it('returns null for null/empty inputs', () => {
    expect(decryptToken(null)).toBe(null);
    expect(decryptToken('')).toBe(null);
  });
});
