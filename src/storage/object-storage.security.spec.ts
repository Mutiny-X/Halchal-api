import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { ObjectStorageService } from "./object-storage.service";

// Fake R2 settings: presigning is a local signature computation, so nothing
// here talks to a network.
const config = {
  get: (key: string) =>
    ({
      S3_ENDPOINT: "https://account.r2.cloudflarestorage.com",
      S3_REGION: "auto",
      S3_BUCKET: "test-bucket",
      S3_ACCESS_KEY_ID: "AKIATEST",
      S3_SECRET_ACCESS_KEY: "secret",
      S3_PUBLIC_BASE_URL: "https://pub.example.com",
    })[key],
};

describe("ObjectStorageService.presignUpload", () => {
  const storage = new ObjectStorageService(config as never);

  it("signs an allowed type and picks the extension from the type, not the file name", async () => {
    const { uploadUrl, publicUrl } = await storage.presignUpload("reference-assets", "evil.html", "video/mp4");
    expect(publicUrl).toMatch(/^https:\/\/pub\.example\.com\/reference-assets\/\d+-[0-9a-f]{16}\.mp4$/);
    expect(publicUrl).not.toContain("evil");
    // The declared Content-Type is part of what's signed, so the browser
    // can't PUT the object with a different (executable) type.
    const params = new URL(uploadUrl).searchParams;
    expect(params.get("X-Amz-SignedHeaders")).toBe("content-type;host");
    // No checksum of an empty body baked into the URL (breaks real R2 PUTs).
    expect(params.has("x-amz-checksum-crc32")).toBe(false);
  });

  it.each(["image/svg+xml", "text/html", "image/svg", "video/x-msvideo", "application/octet-stream", "image/*"])(
    "refuses %s",
    async (contentType) => {
      await expect(storage.presignUpload("reference-assets", "a.mp4", contentType)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    },
  );
});

describe("ObjectStorageService.deleteStoredFile — only ever deletes from allowed folders", () => {
  const make = () => {
    const storage = new ObjectStorageService(config as never);
    const deleteObject = vi.spyOn(storage, "deleteObject").mockResolvedValue(undefined);
    return { storage, deleteObject };
  };

  it("deletes a creator draft and an admin copy (creator work folders)", async () => {
    const { storage, deleteObject } = make();
    expect(await storage.deleteCreatorWorkFile("https://pub.example.com/creator-drafts/1-abc.mp4")).toBe(true);
    expect(await storage.deleteCreatorWorkFile("https://pub.example.com/admin-draft-copies/2-def.mp4")).toBe(true);
    expect(deleteObject.mock.calls.map((c) => c[0])).toEqual(["creator-drafts/1-abc.mp4", "admin-draft-copies/2-def.mp4"]);
  });

  it.each([
    ["a KYC document", "https://pub.example.com/kyc-documents/1-a.png"],
    ["an Aadhaar document", "https://pub.example.com/aadhaar-documents/1-a.png"],
    ["a profile photo", "https://pub.example.com/avatars/1-a.png"],
    ["a campaign cover (wrong group)", "https://pub.example.com/cover-images/1-a.png"],
    ["a nested key", "https://pub.example.com/creator-drafts/x/1-a.mp4"],
    ["a dot-file / traversal", "https://pub.example.com/creator-drafts/..%2F..%2Fkyc"],
    ["another host", "https://evil.example.com/creator-drafts/1-a.mp4"],
    ["a Drive link", "https://drive.google.com/file/d/x/view"],
    ["an Instagram post", "https://www.instagram.com/reel/abc/"],
  ])("never deletes %s via creator-work cleanup", async (_label, url) => {
    const { storage, deleteObject } = make();
    expect(await storage.deleteCreatorWorkFile(url)).toBe(false);
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it("campaign cleanup can't reach creator work, KYC or avatars either", async () => {
    const { storage, deleteObject } = make();
    for (const url of ["https://pub.example.com/creator-drafts/1-a.mp4", "https://pub.example.com/pan-documents/1-a.png"]) {
      expect(await storage.deleteCampaignFile(url)).toBe(false);
    }
    expect(deleteObject).not.toHaveBeenCalled();
  });
});
