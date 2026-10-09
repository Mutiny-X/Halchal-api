/**
 * Moves stored bank account numbers from the old login-secret-derived key to
 * PAYOUT_ACCOUNT_ENCRYPTION_KEY. Before that key was required, an unset key
 * silently fell back to JWT_SECRET, so existing rows (and the copies frozen
 * onto withdrawals at request time) may be encrypted that way.
 *
 * Idempotent: rows that already open with the new key are left alone, so it is
 * safe to re-run. Pass --dry-run to see the counts without writing anything.
 * Run it once after setting PAYOUT_ACCOUNT_ENCRYPTION_KEY, before any other
 * change to JWT_SECRET.
 *
 * Usage:
 *   pnpm exec tsx scripts/reencrypt-payout-accounts.ts [--dry-run]
 */
import { Prisma, PrismaClient } from "@prisma/client";

import {
  decryptPayoutAccountWithKeys,
  encryptPayoutAccount,
  needsPayoutReencrypt,
  resolvePayoutKeys,
} from "../src/payouts/payout-account-crypto";

const prisma = new PrismaClient();
const dryRun = process.argv.includes("--dry-run");

async function main(): Promise<void> {
  const dedicated = process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY?.trim();
  const jwtSecret = process.env.JWT_SECRET;
  if (!dedicated || !jwtSecret) {
    throw new Error("Set both PAYOUT_ACCOUNT_ENCRYPTION_KEY (the new key) and JWT_SECRET (the old one) first.");
  }
  if (dedicated === jwtSecret) {
    throw new Error("PAYOUT_ACCOUNT_ENCRYPTION_KEY must differ from JWT_SECRET — nothing to migrate.");
  }
  const keys = resolvePayoutKeys(dedicated, jwtSecret);

  let methods = 0;
  let snapshots = 0;
  let unreadable = 0;

  for (const m of await prisma.payoutMethod.findMany({ select: { id: true, accountNumber: true } })) {
    if (!needsPayoutReencrypt(keys, m.accountNumber)) continue;
    const plain = decryptPayoutAccountWithKeys(keys, m.accountNumber);
    if (plain === null) {
      unreadable++;
      continue;
    }
    if (!dryRun) {
      await prisma.payoutMethod.update({
        where: { id: m.id },
        data: { accountNumber: encryptPayoutAccount(keys.primary, plain) },
      });
    }
    methods++;
  }

  // The number frozen onto each withdrawal when it was requested.
  for (const w of await prisma.withdrawal.findMany({
    where: { payoutSnapshot: { not: Prisma.DbNull } },
    select: { id: true, payoutSnapshot: true },
  })) {
    const snap = w.payoutSnapshot as { accountNumber?: string } | null;
    if (!snap?.accountNumber || !needsPayoutReencrypt(keys, snap.accountNumber)) continue;
    const plain = decryptPayoutAccountWithKeys(keys, snap.accountNumber);
    if (plain === null) {
      unreadable++;
      continue;
    }
    if (!dryRun) {
      await prisma.withdrawal.update({
        where: { id: w.id },
        data: { payoutSnapshot: { ...snap, accountNumber: encryptPayoutAccount(keys.primary, plain) } },
      });
    }
    snapshots++;
  }

  console.log(
    `${dryRun ? "[dry run] Would re-encrypt" : "Re-encrypted"} ${methods} payout method(s) and ${snapshots} withdrawal snapshot(s).` +
      (unreadable ? ` ${unreadable} value(s) could not be read with either key — investigate.` : ""),
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
