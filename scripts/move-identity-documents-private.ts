/**
 * One-off: moves existing KYC / PAN / Aadhaar documents out of the PUBLIC bucket
 * into the private one (S3_PRIVATE_BUCKET), and repoints the database at them.
 *
 * For each document: copy to the private bucket → check it arrived → save
 * "private:<key>" in the database → only then delete the public original. If
 * anything fails the public copy is left alone, so nothing is ever lost, and
 * re-running picks up where it stopped. Pass --dry-run to just list what would move.
 *
 * Needs the same S3_* variables as the API, plus S3_PRIVATE_BUCKET. Create that
 * bucket first, with NO public access (no custom domain, no r2.dev link).
 *
 * Usage:
 *   pnpm exec tsx scripts/move-identity-documents-private.ts [--dry-run]
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const dryRun = process.argv.includes("--dry-run");

const FOLDERS = ["kyc-documents", "pan-documents", "aadhaar-documents"] as const;
const COLUMNS = ["kycDocumentUrl", "panDocumentUrl", "aadhaarDocumentUrl"] as const;
type Column = (typeof COLUMNS)[number];

function need(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} before running this script.`);
  return value;
}

async function main(): Promise<void> {
  const publicBucket = need("S3_BUCKET");
  const privateBucket = need("S3_PRIVATE_BUCKET");
  if (publicBucket === privateBucket) throw new Error("S3_PRIVATE_BUCKET must be a different bucket from S3_BUCKET.");
  const publicBase = need("S3_PUBLIC_BASE_URL").replace(/\/$/, "");

  const s3 = new S3Client({
    region: process.env.S3_REGION || "auto",
    endpoint: need("S3_ENDPOINT"),
    credentials: { accessKeyId: need("S3_ACCESS_KEY_ID"), secretAccessKey: need("S3_SECRET_ACCESS_KEY") },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });

  let moved = 0;
  let skipped = 0;
  let failed = 0;

  const users = await prisma.user.findMany({
    where: { OR: COLUMNS.map((c) => ({ [c]: { not: null } })) },
    select: { id: true, kycDocumentUrl: true, panDocumentUrl: true, aadhaarDocumentUrl: true },
  });

  for (const user of users) {
    for (const column of COLUMNS) {
      const url = user[column as Column];
      if (!url || url.startsWith("private:")) continue;
      if (!url.startsWith(`${publicBase}/`)) {
        skipped++; // a local-disk path or another host — not ours to move
        continue;
      }
      const key = decodeURIComponent(url.slice(publicBase.length + 1).split(/[?#]/)[0]!);
      const [folder, name, ...rest] = key.split("/");
      if (rest.length || !name || !FOLDERS.includes(folder as (typeof FOLDERS)[number])) {
        skipped++;
        continue;
      }
      if (dryRun) {
        console.log(`[dry run] would move ${column} of user ${user.id}: ${key}`);
        moved++;
        continue;
      }
      try {
        const original = await s3.send(new GetObjectCommand({ Bucket: publicBucket, Key: key }));
        const body = Buffer.from(await original.Body!.transformToByteArray());
        await s3.send(
          new PutObjectCommand({
            Bucket: privateBucket,
            Key: key,
            Body: body,
            ContentType: original.ContentType,
            CacheControl: "private, no-store",
          }),
        );
        const head = await s3.send(new HeadObjectCommand({ Bucket: privateBucket, Key: key }));
        if (head.ContentLength !== body.length) throw new Error("copy size does not match the original");
        await prisma.user.update({ where: { id: user.id }, data: { [column]: `private:${key}` } });
        await s3.send(new DeleteObjectCommand({ Bucket: publicBucket, Key: key }));
        moved++;
      } catch (error) {
        failed++;
        console.error(`Could not move ${column} of user ${user.id} (${key}); the public copy was left in place:`, error);
      }
    }
  }

  console.log(
    `${dryRun ? "[dry run] Would move" : "Moved"} ${moved} document(s); skipped ${skipped} that are not in the public bucket${failed ? `; ${failed} FAILED — see above` : ""}.`,
  );
  if (failed) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
