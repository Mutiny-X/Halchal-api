import { BadRequestException } from "@nestjs/common";
import { describe, expect, it } from "vitest";

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
