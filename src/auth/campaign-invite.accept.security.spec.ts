import { UnauthorizedException } from "@nestjs/common";
import { CampaignInviteStatus, CampaignOwnership, CampaignStatus, UserRole } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Invites are switched off in the product today; turn them on for this file so
// the accept flow's safety checks stay covered for the day they are reopened.
vi.mock("./auth.types", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth.types")>()),
  BRAND_INVITES_OPEN: true,
}));

import { CampaignInviteService } from "./campaign-invite.service";

const INVITE = {
  id: "inv-1",
  email: "Brand@Example.com",
  status: CampaignInviteStatus.pending,
  campaignId: "camp-1",
  expiresAt: new Date(Date.now() + 86_400_000),
  campaign: {
    id: "camp-1",
    title: "Launch",
    status: CampaignStatus.draft,
    ownership: CampaignOwnership.admin_created,
    brandProfileId: null,
  },
};

function build(existing: unknown) {
  const prisma = {
    campaignInvite: { findUnique: vi.fn().mockResolvedValue(INVITE), update: vi.fn() },
    campaign: { update: vi.fn().mockResolvedValue({ id: "camp-1", title: "Launch", status: "draft", ownership: "admin_created", brandProfileId: "bp-1", brandProfile: { companyName: "Acme" }, inviteAcceptedAt: new Date() }) },
    user: { findUnique: vi.fn().mockResolvedValue(existing) },
    $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[])),
  };
  const auth = {
    authenticatePassword: vi.fn(),
    createSessionForUser: vi.fn().mockResolvedValue({ tokens: { accessToken: "a", refreshToken: "r" } }),
  };
  const realtime = { emitCampaignInviteAccepted: vi.fn() };
  const service = new CampaignInviteService(prisma as never, {} as never, {} as never, auth as never, realtime as never);
  return { service, prisma, auth };
}

const EXISTING_BRAND = { id: "u1", email: "brand@example.com", role: UserRole.brand, brandProfile: { id: "bp-1" } };

describe("accepting a campaign invite for an email that already has an account", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not sign anyone in on the link alone", async () => {
    const { service, auth, prisma } = build(EXISTING_BRAND);
    const out = await service.accept({ token: "x".repeat(32) });
    expect(out).toEqual({ needsLogin: true });
    expect(auth.createSessionForUser).not.toHaveBeenCalled();
    expect(prisma.campaign.update).not.toHaveBeenCalled();
    expect(prisma.campaignInvite.update).not.toHaveBeenCalled();
  });

  it("refuses a wrong password, and still does not hand over the campaign or a session", async () => {
    const { service, auth, prisma } = build(EXISTING_BRAND);
    auth.authenticatePassword.mockRejectedValue(new UnauthorizedException());
    await expect(service.accept({ token: "x".repeat(32), password: "wrong-password" })).rejects.toBeInstanceOf(UnauthorizedException);
    expect(auth.createSessionForUser).not.toHaveBeenCalled();
    expect(prisma.campaign.update).not.toHaveBeenCalled();
  });

  it("with the right password, accepts and signs in", async () => {
    const { service, auth, prisma } = build(EXISTING_BRAND);
    auth.authenticatePassword.mockResolvedValue(EXISTING_BRAND);
    const out = await service.accept({ token: "x".repeat(32), password: "correct-password" });
    expect(auth.authenticatePassword).toHaveBeenCalledWith("brand@example.com", "correct-password", [UserRole.brand]);
    expect(prisma.campaign.update).toHaveBeenCalledTimes(1);
    expect(auth.createSessionForUser).toHaveBeenCalledWith("u1");
    expect(out).toHaveProperty("tokens");
  });
});
