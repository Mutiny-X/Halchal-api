import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma, WithdrawalStatus } from "@prisma/client";

import { ActivityLogService } from "../activity/activity-log.service";
import {
  WITHDRAWAL_EXPECTED_DAYS,
  checkWithdrawalEligibility,
  computeWithdrawalFeePaise,
  startOfIstDay,
} from "../common/withdrawal-rules";
import type { Env } from "../config/env";
import { InAppNotificationService } from "../notifications/in-app-notification.service";
import { PrismaService } from "../prisma/prisma.service";
import type { CreatePayoutMethodDto, CreateWithdrawalDto, UpdatePayoutMethodDto } from "./dto/payout.dto";
import {
  decryptPayoutAccount,
  derivePayoutKey,
  encryptPayoutAccount,
} from "./payout-account-crypto";

/** Payment details frozen onto a withdrawal at request time. The account
 * number stays AES-GCM ciphertext — it's only decrypted when an admin exports
 * the payment sheet. */
export type PayoutSnapshot = {
  type: string;
  label: string;
  accountHolderName: string;
  accountNumber: string;
  accountMasked: string;
  ifscCode: string | null;
  bankName: string | null;
  panNumber: string | null;
};

const OPEN_WITHDRAWAL_STATUSES: WithdrawalStatus[] = [
  WithdrawalStatus.pending,
  WithdrawalStatus.processing,
];

