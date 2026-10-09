import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma, WithdrawalStatus } from "@prisma/client";

import { ActivityLogService } from "../activity/activity-log.service";
import type { Env } from "../config/env";
import { InAppNotificationService } from "../notifications/in-app-notification.service";
import { PrismaService } from "../prisma/prisma.service";
import { decryptPayoutAccount, derivePayoutKey } from "./payout-account-crypto";
import type { PayoutSnapshot } from "./payouts.service";
import {
  buildWithdrawalWorkbook,
  parseResultWorkbook,
  type SheetRow,
} from "./withdrawal-sheet";

const OPEN_STATUSES: WithdrawalStatus[] = [WithdrawalStatus.pending, WithdrawalStatus.processing];

const creatorSelect = { id: true, displayName: true, username: true, email: true, phone: true } as const;

type WithdrawalWithCreator = Prisma.WithdrawalGetPayload<{ include: { user: { select: typeof creatorSelect } } }>;

export type ImportRowResult = {
  row: number;
  withdrawalId: string;
  result: "paid" | "failed" | "skipped" | "error";
  message?: string;
};

function creatorName(u: { displayName: string | null; username: string | null }): string {
  return u.displayName ?? u.username ?? "Creator";
}

/** The admin-side half of the manual payout process: build the payment sheet,
 * record what the accounts team did, and refund anything that failed. */
@Injectable()
export class WithdrawalFulfilmentService {
  private readonly logger = new Logger(WithdrawalFulfilmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly notifications: InAppNotificationService,
    private readonly activityLog: ActivityLogService,
  ) {}

  private get encryptionKey(): Buffer {
    return derivePayoutKey(
      this.config.get("PAYOUT_ACCOUNT_ENCRYPTION_KEY", { infer: true }) ??
        this.config.get("JWT_SECRET", { infer: true }),
    );
  }

  // ── Listing ────────────────────────────────────────────────────────────

