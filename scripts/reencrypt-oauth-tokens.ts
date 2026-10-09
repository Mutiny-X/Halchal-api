/**
 * Moves stored Instagram and YouTube tokens from the old login-secret-derived key
 * to their own keys (INSTAGRAM_TOKEN_ENCRYPTION_KEY / YOUTUBE_TOKEN_ENCRYPTION_KEY).
 * Before those keys were required, an unset key silently fell back to JWT_SECRET,
 * so existing tokens may still be encrypted that way. Until this has run they stay
 * readable (the API falls back to the old key); after it they no longer depend on
 * JWT_SECRET at all.
 *
 * Idempotent: values that already open with the new key are left alone. Empty
 * values (tokens wiped on disconnect) are skipped. --dry-run changes nothing.
 *
 * Usage:
 *   pnpm exec tsx scripts/reencrypt-oauth-tokens.ts [--dry-run]
 */
import { PrismaClient } from "@prisma/client";

import {
  decryptPayoutAccountWithKeys,
  encryptPayoutAccount,
  needsPayoutReencrypt,
  resolvePayoutKeys,
} from "../src/payouts/payout-account-crypto";

const prisma = new PrismaClient();
const dryRun = process.argv.includes("--dry-run");

function keysFor(envName: string) {
  const dedicated = process.env[envName]?.trim();
  const jwt = process.env.JWT_SECRET;
  if (!dedicated || !jwt) throw new Error(`Set both ${envName} (the new key) and JWT_SECRET (the old one) first.`);
  if (dedicated === jwt) throw new Error(`${envName} must differ from JWT_SECRET.`);
  return resolvePayoutKeys(dedicated, jwt);
}

/** Re-encrypts one value if it still needs it. Returns the new value, or null to leave it. */
function migrate(keys: ReturnType<typeof keysFor>, value: string | null, counts: { moved: number; unreadable: number }) {
  if (!value || !needsPayoutReencrypt(keys, value)) return null;
  const plain = decryptPayoutAccountWithKeys(keys, value);
  if (plain === null) {
    counts.unreadable++;
    return null;
  }
  counts.moved++;
  return encryptPayoutAccount(keys.primary, plain);
}

async function main(): Promise<void> {
  const ig = keysFor("INSTAGRAM_TOKEN_ENCRYPTION_KEY");
  const yt = keysFor("YOUTUBE_TOKEN_ENCRYPTION_KEY");
  const counts = { moved: 0, unreadable: 0 };

  for (const row of await prisma.instagramConnection.findMany({ select: { id: true, encryptedAccessToken: true } })) {
    const next = migrate(ig, row.encryptedAccessToken, counts);
    if (next && !dryRun) await prisma.instagramConnection.update({ where: { id: row.id }, data: { encryptedAccessToken: next } });
  }
  for (const row of await prisma.instagramOAuthTransaction.findMany({
    where: { encryptedAccessToken: { not: null } },
    select: { id: true, encryptedAccessToken: true },
  })) {
    const next = migrate(ig, row.encryptedAccessToken, counts);
    if (next && !dryRun) await prisma.instagramOAuthTransaction.update({ where: { id: row.id }, data: { encryptedAccessToken: next } });
  }
  for (const row of await prisma.youtubeConnection.findMany({
    select: { id: true, encryptedAccessToken: true, encryptedRefreshToken: true },
  })) {
    const access = migrate(yt, row.encryptedAccessToken, counts);
    const refresh = migrate(yt, row.encryptedRefreshToken, counts);
    if ((access || refresh) && !dryRun) {
      await prisma.youtubeConnection.update({
        where: { id: row.id },
        data: { ...(access && { encryptedAccessToken: access }), ...(refresh && { encryptedRefreshToken: refresh }) },
      });
    }
  }

  console.log(
    `${dryRun ? "[dry run] Would re-encrypt" : "Re-encrypted"} ${counts.moved} token(s).` +
      (counts.unreadable ? ` ${counts.unreadable} value(s) could not be read with either key — investigate.` : ""),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
