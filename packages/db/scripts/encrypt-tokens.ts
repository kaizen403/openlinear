#!/usr/bin/env node
import { prisma, encryptToken, isEncryptedToken } from "../src/index";

async function main() {
  const users = await prisma.user.findMany({
    where: { accessToken: { not: null } },
    select: { id: true, accessToken: true },
  });

  let encrypted = 0;
  let alreadyEncrypted = 0;

  for (const user of users) {
    if (!user.accessToken) continue;
    if (isEncryptedToken(user.accessToken)) {
      alreadyEncrypted += 1;
      continue;
    }
    const ciphertext = encryptToken(user.accessToken);
    await prisma.user.update({
      where: { id: user.id },
      data: { accessToken: ciphertext },
    });
    encrypted += 1;
  }

  console.log(
    `[encrypt-tokens] done — ${encrypted} encrypted, ${alreadyEncrypted} already encrypted, ${users.length} total`,
  );
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("[encrypt-tokens] failed:", err);
  await prisma.$disconnect();
  process.exit(1);
});
