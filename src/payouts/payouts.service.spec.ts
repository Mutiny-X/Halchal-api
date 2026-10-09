import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { computeWithdrawalFeePaise } from "../common/withdrawal-rules";
import { PayoutsService } from "./payouts.service";

const USER = "user-1";
const METHOD = {
  id: "pm-1",
  userId: USER,
  type: "bank",
  label: "HDFC Bank",
  accountHolderName: "Ravi Kumar",
  accountNumber: "iv.tag.cipher",
  accountMasked: "•••• 7890",
  ifscCode: "HDFC0001234",
  bankName: "HDFC Bank",
  panNumber: "ABCPV1234D",
};

type Setup = {
  wallet?: { id: string; availablePaise: number; lifetimePaise: number } | null;
  open?: number;
  today?: number;
  existingByKey?: Record<string, unknown> | null;
  updateManyCount?: number;
  method?: typeof METHOD | null;
};

function build(setup: Setup = {}) {
  const wallet =
    setup.wallet === undefined
      ? { id: "w-1", availablePaise: 10_000_00, lifetimePaise: 10_000_00 }
      : setup.wallet;

  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    withdrawal: {
      findUnique: vi.fn().mockResolvedValue(setup.existingByKey ?? null),
      count: vi
        .fn()
        // First call: open withdrawals. Second call: requested today.
        .mockResolvedValueOnce(setup.open ?? 0)
        .mockResolvedValueOnce(setup.today ?? 0),
      create: vi.fn().mockImplementation(async ({ data }) => ({
        id: "wd-1",
        createdAt: new Date("2026-10-08T10:00:00Z"),
        processedAt: null,
        utr: null,
        failureReason: null,
        ...data,
      })),
    },
    wallet: {
      findUnique: vi.fn().mockResolvedValue(wallet),
      updateMany: vi.fn().mockResolvedValue({ count: setup.updateManyCount ?? 1 }),
    },
    transaction: { create: vi.fn().mockResolvedValue({}) },
  };

  const prisma = {
    payoutMethod: {
      findFirst: vi.fn().mockResolvedValue(setup.method === undefined ? METHOD : setup.method),
    },
    withdrawal: { findUnique: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
  };
  const config = { get: vi.fn((key: string) => (key === "WITHDRAWAL_FEE_BPS" ? 500 : "test-secret-value-1234")) };
  const notifications = { notifyAllAdmins: vi.fn(), create: vi.fn() };
  const activityLog = { log: vi.fn() };

  const service = new PayoutsService(
    prisma as never,
    config as never,
    notifications as never,
    activityLog as never,
  );
  return { service, prisma, tx, notifications };
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (err) {
    return (err as BadRequestException).getResponse
      ? ((err as BadRequestException).getResponse() as { code?: string }).code
      : undefined;
  }
  return undefined;
}