  async list(opts: { status?: WithdrawalStatus; limit?: number; cursor?: string }) {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const where: Prisma.WithdrawalWhereInput = opts.status ? { status: opts.status } : {};

    const [rows, grouped] = await Promise.all([
      this.prisma.withdrawal.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
        include: { user: { select: creatorSelect } },
      }),
      this.prisma.withdrawal.groupBy({
        by: ["status"],
        _count: { _all: true },
        _sum: { netPaise: true },
      }),
    ]);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const counts: Record<string, { count: number; netPaise: number }> = {
      pending: { count: 0, netPaise: 0 },
      processing: { count: 0, netPaise: 0 },
      completed: { count: 0, netPaise: 0 },
      failed: { count: 0, netPaise: 0 },
    };
    for (const g of grouped) {
      counts[g.status] = { count: g._count._all, netPaise: g._sum.netPaise ?? 0 };
    }

    return {
      items: page.map((w) => this.formatRow(w)),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
      counts,
    };
  }

  private formatRow(w: WithdrawalWithCreator) {
    const snapshot = (w.payoutSnapshot ?? null) as Partial<PayoutSnapshot> | null;
    return {
      id: w.id,
      createdAt: w.createdAt.toISOString(),
      creator: {
        id: w.user.id,
        name: creatorName(w.user),
        phone: w.user.phone ?? null,
        email: w.user.email ?? null,
      },
      amountPaise: w.amountPaise,
      feePaise: w.feePaise,
      netPaise: w.netPaise,
      status: w.status,
      batchId: w.batchId ?? null,
      exportedAt: w.exportedAt?.toISOString() ?? null,
      processedAt: w.processedAt?.toISOString() ?? null,
      utr: w.utr ?? null,
      failureReason: w.failureReason ?? null,
      // Masked only — full numbers appear solely in the downloaded sheet.
      method: {
        type: snapshot?.type ?? null,
        label: snapshot?.label ?? null,
        accountMasked: snapshot?.accountMasked ?? null,
        bankName: snapshot?.bankName ?? null,
      },
    };
  }

  // ── Exporting the payment sheet ────────────────────────────────────────

  private toSheetRows(rows: WithdrawalWithCreator[]): SheetRow[] {
    return rows.map((w) => {
      const snapshot = (w.payoutSnapshot ?? null) as PayoutSnapshot | null;
      let account = "UNREADABLE - do not pay, contact Halchal";
      if (snapshot?.accountNumber) {
        try {
          account = decryptPayoutAccount(this.encryptionKey, snapshot.accountNumber) ?? account;
        } catch {
          this.logger.error(`Could not decrypt the account number for withdrawal ${w.id}`);
        }
      }
      return {
        withdrawalId: w.id,
        requestedAt: w.createdAt,
        creatorName: creatorName(w.user),
        creatorPhone: w.user.phone ?? "",
        creatorEmail: w.user.email ?? "",
        accountHolderName: snapshot?.accountHolderName ?? "",
        methodType: snapshot?.type ?? "",
        account,
        ifscCode: snapshot?.ifscCode ?? "",
        bankName: snapshot?.bankName ?? "",
        panNumber: snapshot?.panNumber ?? "",
        netPaise: w.netPaise,
      };
    });
  }

  /** Packs every not-yet-exported (pending) withdrawal into one sheet and
   * moves them to `processing`, so the next export can't include them again. */
  async exportPending(adminUserId: string) {
    const exported = await this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.withdrawal.findMany({
          where: { status: WithdrawalStatus.pending },
          orderBy: { createdAt: "asc" },
          include: { user: { select: creatorSelect } },
        });
        if (rows.length === 0) return null;

        const totalNetPaise = rows.reduce((s, r) => s + r.netPaise, 0);
        const batch = await tx.withdrawalBatch.create({
          data: { createdByUserId: adminUserId, rowCount: rows.length, totalNetPaise },
        });
        const { count } = await tx.withdrawal.updateMany({
          where: { id: { in: rows.map((r) => r.id) }, status: WithdrawalStatus.pending },
          data: { status: WithdrawalStatus.processing, batchId: batch.id, exportedAt: new Date() },
        });
        if (count !== rows.length) {
          // Someone else exported (or resolved) some of these while we were building.
          throw new ConflictException({
            code: "CONFLICT",
            message: "Withdrawals changed while exporting — try again.",
          });
        }

        // Built inside the transaction: if the sheet can't be produced, nothing
        // is marked as sent to accounts.
        const buffer = await buildWithdrawalWorkbook(
          this.toSheetRows(rows),
          `Halchal withdrawal payments — batch ${batch.id}`,
        );
        return { batch, buffer, withdrawalIds: rows.map((r) => r.id) };
      },
      { timeout: 30_000, maxWait: 10_000 },
    );

    if (!exported) {
      throw new NotFoundException({
        code: "NOT_FOUND",
        message: "No new withdrawal requests to export.",
      });
    }

    await this.activityLog.log(adminUserId, "admin.withdrawals.exported", {
      targetType: "withdrawal_batch",
      targetId: exported.batch.id,
      metadata: {
        count: exported.batch.rowCount,
        totalNetPaise: exported.batch.totalNetPaise,
        withdrawalIds: exported.withdrawalIds,
      },
    });

    return {
      buffer: exported.buffer,
      batchId: exported.batch.id,
      rowCount: exported.batch.rowCount,
      filename: `halchal-payments-${new Date().toISOString().slice(0, 10)}-${exported.batch.id.slice(-6)}.xlsx`,
    };
  }

  /** Re-creates an earlier batch's sheet (e.g. the file was lost). */
  async downloadBatch(batchId: string, adminUserId: string) {
    const batch = await this.prisma.withdrawalBatch.findUnique({
      where: { id: batchId },
      include: {
        withdrawals: {
          orderBy: { createdAt: "asc" },
          include: { user: { select: creatorSelect } },
        },
      },
    });
    if (!batch) {
      throw new NotFoundException({ code: "NOT_FOUND", message: "Batch not found" });
    }

    const buffer = await buildWithdrawalWorkbook(
      this.toSheetRows(batch.withdrawals),
      `Halchal withdrawal payments — batch ${batch.id} (re-download)`,
    );

    await this.activityLog.log(adminUserId, "admin.withdrawals.batch_downloaded", {
      targetType: "withdrawal_batch",
      targetId: batch.id,
      metadata: { count: batch.withdrawals.length },
    });

    return {
      buffer,
      filename: `halchal-payments-${batch.createdAt.toISOString().slice(0, 10)}-${batch.id.slice(-6)}.xlsx`,
    };
  }

  // ── Recording results ──────────────────────────────────────────────────

  private async explainNotOpen(id: string, wantStatus?: WithdrawalStatus, sameUtr?: string) {
    const existing = await this.prisma.withdrawal.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException({ code: "NOT_FOUND", message: "Withdrawal not found" });
    }
    if (wantStatus === WithdrawalStatus.completed && existing.status === wantStatus && existing.utr === sameUtr) {
      return { alreadyDone: true as const, withdrawal: existing };
    }
    throw new ConflictException({
      code: "CONFLICT",
      message: `This withdrawal is already ${existing.status} and can't be changed.`,
    });
  }

  async markPaid(withdrawalId: string, utrInput: string, adminUserId: string) {
    const utr = utrInput.trim();
    if (!utr) {
      throw new BadRequestException({ code: "VALIDATION_ERROR", message: "Enter the UTR / bank reference." });
    }

    const { count } = await this.prisma.withdrawal.updateMany({
      where: { id: withdrawalId, status: { in: OPEN_STATUSES } },
      data: {
        status: WithdrawalStatus.completed,
        utr,
        processedAt: new Date(),
        resolvedByUserId: adminUserId,
        failureReason: null,
      },
    });
    if (count === 0) {
      const outcome = await this.explainNotOpen(withdrawalId, WithdrawalStatus.completed, utr);
      return { id: withdrawalId, status: outcome.withdrawal.status, alreadyDone: true };
    }

    const withdrawal = await this.prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId } });

    await this.activityLog.log(adminUserId, "admin.withdrawal.marked_paid", {
      targetType: "withdrawal",
      targetId: withdrawalId,
      metadata: { creatorId: withdrawal.userId, netPaise: withdrawal.netPaise, utr },
    });

    await this.notifications.create(withdrawal.userId, "creator", {
      type: "withdrawal_paid",
      title: "Withdrawal paid",
      body: `₹${(withdrawal.netPaise / 100).toFixed(2)} has been sent to your account. Reference: ${utr}.`,
      link: "/wallet",
      sendWhatsapp: true,
    });

    return { id: withdrawalId, status: withdrawal.status, alreadyDone: false };
  }

  /** Marks a withdrawal as not paid and gives the money back to the wallet.
   * The refund restores availablePaise only — lifetimePaise counts earnings,
   * so a refund must never push a creator over the ₹1,500 gate. */
  async markFailed(withdrawalId: string, reasonInput: string, adminUserId: string) {
    const reason = reasonInput.trim();
    if (!reason) {
      throw new BadRequestException({ code: "VALIDATION_ERROR", message: "Say why the payment failed." });
    }

    const failed = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.withdrawal.updateMany({
        where: { id: withdrawalId, status: { in: OPEN_STATUSES } },
        data: {
          status: WithdrawalStatus.failed,
          failureReason: reason,
          processedAt: new Date(),
          resolvedByUserId: adminUserId,
        },
      });
      if (count === 0) return null;

      const withdrawal = await tx.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId } });
      const wallet = await tx.wallet.upsert({
        where: { userId: withdrawal.userId },
        create: { userId: withdrawal.userId },
        update: {},
      });
      await tx.wallet.update({
        where: { id: wallet.id },
        data: { availablePaise: { increment: withdrawal.amountPaise } },
      });
      await tx.transaction.create({
        data: {
          walletId: wallet.id,
          type: "withdrawal_refund",
          amountPaise: withdrawal.amountPaise,
          referenceId: withdrawal.id,
          note: `Withdrawal could not be paid — refunded (${reason})`,
        },
      });
      return withdrawal;
    });

    if (!failed) {
      await this.explainNotOpen(withdrawalId);
      throw new ConflictException({ code: "CONFLICT", message: "This withdrawal can't be changed." });
    }

    await this.activityLog.log(adminUserId, "admin.withdrawal.marked_failed", {
      targetType: "withdrawal",
      targetId: withdrawalId,
      metadata: { creatorId: failed.userId, amountPaise: failed.amountPaise, reason },
    });

    await this.notifications.create(failed.userId, "creator", {
      type: "withdrawal_failed",
      title: "Withdrawal couldn't be paid",
      body: `₹${(failed.amountPaise / 100).toFixed(2)} has been returned to your wallet. Reason: ${reason}`,
      link: "/wallet",
      sendWhatsapp: true,
    });

    return { id: withdrawalId, status: WithdrawalStatus.failed };
  }

  // ── Importing the returned sheet ───────────────────────────────────────

  async importResults(buffer: Buffer, adminUserId: string) {
    let parsed;
    try {
      parsed = await parseResultWorkbook(buffer);
    } catch (err) {
      throw new BadRequestException({
        code: "VALIDATION_ERROR",
        message: err instanceof Error ? err.message : "Could not read the file.",
      });
    }
    if (parsed.length > 2000) {
      throw new BadRequestException({ code: "VALIDATION_ERROR", message: "Too many rows (limit 2000)." });
    }

    const ids = parsed.map((p) => p.withdrawalId);
    const known = await this.prisma.withdrawal.findMany({
      where: { id: { in: ids } },
      select: { id: true, netPaise: true },
    });
    const netById = new Map(known.map((k) => [k.id, k.netPaise]));

    const results: ImportRowResult[] = [];
    for (const row of parsed) {
      const base = { row: row.rowNumber, withdrawalId: row.withdrawalId };
      if (row.outcome === "skip") {
        results.push({ ...base, result: "skipped", message: "Left blank — still waiting." });
        continue;
      }
      if (row.outcome === "invalid") {
        results.push({ ...base, result: "error", message: row.message });
        continue;
      }
      const net = netById.get(row.withdrawalId);
      if (net === undefined) {
        results.push({ ...base, result: "error", message: "No withdrawal with this ID." });
        continue;
      }
      if (row.amountRupees !== undefined && Math.round(row.amountRupees * 100) !== net) {
        results.push({
          ...base,
          result: "error",
          message: `Amount ₹${row.amountRupees} doesn't match the withdrawal's ₹${(net / 100).toFixed(2)}.`,
        });
        continue;
      }

      try {
        if (row.outcome === "paid") {
          await this.markPaid(row.withdrawalId, row.utr ?? "", adminUserId);
          results.push({ ...base, result: "paid" });
        } else {
          await this.markFailed(row.withdrawalId, row.remarks ?? "", adminUserId);
          results.push({ ...base, result: "failed" });
        }
      } catch (err) {
        const message =
          err instanceof ConflictException || err instanceof NotFoundException || err instanceof BadRequestException
            ? (err.getResponse() as { message?: string }).message ?? err.message
            : "Unexpected error.";
        if (!(err instanceof ConflictException || err instanceof NotFoundException || err instanceof BadRequestException)) {
          this.logger.error(`Import row ${row.rowNumber} (${row.withdrawalId}) failed`, err as Error);
        }
        results.push({ ...base, result: "error", message });
      }
    }

    const summary = {
      paid: results.filter((r) => r.result === "paid").length,
      failed: results.filter((r) => r.result === "failed").length,
      skipped: results.filter((r) => r.result === "skipped").length,
      errors: results.filter((r) => r.result === "error").length,
    };

    await this.activityLog.log(adminUserId, "admin.withdrawals.imported", {
      targetType: "withdrawal_import",
      targetId: `import-${Date.now()}`,
      metadata: summary,
    });

    return { summary, results };
  }
}
