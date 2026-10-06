import { BadRequestException, ForbiddenException, GoneException, HttpException } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as video from "../campaigns/video-compatibility";
import { BufferedUploadGuard } from "./buffered-upload.guard";
import { DirectUploadService } from "./direct-upload.service";
import { signTicket, verifyTicket, type UploadTicket } from "./upload-ticket";

const SECRET = "test-secret-1234567890";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypisom"), Buffer.alloc(8)]);
const HTML = Buffer.from("<!doctype html><script>alert(1)</script>");

function makeStorage(objects: Record<string, { size: number; contentType: string; bytes: Buffer }> = {}) {
  return {
    objects,
    isR2Configured: vi.fn(() => true),
    presignExactPut: vi.fn(async (key: string) => `https://r2.test/${key}?signed`),
    presignGet: vi.fn(async (key: string) => `https://r2.test/${key}?get`),
    headObject: vi.fn(async (key: string) => (objects[key] ? { size: objects[key].size, contentType: objects[key].contentType } : null)),
    readObjectHead: vi.fn(async (key: string) => objects[key].bytes.subarray(0, 4096)),
    copyObject: vi.fn(async (from: string, to: string) => {
      objects[to] = objects[from];
    }),
    deleteObject: vi.fn(async (key: string) => {
      delete objects[key];
    }),
    publicUrlFor: vi.fn((key: string) => `https://pub.test/${key}`),
  };
}

function setup(opts: { perms?: unknown; deliverable?: unknown; access?: () => Promise<void> } = {}) {
  const storage = makeStorage();
  const prisma = {
    user: { update: vi.fn().mockResolvedValue({}) },
    formatDeliverable: { findUnique: vi.fn().mockResolvedValue(opts.deliverable ?? null) },
  };
  const access = { assertCanAccessCampaign: vi.fn(opts.access ?? (async () => undefined)) };
  const adminRoles = { getEffectivePermissions: vi.fn().mockResolvedValue(opts.perms ?? { isSuperAdmin: true, sections: {} }) };
  const participation = { setAdminDraftCopy: vi.fn(async (_u: string, _r: string, id: string, url: string) => ({ id, adminUploadedDraftUrl: url })) };
  const config = { get: (k: string) => (k === "JWT_SECRET" ? SECRET : undefined) };
  const service = new DirectUploadService(storage as never, config as never, prisma as never, access as never, adminRoles as never, participation as never);
  return { service, storage, prisma, access, adminRoles, participation };
}

/** Presign, then pretend the browser PUT `bytes` (as R2 would store them). */
async function uploadThenGetTicket(
  ctx: ReturnType<typeof setup>,
  user: string,
  role: UserRole,
  input: Parameters<DirectUploadService["presign"]>[2],
  stored?: { bytes: Buffer; size?: number; contentType?: string },
) {
  const res = await ctx.service.presign(user, role, input);
  const ticket = verifyTicket(res.uploadId, SECRET)!;
  if (stored) {
    ctx.storage.objects[ticket.pendingKey] = {
      bytes: stored.bytes,
      size: stored.size ?? input.size,
      contentType: stored.contentType ?? input.contentType,
    };
  }
  return { res, ticket };
}

describe("upload tickets", () => {
  const base: UploadTicket = {
    v: 1, pendingKey: "pending/a/b.png", finalKey: "a/b.png", purpose: "campaign-cover", userId: "u1",
    contentType: "image/png", size: 10, name: "b.png", expiresAt: Date.now() + 60_000,
  };

  it("round-trips", () => {
    expect(verifyTicket(signTicket(base, SECRET), SECRET)).toEqual(base);
  });

  it("rejects tampering (changing the owner, key or purpose)", () => {
    const token = signTicket(base, SECRET);
    const [body, mac] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...base, userId: "attacker", finalKey: "kyc-documents/x.png" })).toString("base64url");
    expect(verifyTicket(`${forged}.${mac}`, SECRET)).toBeNull();
    expect(verifyTicket(`${body}.${mac}x`, SECRET)).toBeNull();
    expect(verifyTicket(token, "another-secret")).toBeNull();
    expect(verifyTicket("garbage", SECRET)).toBeNull();
  });

  it("rejects expired tickets", () => {
    expect(verifyTicket(signTicket({ ...base, expiresAt: Date.now() - 1 }, SECRET), SECRET)).toBeNull();
  });
});