describe("PayoutsService.createWithdrawal", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a PENDING withdrawal — never completed — and debits the wallet", async () => {
    const { service, tx } = build();
    const out = await service.createWithdrawal(USER, { amountPaise: 1_000_00, payoutMethodId: "pm-1" });

    expect(out.status).toBe("pending");
    expect(tx.withdrawal.create.mock.calls[0][0].data.status).toBe("pending");
    expect(out.amountPaise).toBe(1_000_00);
    expect(out.feePaise).toBe(computeWithdrawalFeePaise(1_000_00, 500)); // 5%
    expect(out.netPaise).toBe(1_000_00 - 5_000);

    expect(tx.wallet.updateMany).toHaveBeenCalledWith({
      where: { id: "w-1", availablePaise: { gte: 1_000_00 } },
      data: { availablePaise: { decrement: 1_000_00 } },
    });
    expect(tx.transaction.create.mock.calls[0][0].data).toMatchObject({
      walletId: "w-1",
      type: "withdrawal_debit",
      amountPaise: 1_000_00,
      referenceId: "wd-1",
    });
  });

  it("locks the creator's wallet row before checking anything", async () => {
    const { service, tx } = build();
    await service.createWithdrawal(USER, { amountPaise: 500_00, payoutMethodId: "pm-1" });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("freezes the payment details onto the withdrawal, keeping the account number encrypted", async () => {
    const { service, tx } = build();
    await service.createWithdrawal(USER, { amountPaise: 500_00, payoutMethodId: "pm-1" });
    const snapshot = tx.withdrawal.create.mock.calls[0][0].data.payoutSnapshot;
    expect(snapshot).toMatchObject({
      type: "bank",
      accountHolderName: "Ravi Kumar",
      accountNumber: "iv.tag.cipher",
      ifscCode: "HDFC0001234",
      panNumber: "ABCPV1234D",
    });
  });

  it("rejects an amount that isn't one of the fixed denominations", async () => {
    const { service, tx } = build();
    expect(await codeOf(service.createWithdrawal(USER, { amountPaise: 2_000_00, payoutMethodId: "pm-1" }))).toBe(
      "WITHDRAWAL_AMOUNT_INVALID",
    );
    expect(tx.withdrawal.create).not.toHaveBeenCalled();
    expect(tx.wallet.updateMany).not.toHaveBeenCalled();
  });

  it("rejects until lifetime earnings reach ₹1,500", async () => {
    const { service, tx } = build({ wallet: { id: "w-1", availablePaise: 1_400_00, lifetimePaise: 1_400_00 } });
    expect(await codeOf(service.createWithdrawal(USER, { amountPaise: 500_00, payoutMethodId: "pm-1" }))).toBe(
      "WITHDRAWAL_LOCKED",
    );
    expect(tx.withdrawal.create).not.toHaveBeenCalled();
  });

  it("stays unlocked after earlier withdrawals drained the balance (lifetime is what counts)", async () => {
    const { service } = build({ wallet: { id: "w-1", availablePaise: 500_00, lifetimePaise: 5_000_00 } });
    const out = await service.createWithdrawal(USER, { amountPaise: 500_00, payoutMethodId: "pm-1" });
    expect(out.status).toBe("pending");
  });

  it("rejects while another withdrawal is pending or being paid", async () => {
    const { service, tx } = build({ open: 1 });
    expect(await codeOf(service.createWithdrawal(USER, { amountPaise: 500_00, payoutMethodId: "pm-1" }))).toBe(
      "WITHDRAWAL_OPEN_REQUEST",
    );
    expect(tx.withdrawal.create).not.toHaveBeenCalled();
  });

  it("rejects a second request on the same IST day", async () => {
    const { service } = build({ today: 1 });
    expect(await codeOf(service.createWithdrawal(USER, { amountPaise: 500_00, payoutMethodId: "pm-1" }))).toBe(
      "WITHDRAWAL_DAILY_LIMIT",
    );
  });

  it("rejects when the balance is short", async () => {
    const { service } = build({ wallet: { id: "w-1", availablePaise: 499_99, lifetimePaise: 5_000_00 } });
    expect(await codeOf(service.createWithdrawal(USER, { amountPaise: 500_00, payoutMethodId: "pm-1" }))).toBe(
      "WITHDRAWAL_INSUFFICIENT_BALANCE",
    );
  });

  it("rejects when the guarded decrement finds the balance gone (backstop to the row lock)", async () => {
    const { service } = build({ updateManyCount: 0 });
    expect(await codeOf(service.createWithdrawal(USER, { amountPaise: 500_00, payoutMethodId: "pm-1" }))).toBe(
      "WITHDRAWAL_INSUFFICIENT_BALANCE",
    );
  });

  it("404s on a payout method that isn't the creator's", async () => {
    const { service } = build({ method: null });
    await expect(service.createWithdrawal(USER, { amountPaise: 500_00, payoutMethodId: "pm-x" })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("replays an idempotent retry without creating or debiting again", async () => {
    const existing = {
      id: "wd-old",
      userId: USER,
      amountPaise: 500_00,
      feePaise: 2_500,
      netPaise: 47_500,
      status: "pending",
      createdAt: new Date(),
      processedAt: null,
      utr: null,
      failureReason: null,
      payoutSnapshot: null,
    };
    const { service, tx, notifications } = build({ existingByKey: existing });
    const out = await service.createWithdrawal(USER, {
      amountPaise: 500_00,
      payoutMethodId: "pm-1",
      idempotencyKey: "k1",
    });
    expect(out.id).toBe("wd-old");
    expect(tx.withdrawal.create).not.toHaveBeenCalled();
    expect(tx.wallet.updateMany).not.toHaveBeenCalled();
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it("refuses an idempotency key that belongs to another creator", async () => {
    const { service } = build({ existingByKey: { id: "wd-x", userId: "someone-else" } });
    await expect(
      service.createWithdrawal(USER, { amountPaise: 500_00, payoutMethodId: "pm-1", idempotencyKey: "k1" }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("returns the winner's withdrawal when a concurrent request trips the unique key", async () => {
    const { service, prisma } = build();
    const winner = {
      id: "wd-win",
      userId: USER,
      amountPaise: 500_00,
      feePaise: 2_500,
      netPaise: 47_500,
      status: "pending",
      createdAt: new Date(),
      processedAt: null,
      utr: null,
      failureReason: null,
      payoutSnapshot: null,
    };
    prisma.$transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" }),
    );
    prisma.withdrawal.findUnique.mockResolvedValueOnce(winner);
    const out = await service.createWithdrawal(USER, {
      amountPaise: 500_00,
      payoutMethodId: "pm-1",
      idempotencyKey: "k1",
    });
    expect(out.id).toBe("wd-win");
  });

  it("tells the creator and the admins about a new request", async () => {
    const { service, notifications } = build();
    await service.createWithdrawal(USER, { amountPaise: 500_00, payoutMethodId: "pm-1" });
    expect(notifications.notifyAllAdmins).toHaveBeenCalledTimes(1);
    expect(notifications.create).toHaveBeenCalledWith(
      USER,
      "creator",
      expect.objectContaining({ type: "withdrawal_requested" }),
    );
  });
});

describe("withdrawal fee", () => {
  it("applies the configured basis points to the withdrawal amount", () => {
    expect(computeWithdrawalFeePaise(1_000_000, 150)).toBe(15_000);
    expect(computeWithdrawalFeePaise(500_00, 500)).toBe(2_500);
  });
});
