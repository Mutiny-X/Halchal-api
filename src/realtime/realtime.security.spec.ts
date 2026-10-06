import { CampaignOwnership, CampaignStatus, UserRole } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { CampaignAccessService } from "../access/campaign-access.service";
import { RealtimeGateway } from "./realtime.gateway";
import { RealtimeService } from "./realtime.service";

function makeAccess(campaign: Record<string, unknown> | null, opts: { brandProfileId?: string | null; staffAssignment?: unknown } = {}) {
  const prisma = {
    campaign: { findUnique: vi.fn().mockResolvedValue(campaign) },
    brandProfile: { findUnique: vi.fn().mockResolvedValue(opts.brandProfileId ? { id: opts.brandProfileId } : null) },
    staffBrandAssignment: { findUnique: vi.fn().mockResolvedValue(opts.staffAssignment ?? null) },
  };
  return new CampaignAccessService(prisma as never);
}

const draft = { id: "c1", brandProfileId: "brand-1", ownership: CampaignOwnership.brand_created, status: CampaignStatus.draft };
const live = { ...draft, status: CampaignStatus.live };

describe("CampaignAccessService.canJoinCampaignRoom", () => {
  it("lets a creator follow a published campaign (what the mobile app does)", async () => {
    expect(await makeAccess(live).canJoinCampaignRoom("creator-1", UserRole.creator, "c1")).toBe(true);
    expect(
      await makeAccess({ ...live, status: CampaignStatus.paused }).canJoinCampaignRoom("creator-1", UserRole.creator, "c1"),
    ).toBe(true);
  });

  it("never lets a creator into a draft's room", async () => {
    expect(await makeAccess(draft).canJoinCampaignRoom("creator-1", UserRole.creator, "c1")).toBe(false);
  });

  it("lets the owning brand in, but not another brand", async () => {
    expect(await makeAccess(draft, { brandProfileId: "brand-1" }).canJoinCampaignRoom("u", UserRole.brand, "c1")).toBe(true);
    expect(await makeAccess(draft, { brandProfileId: "brand-2" }).canJoinCampaignRoom("u", UserRole.brand, "c1")).toBe(false);
    expect(await makeAccess(live, { brandProfileId: "brand-2" }).canJoinCampaignRoom("u", UserRole.brand, "c1")).toBe(false);
  });

  it("lets assigned staff in (view-only is fine for watching), not unassigned staff", async () => {
    expect(
      await makeAccess(draft, { staffAssignment: { accessLevel: "view_only" } }).canJoinCampaignRoom("s", UserRole.staff, "c1"),
    ).toBe(true);
    expect(await makeAccess(draft).canJoinCampaignRoom("s", UserRole.staff, "c1")).toBe(false);
  });

  it("lets admins in, and refuses unknown campaigns for everyone", async () => {
    expect(await makeAccess(draft).canJoinCampaignRoom("a", UserRole.admin, "c1")).toBe(true);
    expect(await makeAccess(null).canJoinCampaignRoom("a", UserRole.admin, "nope")).toBe(false);
  });
});

describe("RealtimeGateway campaign:join", () => {
  function makeGateway(allowed: boolean) {
    const access = { canJoinCampaignRoom: vi.fn().mockResolvedValue(allowed) };
    const gateway = new RealtimeGateway({} as never, {} as never, access as never);
    const client = { data: { userId: "u1", role: UserRole.creator }, join: vi.fn() };
    return { gateway, client, access };
  }

  it("joins only after the access check passes", async () => {
    const { gateway, client } = makeGateway(true);
    expect(await gateway.handleJoinCampaign(client as never, { campaignId: "c1" })).toEqual({ joined: true });
    expect(client.join).toHaveBeenCalledWith("campaign:c1");
  });

  it("refuses without joining when access is denied", async () => {
    const { gateway, client } = makeGateway(false);
    expect(await gateway.handleJoinCampaign(client as never, { campaignId: "c1" })).toEqual({ joined: false });
    expect(client.join).not.toHaveBeenCalled();
  });

  it.each([[{}], [{ campaignId: 42 }], [{ campaignId: "" }], [null], [{ campaignId: "x".repeat(200) }]])(
    "ignores a malformed payload %j without touching the database",
    async (body) => {
      const { gateway, client, access } = makeGateway(true);
      expect(await gateway.handleJoinCampaign(client as never, body as never)).toEqual({ joined: false });
      expect(access.canJoinCampaignRoom).not.toHaveBeenCalled();
      expect(client.join).not.toHaveBeenCalled();
    },
  );

  it("refuses an unauthenticated socket", async () => {
    const { gateway, client, access } = makeGateway(true);
    client.data = {} as never;
    expect(await gateway.handleJoinCampaign(client as never, { campaignId: "c1" })).toEqual({ joined: false });
    expect(access.canJoinCampaignRoom).not.toHaveBeenCalled();
  });
});

describe("RealtimeService campaign broadcasts", () => {
  function makeService() {
    const gateway = {
      emitToAdmin: vi.fn(),
      emitToCreators: vi.fn(),
      emitToBrand: vi.fn(),
      emitToCampaign: vi.fn(),
    };
    return { gateway, service: new RealtimeService(gateway as never) };
  }

  it("keeps draft saves away from creators' phones (admins + the brand still get them)", () => {
    const { gateway, service } = makeService();
    service.emitCampaignUpdated({ id: "c1", status: "draft", brandProfileId: "brand-1", budgetPaise: 1 });
    service.emitCampaignCreated({ id: "c1", status: "draft", brandProfileId: "brand-1" });
    expect(gateway.emitToCreators).not.toHaveBeenCalled();
    expect(gateway.emitToAdmin).toHaveBeenCalledTimes(2);
    expect(gateway.emitToBrand).toHaveBeenCalledWith("brand-1", "campaign:updated", expect.anything());
  });

  it("still tells creators about published, paused and closed campaigns, with the same payload shape", () => {
    const { gateway, service } = makeService();
    for (const status of ["live", "paused", "closed"]) {
      service.emitCampaignUpdated({ id: "c1", status, brandProfileId: "brand-1" });
    }
    service.emitCampaignPublished({ id: "c1", status: "live", brandProfileId: "brand-1" });
    expect(gateway.emitToCreators).toHaveBeenCalledTimes(4);
    expect(gateway.emitToCreators).toHaveBeenCalledWith("campaign:published", {
      campaign: { id: "c1", status: "live", brandProfileId: "brand-1" },
    });
  });
});
