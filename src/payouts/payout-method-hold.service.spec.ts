import { BadRequestException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PayoutsService } from "./payouts.service";

const USER = "user-1";
const HOUR = 60 * 60 * 1000;

function method(overrides: Record<string, unknown> = {}) {
  return {
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
    isDefault: true,
    createdAt: new Date(Date.now() - 400 * HOUR),
    detailsChangedAt: new Date(Date.now() - 400 * HOUR),
    ...overrides,
  };
}

function build(opts: { holdHours?: number; stored?: ReturnType<typeof method> } = {}) {
  const stored = opts.stored ?? method();
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    withdrawal: {
      findUnique: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockImplementation(async ({ data }) => ({
        id: "wd-1",
        createdAt: new Date(),
        processedAt: null,
        utr: null,
        failureReason: null,
        ...data,
      })),
    },
    wallet: {
      findUnique: vi.fn().mockResolvedValue({ id: "w-1", availablePaise: 10_000_00, lifetimePaise: 10_000_00 }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    transaction: { create: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    payoutMethod: {
      findFirst: vi.fn().mockResolvedValue(stored),
      count: vi.fn().mockResolvedValue(1),
      create: vi.fn().mockImplementation(async ({ data }) => ({ ...method(), ...data, id: "pm-new" })),
      update: vi.fn().mockImplementation(async ({ data }) => ({ ...stored, ...data })),
    },
    $transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
  };
  const config = {
    get: vi.fn((key: string) => {
      if (key === "WITHDRAWAL_FEE_BPS") return 500;
      if (key === "PAYOUT_METHOD_COOLDOWN_HOURS") return opts.holdHours ?? 24;
      return "test-secret-value-0123456789-abcdefgh";
    }),
  };
  const notifications = { notifyAllAdmins: vi.fn(), create: vi.fn() };
  const service = new PayoutsService(prisma as never, config as never, notifications as never, { log: vi.fn() } as never);
  return { service, prisma, tx, notifications };
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    return err as BadRequestException;
  }
  return undefined;
}

describe("withdrawing to freshly changed bank details", () => {
  beforeEach(() => vi.clearAllMocks());
  const request = { amountPaise: 500_00, payoutMethodId: "pm-1" };

  it("is held while the cooling-off period runs, and nothing is debited", async () => {
    const { service, prisma } = build({ stored: method({ detailsChangedAt: new Date(Date.now() - 2 * HOUR) }) });
    const err = await rejection(service.createWithdrawal(USER, request));
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err!.getResponse() as { code: string }).code).toBe("PAYOUT_METHOD_ON_HOLD");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("tells the creator when it opens", async () => {
    const { service } = build({ stored: method({ detailsChangedAt: new Date(Date.now() - 2 * HOUR) }) });
    const err = await rejection(service.createWithdrawal(USER, request));
    expect((err!.getResponse() as { message: string }).message).toMatch(/open on \d{1,2} [A-Za-z]{3}/);
  });

  it("is allowed once the period has passed", async () => {
    const { service, tx } = build({ stored: method({ detailsChangedAt: new Date(Date.now() - 25 * HOUR) }) });
    await service.createWithdrawal(USER, request);
    expect(tx.withdrawal.create).toHaveBeenCalledTimes(1);
  });

  it("can be switched off", async () => {
    const { service, tx } = build({ holdHours: 0, stored: method({ detailsChangedAt: new Date() }) });
    await service.createWithdrawal(USER, request);
    expect(tx.withdrawal.create).toHaveBeenCalledTimes(1);
  });

  it("does not lock out a long-standing method", async () => {
    const { service, tx } = build();
    await service.createWithdrawal(USER, request);
    expect(tx.withdrawal.create).toHaveBeenCalledTimes(1);
  });
});

describe("changing bank details", () => {
  beforeEach(() => vi.clearAllMocks());

  const dto = {
    type: "bank" as const,
    label: "HDFC Bank",
    accountHolderName: "Ravi Kumar",
    account: "123456789012",
    ifscCode: "HDFC0001234",
    bankName: "HDFC Bank",
    panNumber: "ABCPV1234D",
  };

  it("adding a method notifies the creator and mentions the hold", async () => {
    const { service, notifications } = build();
    await service.createPayoutMethod(USER, dto as never);
    expect(notifications.create).toHaveBeenCalledTimes(1);
    const [, , payload] = notifications.create.mock.calls[0];
    expect(payload).toMatchObject({ type: "payout_method_changed", title: "Bank details added" });
    expect(payload.body).toMatch(/24 hours/);
    expect(payload.body).toMatch(/wasn't you/);
  });

  it("changing the IFSC restarts the hold and notifies", async () => {
    const { service, prisma, notifications } = build();
    await service.updatePayoutMethod(USER, "pm-1", { ifscCode: "SBIN0004321" } as never);
    expect(prisma.payoutMethod.update.mock.calls[0][0].data.detailsChangedAt).toBeInstanceOf(Date);
    expect(notifications.create).toHaveBeenCalledTimes(1);
  });

  it("changing the holder name, bank name or PAN each restart the hold", async () => {
    for (const change of [{ accountHolderName: "Someone Else" }, { bankName: "SBI" }, { panNumber: "ZZZZZ9999Z" }]) {
      const { service, prisma } = build();
      await service.updatePayoutMethod(USER, "pm-1", change as never);
      expect(prisma.payoutMethod.update.mock.calls[0][0].data.detailsChangedAt).toBeInstanceOf(Date);
    }
  });

  it("a relabel, or re-saving identical values, does not restart the hold or notify", async () => {
    const { service, prisma, notifications } = build();
    await service.updatePayoutMethod(USER, "pm-1", { label: "Salary account" } as never);
    await service.updatePayoutMethod(USER, "pm-1", { ifscCode: "HDFC0001234", bankName: "HDFC Bank" } as never);
    for (const call of prisma.payoutMethod.update.mock.calls) {
      expect(call[0].data).not.toHaveProperty("detailsChangedAt");
    }
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it("omits the hold sentence from the notification when the hold is off", async () => {
    const { service, notifications } = build({ holdHours: 0 });
    await service.createPayoutMethod(USER, dto as never);
    expect(notifications.create.mock.calls[0][2].body).not.toMatch(/hour/);
  });
});
