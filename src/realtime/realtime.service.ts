import { Injectable } from "@nestjs/common";

import { RealtimeGateway } from "./realtime.gateway";
import { isUnpublished } from "../campaigns/campaign-status";

export type DeliverableEventPayload = {
  deliverableId: string;
  participationId: string;
  campaignId: string;
  creatorId: string;
  brandProfileId: string | null;
  platform: string;
  status: string;
};

export type ParticipationJoinedPayload = {
  participationId: string;
  campaignId: string;
  creatorId: string;
  brandProfileId: string | null;
};

@Injectable()
export class RealtimeService {
  constructor(private readonly gateway: RealtimeGateway) {}

  /** Ends a user's open live-update connections (account deactivated or
   * removed). Best-effort: a failure here never blocks the deactivation. */
  async disconnectUser(userId: string): Promise<void> {
    await this.gateway.disconnectUser(userId).catch(() => undefined);
  }

  private broadcastDeliverableToBrand(
    event: string,
    payload: DeliverableEventPayload,
  ): void {
    this.gateway.emitToAdmin(event, payload);
    if (payload.brandProfileId) {
      this.gateway.emitToBrand(payload.brandProfileId, event, payload);
    }
    this.gateway.emitToCampaign(payload.campaignId, event, payload);
  }

  /** Notifies the creator once a background Apify social-stats scrape finishes,
   * so Connected Accounts can update itself without a manual pull-to-refresh. */
  emitCreatorProfileStatsUpdated(creatorId: string, profileId: string, platform: string): void {
    this.gateway.emitToCreator(creatorId, "creatorProfile:statsUpdated", {
      profileId,
      platform,
    });
  }

  emitDeliverableSubmitted(payload: DeliverableEventPayload): void {
    this.gateway.emitToCreator(
      payload.creatorId,
      "deliverable:submitted",
      payload,
    );
    this.broadcastDeliverableToBrand("deliverable:submitted", payload);
  }

  emitDeliverableReviewed(payload: DeliverableEventPayload): void {
    this.gateway.emitToCreator(payload.creatorId, "deliverable:reviewed", payload);
    this.broadcastDeliverableToBrand("deliverable:reviewed", payload);
  }

  emitDeliverableLiveProof(payload: DeliverableEventPayload): void {
    this.broadcastDeliverableToBrand("deliverable:live_proof", payload);
    this.gateway.emitToCreator(payload.creatorId, "deliverable:live_proof", payload);
  }

  /** Notifies the creator once a payout lands in their wallet, so Get Paid
   * updates from Pending without a manual pull-to-refresh. */
  emitDeliverablePaid(payload: DeliverableEventPayload & { amountPaise: number }): void {
    this.gateway.emitToCreator(payload.creatorId, "deliverable:paid", payload);
    this.broadcastDeliverableToBrand("deliverable:paid", payload);
  }

  /** Notifies the creator (and brand/admin) after a background metrics
   * refresh — view/like/comment/share counts changed but the deliverable's
   * status didn't, so this is deliberately a separate event from
   * deliverable:reviewed/live_proof rather than overloading either of
   * those with an unrelated meaning. Lets the performance screen update
   * live without a manual "Refresh views" tap. */
  emitDeliverableMetricsUpdated(
    payload: DeliverableEventPayload & {
      viewCount: number;
      reach: number;
      likeCount: number;
      commentCount: number;
      shareCount: number;
    },
  ): void {
    this.gateway.emitToCreator(payload.creatorId, "deliverable:metrics_updated", payload);
    this.broadcastDeliverableToBrand("deliverable:metrics_updated", payload);
  }

  /** Notifies the creator when an admin responds to (or resolves) their ticket. */
  emitSupportTicketUpdated(creatorId: string, ticketId: string): void {
    this.gateway.emitToCreator(creatorId, "supportTicket:updated", { ticketId });
  }

  /** Notifies the creator the moment an admin approves/rejects their
   * Instagram review — the signup verification gate's waiting screen has
   * nothing else telling it to re-check, so without this push it just
   * sits on stale data until something else happens to refetch it. */
  emitOnboardingVerificationUpdated(creatorId: string): void {
    this.gateway.emitToCreator(creatorId, "onboarding:verification_updated", {});
  }

  /** Same problem, older/separate feature: the generic id_proof KYC status
   * screen (profile/kyc) also has nothing telling it an admin just
   * reviewed it, so it sits on "Under review" until something else
   * refetches profileMeProvider. */
  emitKycStatusUpdated(creatorId: string): void {
    this.gateway.emitToCreator(creatorId, "kyc:status_updated", {});
  }

  emitParticipationJoined(payload: ParticipationJoinedPayload): void {
    this.gateway.emitToCreator(
      payload.creatorId,
      "participation:joined",
      payload,
    );
    this.gateway.emitToAdmin("participation:joined", payload);
    if (payload.brandProfileId) {
      this.gateway.emitToBrand(
        payload.brandProfileId,
        "participation:joined",
        payload,
      );
    }
    this.gateway.emitToCampaign(payload.campaignId, "participation:joined", payload);
  }

  private broadcastCampaignEvent(
    event: string,
    campaign: Record<string, unknown>,
  ): void {
    const payload = { campaign };
    this.gateway.emitToAdmin(event, payload);
    // A draft is private to its brand and admins — creators (every phone
    // running the app) only ever hear about campaigns that have been
    // published. Drafts auto-save every few seconds while being written, so
    // this also stops a stream of unpublished rates and budgets going out.
    if (!isUnpublished(String(campaign.status))) {
      this.gateway.emitToCreators(event, payload);
    }
    const brandProfileId = campaign.brandProfileId as string | null | undefined;
    if (brandProfileId) {
      this.gateway.emitToBrand(brandProfileId, event, payload);
    }
    this.gateway.emitToCampaign(campaign.id as string, event, payload);
  }

  emitCampaignCreated(campaign: Record<string, unknown>): void {
    this.broadcastCampaignEvent("campaign:created", campaign);
  }

  emitCampaignUpdated(campaign: Record<string, unknown>): void {
    this.broadcastCampaignEvent("campaign:updated", campaign);
  }

  emitCampaignPublished(campaign: Record<string, unknown>): void {
    this.broadcastCampaignEvent("campaign:published", campaign);
  }

  emitCampaignInviteSent(invite: Record<string, unknown>): void {
    this.gateway.emitToAdmin("campaignInvite:sent", { invite });
  }

  emitCampaignInviteAccepted(
    invite: Record<string, unknown>,
    campaign: Record<string, unknown>,
  ): void {
    this.gateway.emitToAdmin("campaignInvite:accepted", { invite, campaign });
    const brandProfileId = campaign.brandProfileId as string | null | undefined;
    if (brandProfileId) {
      this.gateway.emitToBrand(brandProfileId, "campaignInvite:accepted", {
        invite,
        campaign,
      });
    }
    this.gateway.emitToCampaign(campaign.id as string, "campaignInvite:accepted", {
      invite,
      campaign,
    });
  }
}
