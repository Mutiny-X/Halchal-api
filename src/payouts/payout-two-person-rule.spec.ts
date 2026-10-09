import { ForbiddenException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { WithdrawalFulfilmentService } from "./withdrawal-fulfilment.service";

function build(opts: { rule: boolean; exportedBy: string | null }) {
  const paidRow = { id: "wd-1", userId: "u-1", netPaise: 950_00, status: "completed", utr: "UTR1", amountPaise: 1_000_00 };
  const prisma = {
    withdrawal: {
      findUnique: vi.fn().mockResolvedValue({ batch: opts.exportedBy ? { createdByUserId: opts.exportedBy } : null }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: vi.fn().mockResolvedValue(paidRow),
    },
    $transaction: vi.fn(async (cb: (t: unknown) => unknown) => cb({})),
  };
  const config = { get: vi.fn((key: string) => (key === "PAYOUT_REQUIRE_SECOND_ADMIN" ? opts.rule : "x".repeat(40))) };
  const service = new WithdrawalFulfilmentService(
    prisma as never,
    config as never,
    { create: vi.fn() } as never,
    { log: vi.fn() } as never,
  );
  return { service, prisma };
}

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as ForbiddenException).getResponse && ((e as ForbiddenException).getResponse() as { code?: string }).code;
  }
  return undefined;
};

describe("two-person rule for payments (PAYOUT_REQUIRE_SECOND_ADMIN)", () => {
  it("the admin who exported the sheet can't mark its rows paid", async () => {
    const { service, prisma } = build({ rule: true, exportedBy: "admin-1" });
    expect(await codeOf(service.markPaid("wd-1", "UTR123", "admin-1"))).toBe("SECOND_ADMIN_REQUIRED");
    expect(prisma.withdrawal.updateMany).not.toHaveBeenCalled();
  });

  it("…or mark them failed", async () => {
    const { service, prisma } = build({ rule: true, exportedBy: "admin-1" });
    expect(await codeOf(service.markFailed("wd-1", "wrong account", "admin-1"))).toBe("SECOND_ADMIN_REQUIRED");
    expect(prisma.withdrawal.updateMany).not.toHaveBeenCalled();
  });

  it("a different admin can", async () => {
    const { service, prisma } = build({ rule: true, exportedBy: "admin-1" });
    await service.markPaid("wd-1", "UTR123", "admin-2");
    expect(prisma.withdrawal.updateMany).toHaveBeenCalledTimes(1);
  });

  it("is not in force unless switched on", async () => {
    const { service, prisma } = build({ rule: false, exportedBy: "admin-1" });
    await service.markPaid("wd-1", "UTR123", "admin-1");
    expect(prisma.withdrawal.updateMany).toHaveBeenCalledTimes(1);
  });

  it("does not block a withdrawal that was never put on a sheet", async () => {
    const { service, prisma } = build({ rule: true, exportedBy: null });
    await service.markPaid("wd-1", "UTR123", "admin-1");
    expect(prisma.withdrawal.updateMany).toHaveBeenCalledTimes(1);
  });
});
