import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { encryptPayoutAccount, derivePayoutKey } from "./payout-account-crypto";
import { WithdrawalFulfilmentService } from "./withdrawal-fulfilment.service";

const SECRET = "test-secret-value-1234";
const ACCOUNT = "001234567890";

function withdrawal(overrides: Record<string, unknown> = {}) {
  return {
    id: "wd-1",
    userId: "u-1",
    amountPaise: 1_000_00,
    feePaise: 5_000,
    netPaise: 950_00,
    status: "pending",
    batchId: null,
    exportedAt: null,
    processedAt: null,
    utr: null,
    failureReason: null,
    createdAt: new Date("2026-10-08T10:00:00Z"),
    payoutSnapshot: {
      type: "bank",
      label: "HDFC Bank",
      accountHolderName: "Ravi Kumar",
      accountNumber: encryptPayoutAccount(derivePayoutKey(SECRET), ACCOUNT),
      accountMasked: "•••• 7890",
      ifscCode: "HDFC0001234",
      bankName: "HDFC Bank",
      panNumber: "ABCPV1234D",
    },
    user: { id: "u-1", displayName: "Ravi", username: null, email: "r@x.com", phone: "+911234567890" },
    ...overrides,
  };
}

function build() {
  const tx = {
    withdrawal: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: vi.fn().mockResolvedValue(withdrawal()),
    },
    withdrawalBatch: {
      create: vi.fn().mockImplementation(async ({ data }) => ({
        id: "batch-abcdef",
        createdAt: new Date("2026-10-08T12:00:00Z"),
        ...data,
      })),
    },
    wallet: {
      upsert: vi.fn().mockResolvedValue({ id: "w-1" }),
      update: vi.fn().mockResolvedValue({}),
    },
    transaction: { create: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    withdrawal: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn().mockResolvedValue(null),
      findUniqueOrThrow: vi.fn().mockResolvedValue(withdrawal({ status: "completed", utr: "UTR1" })),
      findMany: vi.fn().mockResolvedValue([]),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    withdrawalBatch: { findUnique: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
  };
  const config = { get: vi.fn((key: string) => (key === "PAYOUT_ACCOUNT_ENCRYPTION_KEY" ? SECRET : "jwt")) };
  const notifications = { create: vi.fn() };
  const activityLog = { log: vi.fn() };
  const service = new WithdrawalFulfilmentService(
    prisma as never,
    config as never,
    notifications as never,
    activityLog as never,
  );
  return { service, prisma, tx, notifications, activityLog };
}

async function readSheet(buffer: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  return wb.getWorksheet("Payments")!;
}

describe("exportPending", () => {
  beforeEach(() => vi.clearAllMocks());

  it("404s when there is nothing new to export, and creates no batch", async () => {
    const { service, tx } = build();
    await expect(service.exportPending("admin-1")).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.withdrawalBatch.create).not.toHaveBeenCalled();
  });

  it("builds a sheet with the DECRYPTED account number and moves rows to processing", async () => {
    const { service, tx, activityLog } = build();
    tx.withdrawal.findMany.mockResolvedValue([withdrawal(), withdrawal({ id: "wd-2", netPaise: 475_00 })]);
    tx.withdrawal.updateMany.mockResolvedValue({ count: 2 });

    const out = await service.exportPending("admin-1");

    expect(out.rowCount).toBe(2);
    expect(out.filename).toMatch(/^halchal-payments-\d{4}-\d{2}-\d{2}-abcdef\.xlsx$/);

    const ws = await readSheet(out.buffer);
    expect(ws.getRow(2).getCell(8).value).toBe(ACCOUNT);
    expect(ws.getRow(2).getCell(12).value).toBe(950);
    expect(ws.getRow(3).getCell(12).value).toBe(475);

    expect(tx.withdrawal.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["wd-1", "wd-2"] }, status: "pending" },
      data: expect.objectContaining({ status: "processing", batchId: "batch-abcdef" }),
    });
    expect(tx.withdrawalBatch.create.mock.calls[0][0].data).toMatchObject({
      createdByUserId: "admin-1",
      rowCount: 2,
      totalNetPaise: 950_00 + 475_00,
    });
    expect(activityLog.log).toHaveBeenCalledWith(
      "admin-1",
      "admin.withdrawals.exported",
      expect.objectContaining({ targetId: "batch-abcdef" }),
    );
  });

  it("only exports pending rows (the query asks for nothing else)", async () => {
    const { service, tx } = build();
    tx.withdrawal.findMany.mockResolvedValue([withdrawal()]);
    await service.exportPending("admin-1");
    expect(tx.withdrawal.findMany.mock.calls[0][0].where).toEqual({ status: "pending" });
  });

  it("aborts with a conflict if rows changed underneath it, so nothing is half-exported", async () => {
    const { service, tx } = build();
    tx.withdrawal.findMany.mockResolvedValue([withdrawal(), withdrawal({ id: "wd-2" })]);
    tx.withdrawal.updateMany.mockResolvedValue({ count: 1 });
    await expect(service.exportPending("admin-1")).rejects.toBeInstanceOf(ConflictException);
  });

  it("flags an undecryptable account instead of exporting garbage", async () => {
    const { service, tx } = build();
    tx.withdrawal.findMany.mockResolvedValue([
      withdrawal({ payoutSnapshot: { ...withdrawal().payoutSnapshot, accountNumber: "a.b.c" } }),
    ]);
    const out = await service.exportPending("admin-1");
    const ws = await readSheet(out.buffer);
    expect(String(ws.getRow(2).getCell(8).value)).toMatch(/UNREADABLE/);
  });
});