@Injectable()
export class PayoutsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly notifications: InAppNotificationService,
    private readonly activityLog: ActivityLogService,
  ) {}

  /**
   * accountNumber is stored as AES-256-GCM ciphertext (iv.tag.ciphertext,
   * base64url-joined) — never in plaintext. Same pattern as the Instagram/
   * YouTube OAuth token encryption in creator-profiles.
   */
  private get encryptionKey(): Buffer {
    return derivePayoutKey(
      this.config.get("PAYOUT_ACCOUNT_ENCRYPTION_KEY", { infer: true }) ??
        this.config.get("JWT_SECRET", { infer: true }),
    );
  }

  private encryptAccount(value: string): string {
    return encryptPayoutAccount(this.encryptionKey, value);
  }

  private decryptAccount(value: string): string {
    const plain = decryptPayoutAccount(this.encryptionKey, value);
    if (plain === null) {
      throw new BadRequestException({
        code: "PAYOUT_ACCOUNT_INVALID",
        message: "Stored account number is invalid.",
      });
    }
    return plain;
  }

  maskAccount(account: string): string {
    if (account.includes("@")) {
      const [user, domain] = account.split("@");
      return `${user.slice(0, 2)}***@${domain}`;
    }
    return `•••• ${account.slice(-4)}`;
  }

  async listPayoutMethods(userId: string) {
    const methods = await this.prisma.payoutMethod.findMany({
      where: { userId },
      orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
    });
    return methods.map((m) => ({
      id: m.id,
      type: m.type,
      label: m.label,
      accountHolderName: m.accountHolderName,
      accountMasked: m.accountMasked,
      ifscCode: m.ifscCode,
      bankName: m.bankName,
      panNumber: m.panNumber,
      isDefault: m.isDefault,
    }));
  }

  async createPayoutMethod(userId: string, dto: CreatePayoutMethodDto) {
    const count = await this.prisma.payoutMethod.count({ where: { userId } });
    const isDefault = count === 0;

    const method = await this.prisma.payoutMethod.create({
      data: {
        userId,
        type: dto.type,
        label: dto.label,
        accountHolderName: dto.accountHolderName,
        accountNumber: this.encryptAccount(dto.account),
        ifscCode: dto.type === "bank" ? dto.ifscCode : null,
        bankName: dto.bankName ?? null,
        panNumber: dto.type === "bank" ? dto.panNumber : null,
        accountMasked: this.maskAccount(dto.account),
        isDefault,
      },
    });

    return {
      id: method.id,
      type: method.type,
      label: method.label,
      accountHolderName: method.accountHolderName,
      accountMasked: method.accountMasked,
      ifscCode: method.ifscCode,
      bankName: method.bankName,
      panNumber: method.panNumber,
      isDefault: method.isDefault,
    };
  }

  /**
   * Decrypts and returns the full account number for the authenticated
   * owner. Rate-limited at the controller and audit-logged here — this is
   * the one path that discloses more than the last 4 digits.
   */
  async revealAccountNumber(userId: string, methodId: string): Promise<{ accountNumber: string }> {
    const method = await this.prisma.payoutMethod.findFirst({
      where: { id: methodId, userId },
    });
    if (!method) {
      throw new NotFoundException({ code: "NOT_FOUND", message: "Payout method not found" });
    }

    const accountNumber = this.decryptAccount(method.accountNumber);

    await this.activityLog.log(userId, "payout_method.account_revealed", {
      targetType: "payout_method",
      targetId: methodId,
    });

    return { accountNumber };
  }

  /**
   * Same decryption, for an admin viewing any creator's payout method —
   * needed now that payouts are being sent manually and an admin genuinely
   * needs the real account number to wire money. Not ownership-scoped like
   * revealAccountNumber (an admin can look up any creator's method by id),
   * but still audit-logged, including which creator's data was viewed, so
   * there's a real trail of who accessed sensitive bank details and when.
   */
  async revealAccountNumberForAdmin(
    methodId: string,
    adminUserId: string,
  ): Promise<{ accountNumber: string }> {
    const method = await this.prisma.payoutMethod.findUnique({
      where: { id: methodId },
    });
    if (!method) {
      throw new NotFoundException({ code: "NOT_FOUND", message: "Payout method not found" });
    }

    const accountNumber = this.decryptAccount(method.accountNumber);

    await this.activityLog.log(adminUserId, "admin.payout_method.account_revealed", {
      targetType: "payout_method",
      targetId: methodId,
      metadata: { creatorId: method.userId },
    });

    return { accountNumber };
  }

  async updatePayoutMethod(userId: string, methodId: string, dto: UpdatePayoutMethodDto) {
    const method = await this.prisma.payoutMethod.findFirst({
      where: { id: methodId, userId },
    });
    if (!method) {
      throw new NotFoundException({ code: "NOT_FOUND", message: "Payout method not found" });
    }
    const updated = await this.prisma.payoutMethod.update({
      where: { id: methodId },
      data: {
        ...(dto.accountHolderName !== undefined && { accountHolderName: dto.accountHolderName }),
        ...(dto.ifscCode !== undefined && { ifscCode: dto.ifscCode }),
        ...(dto.bankName !== undefined && { bankName: dto.bankName }),
        ...(dto.panNumber !== undefined && { panNumber: dto.panNumber }),
        ...(dto.label !== undefined && { label: dto.label }),
      },
    });
    return {
      id: updated.id,
      type: updated.type,
      label: updated.label,
      accountHolderName: updated.accountHolderName,
      accountMasked: updated.accountMasked,
      ifscCode: updated.ifscCode,
      bankName: updated.bankName,
      panNumber: updated.panNumber,
      isDefault: updated.isDefault,
    };
  }

  async setDefaultPayoutMethod(userId: string, methodId: string) {
    const method = await this.prisma.payoutMethod.findFirst({
      where: { id: methodId, userId },
    });
    if (!method) {
      throw new NotFoundException({
        code: "NOT_FOUND",
        message: "Payout method not found",
      });
    }

    await this.prisma.$transaction([
      this.prisma.payoutMethod.updateMany({
        where: { userId },
        data: { isDefault: false },
      }),
      this.prisma.payoutMethod.update({
        where: { id: methodId },
        data: { isDefault: true },
      }),
    ]);

    return { ok: true };
  }

  async deletePayoutMethod(userId: string, methodId: string) {
    const method = await this.prisma.payoutMethod.findFirst({
      where: { id: methodId, userId },
    });
    if (!method) {
      throw new NotFoundException({
        code: "NOT_FOUND",
        message: "Payout method not found",
      });
    }

    await this.prisma.payoutMethod.delete({ where: { id: methodId } });

    if (method.isDefault) {
      const next = await this.prisma.payoutMethod.findFirst({
        where: { userId },
        orderBy: { createdAt: "desc" },
      });
      if (next) {
        await this.prisma.payoutMethod.update({
          where: { id: next.id },
          data: { isDefault: true },
        });
      }
    }

    return { ok: true };
  }

  async createWithdrawal(userId: string, dto: CreateWithdrawalDto) {
    const payoutMethod = await this.prisma.payoutMethod.findFirst({
      where: { id: dto.payoutMethodId, userId },
    });
    if (!payoutMethod) {
      throw new NotFoundException({
        code: "NOT_FOUND",
        message: "Payout method not found",
      });
    }

    const feeBps = this.config.get("WITHDRAWAL_FEE_BPS", { infer: true });
    const feePaise = computeWithdrawalFeePaise(dto.amountPaise, feeBps);
    const netPaise = dto.amountPaise - feePaise;

    const snapshot: PayoutSnapshot = {
      type: payoutMethod.type,
      label: payoutMethod.label,
      accountHolderName: payoutMethod.accountHolderName,
      accountNumber: payoutMethod.accountNumber,
      accountMasked: payoutMethod.accountMasked,
      ifscCode: payoutMethod.ifscCode,
      bankName: payoutMethod.bankName,
      panNumber: payoutMethod.panNumber,
    };

    const dayStart = startOfIstDay(new Date());

    let result: { withdrawal: WithdrawalRow; replay: boolean };
    try {
      result = await this.prisma.$transaction(async (tx) => {
        // Serialize every withdrawal attempt by this creator: the checks below
        // (balance, one open request, one per day, idempotency) all read then
        // write, so without the row lock two concurrent requests could both pass.
        await tx.$queryRaw`SELECT id FROM wallets WHERE user_id = ${userId} FOR UPDATE`;

        if (dto.idempotencyKey) {
          const existing = await tx.withdrawal.findUnique({
            where: { idempotencyKey: dto.idempotencyKey },
          });
          if (existing) {
            if (existing.userId !== userId) {
              throw new ConflictException({
                code: "CONFLICT",
                message: "Idempotency key already used",
              });
            }
            return { withdrawal: existing, replay: true };
          }
        }

        const wallet = await tx.wallet.findUnique({ where: { userId } });
        const [openCount, todayCount] = await Promise.all([
          tx.withdrawal.count({ where: { userId, status: { in: OPEN_WITHDRAWAL_STATUSES } } }),
          tx.withdrawal.count({
            where: { userId, createdAt: { gte: dayStart }, status: { not: WithdrawalStatus.failed } },
          }),
        ]);

        const rejection = checkWithdrawalEligibility({
          amountPaise: dto.amountPaise,
          availablePaise: wallet?.availablePaise ?? 0,
          lifetimePaise: wallet?.lifetimePaise ?? 0,
          feeBps,
          hasOpenWithdrawal: openCount > 0,
          requestedToday: todayCount > 0,
        });
        if (rejection || !wallet) {
          throw new BadRequestException(
            rejection ?? { code: "WITHDRAWAL_LOCKED", message: "Withdrawals are not available yet." },
          );
        }

        const withdrawal = await tx.withdrawal.create({
          data: {
            userId,
            amountPaise: dto.amountPaise,
            feePaise,
            netPaise,
            payoutMethodId: payoutMethod.id,
            payoutSnapshot: snapshot as unknown as Prisma.InputJsonValue,
            idempotencyKey: dto.idempotencyKey,
            status: WithdrawalStatus.pending,
          },
        });

        // Guarded decrement: belt and braces behind the row lock above.
        const { count } = await tx.wallet.updateMany({
          where: { id: wallet.id, availablePaise: { gte: dto.amountPaise } },
          data: { availablePaise: { decrement: dto.amountPaise } },
        });
        if (count === 0) {
          throw new BadRequestException({
            code: "WITHDRAWAL_INSUFFICIENT_BALANCE",
            message: "Insufficient available balance.",
          });
        }

        await tx.transaction.create({
          data: {
            walletId: wallet.id,
            type: "withdrawal_debit",
            amountPaise: dto.amountPaise,
            referenceId: withdrawal.id,
            note: `Withdrawal requested (fee ${feePaise} paise, net ${netPaise} paise)`,
          },
        });

        return { withdrawal, replay: false };
      });
    } catch (err) {
      // Two simultaneous requests with the same idempotency key: the loser
      // trips the unique index. Hand back the winner's withdrawal.
      if (
        dto.idempotencyKey &&
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        const existing = await this.prisma.withdrawal.findUnique({
          where: { idempotencyKey: dto.idempotencyKey },
        });
        if (existing && existing.userId === userId) {
          return this.formatWithdrawal(existing);
        }
      }
      throw err;
    }

    if (result.replay) {
      return this.formatWithdrawal(result.withdrawal);
    }

    await this.notifications.notifyAllAdmins({
      type: "withdrawal.requested",
      title: "Withdrawal requested",
      body: `₹${(netPaise / 100).toFixed(2)} to pay — add it to the next payment sheet.`,
      link: "/admin/payouts",
    });

    await this.notifications.create(userId, "creator", {
      type: "withdrawal_requested",
      title: "Withdrawal requested",
      body: `₹${(netPaise / 100).toFixed(2)} will be paid to your ${payoutMethod.label} within ${WITHDRAWAL_EXPECTED_DAYS} days.`,
      link: "/wallet",
    });

    return this.formatWithdrawal(result.withdrawal);
  }

  async listWithdrawals(userId: string, limit = 20) {
    const items = await this.prisma.withdrawal.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: Math.min(limit, 50),
    });
    return { items: items.map((w) => this.formatWithdrawal(w)) };
  }

  private formatWithdrawal(w: WithdrawalRow) {
    const snapshot = (w.payoutSnapshot ?? null) as Partial<PayoutSnapshot> | null;
    return {
      id: w.id,
      amountPaise: w.amountPaise,
      feePaise: w.feePaise,
      netPaise: w.netPaise,
      status: w.status,
      createdAt: w.createdAt.toISOString(),
      processedAt: w.processedAt?.toISOString() ?? null,
      utr: w.utr ?? null,
      failureReason: w.failureReason ?? null,
      payoutLabel: snapshot?.label ?? null,
      payoutMasked: snapshot?.accountMasked ?? null,
    };
  }
}

type WithdrawalRow = {
  id: string;
  userId: string;
  amountPaise: number;
  feePaise: number;
  netPaise: number;
  status: WithdrawalStatus;
  createdAt: Date;
  processedAt: Date | null;
  utr: string | null;
  failureReason: string | null;
  payoutSnapshot: Prisma.JsonValue | null;
};
