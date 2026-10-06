import { BadRequestException } from "@nestjs/common";
import { CampaignOwnership, CampaignStatus, UserRole } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { CampaignAccessService } from "../access/campaign-access.service";
import { campaignFileUrls } from "./campaign-files";
import { CampaignsService } from "./campaigns.service";

const R2 = "https://pub.r2.test";
const COVER = `${R2}/cover-images/1-aaaaaaaaaaaaaaaa.png`;
const SAMPLE = `${R2}/reference-assets/2-bbbbbbbbbbbbbbbb.mp4`;
const SOURCE = `${R2}/reference-assets/3-cccccccccccccccc.mp4`;

function campaignRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "camp-1",
    brandProfileId: "brand-1",
    ownership: CampaignOwnership.brand_created,
    status: CampaignStatus.draft,
    title: "T",
    coverImageUrl: COVER,
    referenceAssets: [{ type: "video", url: SAMPLE }],
    sourceAssets: [
      { type: "upload", url: SOURCE },
      { type: "drive", url: "https://drive.google.com/file/d/x/view" },
    ],
    platforms: ["instagram_reel"],
    targetStates: [],
    _count: { submissions: 0, participations: 0 },
    ratePer1kPaise: 5000,
    maxPayoutPaise: 5_000_000,
    budgetPaise: 10_000_000,
    budgetUsedPaise: 0,
    createdAt: new Date("2026-10-01"),
    ...overrides,
  };
}

function setup(row: Record<string, unknown>, opts: { usedElsewhere?: string[] } = {}) {
  const prisma = {
    campaign: {
      findUnique: vi.fn().mockResolvedValue(row),
      delete: vi.fn().mockResolvedValue({}),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...row,
        ...Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)),
      })),
      // "Is any campaign still using this URL?" — only the listed ones are.
      count: vi.fn(async ({ where }: { where: { OR: Array<{ coverImageUrl?: string; referenceAssets?: { array_contains: Array<{ url: string }> } }> } }) => {
        const url = where.OR[0].coverImageUrl!;
        return (opts.usedElsewhere ?? []).includes(url) ? 1 : 0;
      }),
    },
    brandProfile: { findUnique: vi.fn().mockResolvedValue({ id: "brand-1" }) },
  };
  const storage = { deleteCampaignFile: vi.fn().mockResolvedValue(true) };
  const service = new CampaignsService(
    prisma as never,
    new CampaignAccessService(prisma as never),
    { emitCampaignUpdated: vi.fn(), emitCampaignPublished: vi.fn(), emitCampaignCreated: vi.fn() } as never,
    { log: vi.fn() } as never,
    { create: vi.fn() } as never,
    { get: (k: string) => (k === "S3_PUBLIC_BASE_URL" ? R2 : undefined) } as never,
    storage as never,
  );
  return { service, prisma, storage };
}

describe("campaignFileUrls", () => {
  it("collects cover, every sample, and only UPLOADED source files", () => {
    expect(campaignFileUrls(campaignRow()).sort()).toEqual([COVER, SAMPLE, SOURCE].sort());
  });
  it("tolerates missing / malformed data", () => {
    expect(campaignFileUrls({ coverImageUrl: null, referenceAssets: "x", sourceAssets: [null, { url: 5 }] })).toEqual([]);
  });
});

describe("deleting a campaign removes its files from storage", () => {
  it("deletes the campaign, then its cover, samples and uploaded source files (not Drive links)", async () => {
    const { service, prisma, storage } = setup(campaignRow());
    await expect(service.remove("u", UserRole.brand, "camp-1")).resolves.toEqual({ deleted: true, id: "camp-1" });
    expect(prisma.campaign.delete).toHaveBeenCalled();
    const deleted = storage.deleteCampaignFile.mock.calls.map((c) => c[0]).sort();
    expect(deleted).toEqual([COVER, SAMPLE, SOURCE].sort());
    // DB first, files after — a failed DB delete never loses files.
    expect(prisma.campaign.delete.mock.invocationCallOrder[0]).toBeLessThan(storage.deleteCampaignFile.mock.invocationCallOrder[0]);
  });

  it("keeps a file another campaign still uses", async () => {
    const { service, storage } = setup(campaignRow(), { usedElsewhere: [SAMPLE] });
    await service.remove("u", UserRole.brand, "camp-1");
    const deleted = storage.deleteCampaignFile.mock.calls.map((c) => c[0]);
    expect(deleted).not.toContain(SAMPLE);
    expect(deleted).toContain(COVER);
  });

  it("a storage failure doesn't fail the delete (logged instead)", async () => {
    const { service, storage } = setup(campaignRow());
    storage.deleteCampaignFile.mockRejectedValue(new Error("R2 down"));
    await expect(service.remove("u", UserRole.brand, "camp-1")).resolves.toMatchObject({ deleted: true });
  });

  it("refuses to delete once creators have joined — their work and payouts would cascade away", async () => {
    const { service, prisma, storage } = setup(campaignRow({ status: CampaignStatus.closed, _count: { submissions: 0, participations: 2 } }));
    await expect(service.remove("u", UserRole.brand, "camp-1")).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.campaign.delete).not.toHaveBeenCalled();
    expect(storage.deleteCampaignFile).not.toHaveBeenCalled();
  });

  it("a failed delete (live campaign) touches no files", async () => {
    const { service, storage } = setup(campaignRow({ status: CampaignStatus.live }));
    await expect(service.remove("u", UserRole.brand, "camp-1")).rejects.toThrow(/End the campaign/);
    expect(storage.deleteCampaignFile).not.toHaveBeenCalled();
  });
});

describe("editing a campaign removes files it no longer uses", () => {
  it("replacing the cover deletes the old cover only", async () => {
    const { service, storage } = setup(campaignRow());
    const NEW_COVER = `${R2}/cover-images/9-dddddddddddddddd.png`;
    // NEW_COVER is a fresh upload, so the link rules accept it.
    await service.update("u", UserRole.brand, "camp-1", { coverImageUrl: NEW_COVER } as never);
    expect(storage.deleteCampaignFile.mock.calls.map((c) => c[0])).toEqual([COVER]);
  });

  it("removing a sample deletes that sample's file", async () => {
    const { service, storage } = setup(campaignRow());
    await service.update("u", UserRole.brand, "camp-1", { referenceAssets: [] } as never);
    expect(storage.deleteCampaignFile.mock.calls.map((c) => c[0])).toEqual([SAMPLE]);
  });

  it("an ordinary save (nothing removed) deletes nothing", async () => {
    const { service, storage } = setup(campaignRow());
    await service.update("u", UserRole.brand, "camp-1", { title: "renamed" } as never);
    expect(storage.deleteCampaignFile).not.toHaveBeenCalled();
  });
});