describe("markPaid", () => {
  beforeEach(() => vi.clearAllMocks());

  it("completes an open withdrawal, records the UTR and notifies the creator", async () => {
    const { service, prisma, notifications, activityLog } = build();
    await service.markPaid("wd-1", "  UTR123  ", "admin-1");

    expect(prisma.withdrawal.updateMany).toHaveBeenCalledWith({
      where: { id: "wd-1", status: { in: ["pending", "processing"] } },
      data: expect.objectContaining({ status: "completed", utr: "UTR123", resolvedByUserId: "admin-1" }),
    });
    expect(notifications.create).toHaveBeenCalledWith(
      "u-1",
      "creator",
      expect.objectContaining({ type: "withdrawal_paid", sendWhatsapp: true }),
    );
    expect(activityLog.log).toHaveBeenCalledWith("admin-1", "admin.withdrawal.marked_paid", expect.anything());
  });

  it("requires a UTR", async () => {
    const { service, prisma } = build();
    await expect(service.markPaid("wd-1", "   ", "admin-1")).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.withdrawal.updateMany).not.toHaveBeenCalled();
  });

  it("is idempotent for the same UTR — no second notification", async () => {
    const { service, prisma, notifications } = build();
    prisma.withdrawal.updateMany.mockResolvedValue({ count: 0 });
    prisma.withdrawal.findUnique.mockResolvedValue(withdrawal({ status: "completed", utr: "UTR1" }));
    const out = await service.markPaid("wd-1", "UTR1", "admin-1");
    expect(out.alreadyDone).toBe(true);
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it("refuses to pay a withdrawal that already failed (it was refunded)", async () => {
    const { service, prisma } = build();
    prisma.withdrawal.updateMany.mockResolvedValue({ count: 0 });
    prisma.withdrawal.findUnique.mockResolvedValue(withdrawal({ status: "failed" }));
    await expect(service.markPaid("wd-1", "UTR1", "admin-1")).rejects.toBeInstanceOf(ConflictException);
  });

  it("refuses a different UTR on an already-paid withdrawal", async () => {
    const { service, prisma } = build();
    prisma.withdrawal.updateMany.mockResolvedValue({ count: 0 });
    prisma.withdrawal.findUnique.mockResolvedValue(withdrawal({ status: "completed", utr: "UTR1" }));
    await expect(service.markPaid("wd-1", "OTHER", "admin-1")).rejects.toBeInstanceOf(ConflictException);
  });

  it("404s on an unknown withdrawal", async () => {
    const { service, prisma } = build();
    prisma.withdrawal.updateMany.mockResolvedValue({ count: 0 });
    prisma.withdrawal.findUnique.mockResolvedValue(null);
    await expect(service.markPaid("nope", "U1", "admin-1")).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("markFailed", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refunds the FULL amount (fee included) to availablePaise only — never lifetimePaise", async () => {
    const { service, tx } = build();
    await service.markFailed("wd-1", "Account closed", "admin-1");

    const update = tx.wallet.update.mock.calls[0][0];
    expect(update.data).toEqual({ availablePaise: { increment: 1_000_00 } });
    expect(update.data).not.toHaveProperty("lifetimePaise");

    expect(tx.transaction.create.mock.calls[0][0].data).toMatchObject({
      walletId: "w-1",
      type: "withdrawal_refund",
      amountPaise: 1_000_00,
      referenceId: "wd-1",
    });
  });

  it("marks the withdrawal failed with the reason, and notifies the creator", async () => {
    const { service, tx, notifications } = build();
    await service.markFailed("wd-1", "Account closed", "admin-1");
    expect(tx.withdrawal.updateMany.mock.calls[0][0].data).toMatchObject({
      status: "failed",
      failureReason: "Account closed",
      resolvedByUserId: "admin-1",
    });
    expect(notifications.create).toHaveBeenCalledWith(
      "u-1",
      "creator",
      expect.objectContaining({ type: "withdrawal_failed" }),
    );
  });

  it("refunds exactly once: a second attempt on a resolved withdrawal changes nothing", async () => {
    const { service, tx, prisma, notifications } = build();
    tx.withdrawal.updateMany.mockResolvedValue({ count: 0 });
    prisma.withdrawal.findUnique.mockResolvedValue(withdrawal({ status: "failed" }));
    await expect(service.markFailed("wd-1", "again", "admin-1")).rejects.toBeInstanceOf(ConflictException);
    expect(tx.wallet.update).not.toHaveBeenCalled();
    expect(tx.transaction.create).not.toHaveBeenCalled();
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it("cannot fail a withdrawal that was already paid", async () => {
    const { service, tx, prisma } = build();
    tx.withdrawal.updateMany.mockResolvedValue({ count: 0 });
    prisma.withdrawal.findUnique.mockResolvedValue(withdrawal({ status: "completed", utr: "U1" }));
    await expect(service.markFailed("wd-1", "oops", "admin-1")).rejects.toBeInstanceOf(ConflictException);
    expect(tx.wallet.update).not.toHaveBeenCalled();
  });

  it("requires a reason", async () => {
    const { service, tx } = build();
    await expect(service.markFailed("wd-1", " ", "admin-1")).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.withdrawal.updateMany).not.toHaveBeenCalled();
  });
});

describe("importResults", () => {
  beforeEach(() => vi.clearAllMocks());

  async function sheetWith(rows: Array<{ id: string; amount?: number; paid?: string; utr?: string; remarks?: string }>) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Payments");
    ws.addRow(["Withdrawal ID", "Amount to pay (₹)", "Paid? (Y/N)", "UTR / reference", "Remarks"]);
    for (const r of rows) ws.addRow([r.id, r.amount ?? 950, r.paid ?? "", r.utr ?? "", r.remarks ?? ""]);
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  it("applies paid and failed rows and reports a summary", async () => {
    const { service, prisma, tx } = build();
    prisma.withdrawal.findMany.mockResolvedValue([
      { id: "wd-1", netPaise: 950_00 },
      { id: "wd-2", netPaise: 950_00 },
      { id: "wd-3", netPaise: 950_00 },
    ]);
    const buf = await sheetWith([
      { id: "wd-1", paid: "Y", utr: "U1" },
      { id: "wd-2", paid: "N", remarks: "Bad IFSC" },
      { id: "wd-3" }, // still waiting
    ]);

    const out = await service.importResults(buf, "admin-1");

    expect(out.summary).toEqual({ paid: 1, failed: 1, skipped: 1, errors: 0 });
    expect(prisma.withdrawal.updateMany).toHaveBeenCalledTimes(1); // wd-1 paid
    expect(tx.withdrawal.updateMany).toHaveBeenCalledTimes(1); // wd-2 failed (+refund)
    expect(tx.wallet.update).toHaveBeenCalledTimes(1);
  });

  it("rejects a row whose amount differs from the withdrawal's net amount", async () => {
    const { service, prisma } = build();
    prisma.withdrawal.findMany.mockResolvedValue([{ id: "wd-1", netPaise: 950_00 }]);
    const out = await service.importResults(await sheetWith([{ id: "wd-1", amount: 9500, paid: "Y", utr: "U1" }]), "admin-1");
    expect(out.summary.errors).toBe(1);
    expect(out.results[0].message).toMatch(/doesn't match/);
    expect(prisma.withdrawal.updateMany).not.toHaveBeenCalled();
  });

  it("reports an unknown withdrawal ID without touching anything", async () => {
    const { service, prisma } = build();
    prisma.withdrawal.findMany.mockResolvedValue([]);
    const out = await service.importResults(await sheetWith([{ id: "ghost", paid: "Y", utr: "U1" }]), "admin-1");
    expect(out.results[0]).toMatchObject({ result: "error", message: "No withdrawal with this ID." });
    expect(prisma.withdrawal.updateMany).not.toHaveBeenCalled();
  });

  it("keeps going after one row errors", async () => {
    const { service, prisma } = build();
    prisma.withdrawal.findMany.mockResolvedValue([
      { id: "wd-1", netPaise: 950_00 },
      { id: "wd-2", netPaise: 950_00 },
    ]);
    prisma.withdrawal.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
    prisma.withdrawal.findUnique.mockResolvedValue(withdrawal({ status: "failed" }));
    const out = await service.importResults(
      await sheetWith([
        { id: "wd-1", paid: "Y", utr: "U1" }, // already failed -> conflict
        { id: "wd-2", paid: "Y", utr: "U2" },
      ]),
      "admin-1",
    );
    expect(out.results.map((r) => r.result)).toEqual(["error", "paid"]);
  });

  it("rejects a file that isn't a payment sheet", async () => {
    const { service } = build();
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("x").addRow(["a", "b"]);
    await expect(service.importResults(Buffer.from(await wb.xlsx.writeBuffer()), "admin-1")).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe("list", () => {
  it("never exposes a full account number", async () => {
    const { service, prisma } = build();
    prisma.withdrawal.findMany.mockResolvedValue([withdrawal()]);
    const out = await service.list({});
    const json = JSON.stringify(out);
    expect(json).not.toContain(ACCOUNT);
    expect(json).not.toContain("accountNumber");
    expect(out.items[0].method.accountMasked).toBe("•••• 7890");
  });

  it("returns counts for all four statuses even when some are empty", async () => {
    const { service, prisma } = build();
    prisma.withdrawal.groupBy.mockResolvedValue([{ status: "pending", _count: { _all: 3 }, _sum: { netPaise: 300_00 } }]);
    const out = await service.list({});
    expect(out.counts.pending).toEqual({ count: 3, netPaise: 300_00 });
    expect(out.counts.completed).toEqual({ count: 0, netPaise: 0 });
  });
});
