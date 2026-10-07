import { PrismaClient, UserRole } from "@prisma/client";

const prisma = new PrismaClient();

/** Dev-only creators for mobile auth testing. OTP is always 000000 when seeded. */
const DEMO_OTP = "000000";

const demoCreators = [
  {
    phone: "+919876543210",
    displayName: "Demo Creator",
    email: "demo@halchal.test",
    username: "demo_creator",
    profileHandle: "demo_creator",
  },
  {
    phone: "+919876543211",
    displayName: "Test Creator",
    email: "test@halchal.test",
    username: "test_creator",
    profileHandle: "test_creator",
  },
] as const;

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Refusing to seed demo creators (with a known, fixed OTP) into a " +
        "production database. Unset NODE_ENV or run this against a " +
        "non-production DATABASE_URL instead.",
    );
  }

  for (const creator of demoCreators) {
    const user = await prisma.user.upsert({
      where: { phone: creator.phone },
      create: {
        role: UserRole.creator,
        phone: creator.phone,
        displayName: creator.displayName,
        email: creator.email,
        username: creator.username,
        fixedOtpCode: DEMO_OTP,
        wallet: { create: {} },
      },
      update: {
        role: UserRole.creator,
        displayName: creator.displayName,
        email: creator.email,
        username: creator.username,
        fixedOtpCode: DEMO_OTP,
      },
    });

    await prisma.creatorProfile.upsert({
      where: {
        userId_platform_handle: {
          userId: user.id,
          platform: "instagram",
          handle: creator.profileHandle,
        },
      },
      create: {
        userId: user.id,
        platform: "instagram",
        handle: creator.profileHandle,
        label: creator.displayName,
        isDefault: true,
      },
      update: {
        label: creator.displayName,
        isDefault: true,
      },
    });
  }

  console.log(
    `Seeded ${demoCreators.length} demo creators (OTP ${DEMO_OTP}):\n` +
      demoCreators.map((c) => `  ${c.phone} — ${c.displayName}`).join("\n"),
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
