import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { FormatDeliverableStatus, Prisma, WithdrawalStatus } from "@prisma/client";

import { computeEstimatedPaise } from "../common/earnings";
import {
  WITHDRAWAL_DENOMINATIONS_PAISE,
  WITHDRAWAL_EXPECTED_DAYS,
  WITHDRAWAL_LIFETIME_GATE_PAISE,
  isWithdrawalUnlocked,
  startOfIstDay,
  startOfNextIstDay,
} from "../common/withdrawal-rules";
import type { Env } from "../config/env";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class WalletService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** The withdrawal rules plus this creator's current standing against them —
   * the single source the apps read, so nothing is hard-coded client-side. */
  async getWithdrawalRules(userId: string, lifetimePaise: number) {
    const now = new Date();
    const [openCount, todayCount] = await Promise.all([
      this.prisma.withdrawal.count({
        where: {
          userId,
          status: { in: [WithdrawalStatus.pending, WithdrawalStatus.processing] },
        },
      }),
      this.prisma.withdrawal.count({
        where: {
          userId,
          createdAt: { gte: startOfIstDay(now) },
          status: { not: WithdrawalStatus.failed },
        },
      }),
    ]);
    const unlocked = isWithdrawalUnlocked(lifetimePaise);
    return {
      unlocked,
      lifetimeGatePaise: WITHDRAWAL_LIFETIME_GATE_PAISE,
      remainingToUnlockPaise: unlocked ? 0 : WITHDRAWAL_LIFETIME_GATE_PAISE - lifetimePaise,
      denominationsPaise: [...WITHDRAWAL_DENOMINATIONS_PAISE],
      feeBps: this.config.get("WITHDRAWAL_FEE_BPS", { infer: true }),
      hasOpenWithdrawal: openCount > 0,
      requestedToday: todayCount > 0,
      nextRequestAt: todayCount > 0 ? startOfNextIstDay(now).toISOString() : null,
      expectedDays: WITHDRAWAL_EXPECTED_DAYS,
    };
  }

  async getOrCreateWallet(userId: string) {
    let wallet = await this.prisma.wallet.findUnique({ where: { userId } });
    if (!wallet) {
      wallet = await this.prisma.wallet.create({ data: { userId } });
    }
    return wallet;
  }

  // Earnings that are "in flight" — the creator has done their part
  // (submitted live proof or had proof approved) but payout hasn't settled yet.
  async computePendingPaise(creatorId: string, creatorProfileId?: string): Promise<number> {
    const pendingStatuses = [
      FormatDeliverableStatus.live_submitted,
      FormatDeliverableStatus.proof_under_review,
      FormatDeliverableStatus.proof_approved,
    ];
    const deliverables = await this.prisma.formatDeliverable.findMany({
      where: {
        status: { in: pendingStatuses },
        paidAt: null,
        participation: { creatorId, ...(creatorProfileId ? { creatorProfileId } : {}) },
      },
      include: {
        participation: {
          include: {
            campaign: { select: { ratePer1kPaise: true, maxPayoutPaise: true } },
          },
        },
      },
    });
    return deliverables.reduce((sum, d) => {
      return sum + computeEstimatedPaise(
        d.viewCount,
        d.participation.campaign.ratePer1kPaise,
        d.participation.campaign.maxPayoutPaise,
      );
    }, 0);
  }

  async countClipsUnderReview(creatorId: string, creatorProfileId?: string): Promise<number> {
    return this.prisma.formatDeliverable.count({
      where: {
        status: FormatDeliverableStatus.under_review,
        participation: { creatorId, ...(creatorProfileId ? { creatorProfileId } : {}) },
      },
    });
  }

  async getWallet(userId: string, creatorProfileId?: string) {
    const [wallet, pendingPaise, clipsUnderReview] = await Promise.all([
      this.getOrCreateWallet(userId),
      this.computePendingPaise(userId, creatorProfileId),
      this.countClipsUnderReview(userId, creatorProfileId),
    ]);
    const withdrawal = await this.getWithdrawalRules(userId, wallet.lifetimePaise);
    return {
      availablePaise: wallet.availablePaise,
      pendingPaise,
      lifetimePaise: wallet.lifetimePaise,
      clipsUnderReview,
      withdrawal,
    };
  }

  async listTransactions(userId: string, limit = 20, cursor?: string) {
    const wallet = await this.prisma.wallet.findUnique({ where: { userId } });
    if (!wallet) {
      return { items: [], nextCursor: null };
    }

    const items = await this.prisma.transaction.findMany({
      where: { walletId: wallet.id },
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      ...(cursor
        ? { cursor: { id: cursor }, skip: 1 }
        : {}),
    });

    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;

    return {
      items: page.map((t) => ({
        id: t.id,
        type: t.type,
        amountPaise: t.amountPaise,
        note: t.note,
        createdAt: t.createdAt.toISOString(),
      })),
      nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null,
    };
  }

  async creditEarning(
    userId: string,
    amountPaise: number,
    referenceId: string,
    note?: string,
  ) {
    return this.prisma.$transaction((tx) =>
      this.creditEarningInTx(tx, userId, amountPaise, referenceId, note),
    );
  }

  /** Same as creditEarning, but runs inside a transaction the caller already
   * holds open — for callers that need this credit to commit atomically
   * alongside other writes (e.g. crediting both parties of a marketplace
   * repost split together with the deliverable payout that produced it). */
  async creditEarningInTx(
    tx: Prisma.TransactionClient,
    userId: string,
    amountPaise: number,
    referenceId: string,
    note?: string,
  ) {
    const wallet = await tx.wallet.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });

    const updated = await tx.wallet.update({
      where: { id: wallet.id },
      data: {
        availablePaise: { increment: amountPaise },
        lifetimePaise: { increment: amountPaise },
      },
    });

    await tx.transaction.create({
      data: {
        walletId: wallet.id,
        type: "earning_credit",
        amountPaise,
        referenceId,
        note,
      },
    });

    return updated;
  }
}