describe("DirectUploadService.presign", () => {
  it("signs a PUT for an exact size and type into a server-chosen pending key", async () => {
    const ctx = setup();
    const { res, ticket } = await uploadThenGetTicket(ctx, "u1", UserRole.brand, {
      purpose: "campaign-cover", contentType: "image/png", size: 1234, fileName: "../../evil.html",
    });
    expect(res.method).toBe("PUT");
    expect(ctx.storage.presignExactPut).toHaveBeenCalledWith(ticket.pendingKey, "image/png", 1234, 3600);
    expect(ticket.pendingKey).toMatch(/^pending\/cover-images\/\d+-[0-9a-f]{16}\.png$/);
    expect(ticket.finalKey).toBe(ticket.pendingKey.replace(/^pending\//, ""));
    expect(ticket.finalKey).not.toContain("evil");
  });

  it.each([
    ["SVG cover", { purpose: "campaign-cover", contentType: "image/svg+xml", size: 10 }],
    ["HTML asset", { purpose: "campaign-asset", contentType: "text/html", size: 10 }],
    ["video as a logo", { purpose: "brand-logo", contentType: "video/mp4", size: 10 }],
    ["11 MB cover", { purpose: "campaign-cover", contentType: "image/png", size: 11 * 1024 * 1024 }],
    ["6 MB avatar", { purpose: "avatar", contentType: "image/jpeg", size: 6 * 1024 * 1024 }],
    ["empty file", { purpose: "campaign-cover", contentType: "image/png", size: 0 }],
  ] as const)("refuses %s", async (_label, input) => {
    await expect(setup().service.presign("u1", UserRole.brand, input as never)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("allows a 5 GB campaign video", async () => {
    await expect(
      setup().service.presign("u1", UserRole.brand, { purpose: "campaign-asset", contentType: "video/mp4", size: 5 * 1024 ** 3 }),
    ).resolves.toBeTruthy();
  });

  it("enforces who may upload what", async () => {
    await expect(setup().service.presign("u1", UserRole.brand, { purpose: "admin-brand-logo", contentType: "image/png", size: 10 })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(setup().service.presign("u1", UserRole.staff, { purpose: "brand-logo", contentType: "image/png", size: 10 })).rejects.toBeInstanceOf(ForbiddenException);
    const restricted = setup({ perms: { isSuperAdmin: false, sections: { brands: "view" } } });
    await expect(restricted.service.presign("a1", UserRole.admin, { purpose: "admin-brand-logo", contentType: "image/png", size: 10 })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("admin draft copy needs a deliverable the caller can write to — checked before any upload", async () => {
    const noDeliverable = setup();
    await expect(noDeliverable.service.presign("u1", UserRole.brand, { purpose: "admin-draft-copy", contentType: "video/mp4", size: 10, deliverableId: "d1" })).rejects.toThrow(/not found/i);
    const denied = setup({
      deliverable: { participation: { campaign: { id: "c1" } } },
      access: async () => {
        throw new ForbiddenException({ code: "FORBIDDEN", message: "No access to this campaign" });
      },
    });
    await expect(denied.service.presign("u1", UserRole.brand, { purpose: "admin-draft-copy", contentType: "video/mp4", size: 10, deliverableId: "d1" })).rejects.toBeInstanceOf(ForbiddenException);
    expect(denied.storage.presignExactPut).not.toHaveBeenCalled();
  });

  it("says DIRECT_UPLOAD_UNAVAILABLE without R2 (website then uses its local-dev route)", async () => {
    const ctx = setup();
    ctx.storage.isR2Configured.mockReturnValue(false);
    const err = await ctx.service.presign("u1", UserRole.brand, { purpose: "campaign-cover", contentType: "image/png", size: 10 }).catch((e) => e);
    expect((err as HttpException).getStatus()).toBe(503);
    expect((err as HttpException).getResponse()).toMatchObject({ code: "DIRECT_UPLOAD_UNAVAILABLE" });
  });
});

describe("DirectUploadService.complete", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("verifies a real PNG, moves it out of pending, and returns its public URL", async () => {
    const ctx = setup();
    const { res, ticket } = await uploadThenGetTicket(ctx, "u1", UserRole.brand, { purpose: "campaign-cover", contentType: "image/png", size: PNG.length, fileName: "c.png" }, { bytes: PNG });
    const out = await ctx.service.complete("u1", UserRole.brand, res.uploadId);
    expect(out).toMatchObject({ url: `https://pub.test/${ticket.finalKey}`, type: "image", name: "c.png" });
    expect(ctx.storage.objects[ticket.finalKey]).toBeDefined();
    expect(ctx.storage.objects[ticket.pendingKey]).toBeUndefined();
    expect(ctx.storage.readObjectHead).toHaveBeenCalledWith(ticket.pendingKey, 4096);
  });

  it("refuses HTML bytes uploaded under an image type — and deletes them", async () => {
    const ctx = setup();
    const { res, ticket } = await uploadThenGetTicket(ctx, "u1", UserRole.brand, { purpose: "campaign-cover", contentType: "image/png", size: HTML.length }, { bytes: HTML });
    await expect(ctx.service.complete("u1", UserRole.brand, res.uploadId)).rejects.toThrow(/isn't a valid image/);
    expect(ctx.storage.objects[ticket.pendingKey]).toBeUndefined();
    expect(ctx.storage.objects[ticket.finalKey]).toBeUndefined();
  });

  it("refuses a video sent under an image purpose's type", async () => {
    const ctx = setup();
    const { res } = await uploadThenGetTicket(ctx, "u1", UserRole.brand, { purpose: "campaign-cover", contentType: "image/png", size: MP4.length }, { bytes: MP4 });
    await expect(ctx.service.complete("u1", UserRole.brand, res.uploadId)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses when the stored size or type doesn't match what was signed", async () => {
    const a = setup();
    const t1 = await uploadThenGetTicket(a, "u1", UserRole.brand, { purpose: "campaign-cover", contentType: "image/png", size: 100 }, { bytes: PNG, size: 99 });
    await expect(a.service.complete("u1", UserRole.brand, t1.res.uploadId)).rejects.toThrow(/size/);
    const b = setup();
    const t2 = await uploadThenGetTicket(b, "u1", UserRole.brand, { purpose: "campaign-cover", contentType: "image/png", size: PNG.length }, { bytes: PNG, contentType: "text/html" });
    await expect(b.service.complete("u1", UserRole.brand, t2.res.uploadId)).rejects.toThrow(/type/);
  });

  it("someone else can't complete my upload", async () => {
    const ctx = setup();
    const { res } = await uploadThenGetTicket(ctx, "u1", UserRole.brand, { purpose: "campaign-cover", contentType: "image/png", size: PNG.length }, { bytes: PNG });
    await expect(ctx.service.complete("u2", UserRole.brand, res.uploadId)).rejects.toThrow(/isn't yours/);
  });

  it("completing twice is harmless (retry after a dropped response)", async () => {
    const ctx = setup();
    const { res } = await uploadThenGetTicket(ctx, "u1", UserRole.brand, { purpose: "campaign-cover", contentType: "image/png", size: PNG.length }, { bytes: PNG });
    const first = await ctx.service.complete("u1", UserRole.brand, res.uploadId);
    const second = await ctx.service.complete("u1", UserRole.brand, res.uploadId);
    expect(second.url).toBe(first.url);
    expect(ctx.storage.copyObject).toHaveBeenCalledTimes(1);
  });

  it("not uploaded yet → clear error, nothing finalized", async () => {
    const ctx = setup();
    const { res } = await uploadThenGetTicket(ctx, "u1", UserRole.brand, { purpose: "campaign-cover", contentType: "image/png", size: 10 });
    await expect(ctx.service.complete("u1", UserRole.brand, res.uploadId)).rejects.toThrow(/hasn't finished uploading/);
  });

  it("campaign videos: an unplayable video is refused and deleted", async () => {
    const ctx = setup();
    vi.spyOn(video, "assertRemoteVideoIsPlayable").mockRejectedValue(new video.UnsupportedVideoFormatError("phones can't play this"));
    const { res, ticket } = await uploadThenGetTicket(ctx, "u1", UserRole.brand, { purpose: "campaign-asset", contentType: "video/mp4", size: MP4.length }, { bytes: MP4 });
    await expect(ctx.service.complete("u1", UserRole.brand, res.uploadId)).rejects.toThrow(/phones can't play/);
    expect(ctx.storage.objects[ticket.pendingKey]).toBeUndefined();
    // ffprobe read the file from storage via a signed GET — not via this server.
    expect(ctx.storage.presignGet).toHaveBeenCalledWith(ticket.pendingKey);
  });

  it("campaign videos: if ffprobe can't run here, the upload still goes through (quality check only)", async () => {
    const ctx = setup();
    vi.spyOn(video, "assertRemoteVideoIsPlayable").mockRejectedValue(new video.VideoProbeUnavailableError("no https"));
    const { res } = await uploadThenGetTicket(ctx, "u1", UserRole.brand, { purpose: "campaign-asset", contentType: "video/mp4", size: MP4.length }, { bytes: MP4 });
    await expect(ctx.service.complete("u1", UserRole.brand, res.uploadId)).resolves.toMatchObject({ type: "video" });
  });

  it("avatar: sets the caller's profile photo", async () => {
    const ctx = setup();
    const { res, ticket } = await uploadThenGetTicket(ctx, "u1", UserRole.staff, { purpose: "avatar", contentType: "image/png", size: PNG.length }, { bytes: PNG });
    await ctx.service.complete("u1", UserRole.staff, res.uploadId);
    expect(ctx.prisma.user.update).toHaveBeenCalledWith({ where: { id: "u1" }, data: { avatarUrl: `https://pub.test/${ticket.finalKey}` } });
  });

  it("admin draft copy: re-checks access at completion, then attaches it to the deliverable", async () => {
    const ctx = setup({ deliverable: { participation: { campaign: { id: "c1" } } } });
    const { res } = await uploadThenGetTicket(ctx, "u1", UserRole.staff, { purpose: "admin-draft-copy", contentType: "video/mp4", size: MP4.length, deliverableId: "d1" }, { bytes: MP4 });
    const out = await ctx.service.complete("u1", UserRole.staff, res.uploadId);
    expect(ctx.access.assertCanAccessCampaign).toHaveBeenCalledTimes(2);
    expect(ctx.participation.setAdminDraftCopy).toHaveBeenCalledWith("u1", UserRole.staff, "d1", out.url);
  });
});

describe("BufferedUploadGuard", () => {
  const guard = (r2: boolean, allow: boolean) =>
    new BufferedUploadGuard({ isR2Configured: () => r2 } as never, { get: () => allow } as never);

  it("closes the old through-the-API upload routes when R2 is configured", () => {
    expect(() => guard(true, false).canActivate()).toThrow(GoneException);
  });
  it("keeps them for local dev without R2, or with the rollout escape hatch", () => {
    expect(guard(false, false).canActivate()).toBe(true);
    expect(guard(true, true).canActivate()).toBe(true);
  });
});
