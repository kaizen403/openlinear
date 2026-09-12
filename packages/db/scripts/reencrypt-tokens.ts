#!/usr/bin/env node
/**
 * Re-encrypt User.accessToken from OLD_TOKEN_ENCRYPTION_KEY to TOKEN_ENCRYPTION_KEY.
 * Take a Neon snapshot first. `db:encrypt-tokens` only encrypts plaintext leftovers.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { prisma } from "../src/index";

const PREFIX = "enc:v1:";
const IV_LEN = 12;
const TAG_LEN = 16;

function deriveKey(material: string) {
  const raw = material.trim();
  if (!raw || raw.length < 32) {
    throw new Error("encryption key material must be at least 32 characters");
  }
  return createHash("sha256").update(raw, "utf8").digest();
}

function decryptWith(key: Buffer, value: string): string {
  if (!value.startsWith(PREFIX)) return value;
  const blob = Buffer.from(value.slice(PREFIX.length), "base64url");
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  const ct = blob.subarray(IV_LEN, blob.length - TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

function encryptWith(key: Buffer, plaintext: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${Buffer.concat([iv, ct, tag]).toString("base64url")}`;
}

async function main() {
  const oldMaterial = process.env.OLD_TOKEN_ENCRYPTION_KEY?.trim();
  const newMaterial = process.env.TOKEN_ENCRYPTION_KEY?.trim();
  if (!oldMaterial || !newMaterial) {
    throw new Error("Set both OLD_TOKEN_ENCRYPTION_KEY and TOKEN_ENCRYPTION_KEY");
  }
  if (oldMaterial === newMaterial) {
    throw new Error("OLD_TOKEN_ENCRYPTION_KEY and TOKEN_ENCRYPTION_KEY must differ");
  }
  const oldKey = deriveKey(oldMaterial);
  const newKey = deriveKey(newMaterial);

  const users = await prisma.user.findMany({
    where: { accessToken: { not: null } },
    select: { id: true, accessToken: true },
  });

  let rewritten = 0;
  let alreadyNew = 0;
  let failed = 0;

  for (const user of users) {
    const value = user.accessToken;
    if (!value) continue;
    try {
      try {
        decryptWith(newKey, value);
        if (value.startsWith(PREFIX)) {
          alreadyNew += 1;
          continue;
        }
      } catch {
        // Not decryptable with the new key — try the old one.
      }
      const plaintext = decryptWith(oldKey, value);
      await prisma.user.update({
        where: { id: user.id },
        data: { accessToken: encryptWith(newKey, plaintext) },
      });
      rewritten += 1;
    } catch {
      failed += 1;
    }
  }

  console.log(
    `[reencrypt-tokens] rewritten=${rewritten} already_new=${alreadyNew} failed=${failed} total=${users.length}`,
  );
  if (failed > 0) process.exitCode = 1;
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("[reencrypt-tokens] failed:", err);
  await prisma.$disconnect();
  process.exit(1);
});
