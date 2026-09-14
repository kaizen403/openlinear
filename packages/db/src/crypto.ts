import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * AES-256-GCM token encryption for at-rest secrets (GitHub access tokens, etc).
 *
 * Storage format (single string column):
 *
 *   enc:v1:<base64url(iv | ciphertext | tag)>
 *
 *   iv          — 12 bytes
 *   ciphertext  — variable
 *   tag         — 16 bytes (GCM auth tag)
 *
 * Values WITHOUT the `enc:v1:` prefix are treated as legacy plaintext so that
 * production rollouts do not lock users out before the one-shot backfill runs.
 *
 * The encryption key is derived from `TOKEN_ENCRYPTION_KEY` (env). In production
 * this MUST be set; in non-production a deterministic dev key is derived from
 * `JWT_SECRET` (or a literal fallback) so local development keeps working.
 */

const PREFIX = "enc:v1:";
const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

let cachedKey: Buffer | null = null;
let cachedKeySource: string | null = null;

function deriveKey(material: string): Buffer {
  // SHA-256 → 32 bytes, exactly what AES-256 wants.
  return createHash("sha256").update(material, "utf8").digest();
}

const MIN_KEY_LENGTH = 32;

/**
 * Values published in this repository. Accepting any of them would mean every
 * stored GitHub token is encrypted under a key an attacker already has.
 */
const PUBLISHED_KEYS = new Set([
  "openlinear-dev-token-encryption-key",
  "openlinear-dev-secret-change-in-production",
]);

function getEncryptionKey(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY?.trim();

  // No environment exemption. Previously any non-production process — including
  // every packaged desktop build, which never sets NODE_ENV — silently derived
  // the key from JWT_SECRET or from a literal in this file, so the ciphertext
  // protecting users' GitHub tokens was decryptable by anyone with the source.
  if (!raw) {
    throw new Error(
      "[crypto] TOKEN_ENCRYPTION_KEY is not set. Generate one with `openssl rand -base64 48`. " +
        "There is no development fallback: a shared default would be a published key.",
    );
  }
  if (PUBLISHED_KEYS.has(raw)) {
    throw new Error(
      "[crypto] TOKEN_ENCRYPTION_KEY is set to a placeholder published in this repository and must be rotated.",
    );
  }
  if (raw.length < MIN_KEY_LENGTH) {
    throw new Error(
      `[crypto] TOKEN_ENCRYPTION_KEY must be at least ${MIN_KEY_LENGTH} characters (got ${raw.length}).`,
    );
  }

  if (cachedKey && cachedKeySource === raw) return cachedKey;
  cachedKey = deriveKey(raw);
  cachedKeySource = raw;
  return cachedKey;
}

export function isEncryptedToken(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(PREFIX);
}

export function encryptToken(plaintext: string): string {
  if (!plaintext) return plaintext;
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  const blob = Buffer.concat([iv, ct, tag]).toString("base64url");
  return `${PREFIX}${blob}`;
}

export function decryptToken(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!isEncryptedToken(value)) {
    // Legacy plaintext — return as-is. The backfill script rewrites these.
    return value;
  }
  const key = getEncryptionKey();
  const blob = Buffer.from(value.slice(PREFIX.length), "base64url");
  if (blob.length < IV_LEN + TAG_LEN + 1) {
    throw new Error("[crypto] ciphertext blob too short");
  }
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  const ct = blob.subarray(IV_LEN, blob.length - TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}

/**
 * Fast equality check that avoids leaking timing information when comparing
 * two ciphertext or plaintext token values.
 */
export function tokensEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
