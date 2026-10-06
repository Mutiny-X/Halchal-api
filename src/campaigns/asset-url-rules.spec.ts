import { BadRequestException } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import { assertCampaignUrlsAllowed, assetUrlProblem } from "./asset-url-rules";

const R2 = "https://pub-abc123.r2.dev";

describe("assetUrlProblem", () => {
  it.each([
    ["drive", "https://drive.google.com/file/d/abc/view"],
    ["drive", "https://docs.google.com/uc?export=download&id=abc"],
    ["youtube", "https://www.youtube.com/watch?v=abc"],
    ["youtube", "https://youtu.be/abc"],
    ["upload", `${R2}/reference-assets/1700000000000-0123456789abcdef.mp4`],
    ["upload", "/uploads/reference-assets/1700000000000-0123456789abcdef.mp4"],
    ["cover", "/uploads/cover-images/1700000000000-0123456789abcdef.png"],
    ["product", "https://shop.example.com/item?ref=halchal"],
    ["product", "http://legacy-shop.example.com/"],
  ] as const)("allows %s %s", (kind, url) => {
    expect(assetUrlProblem(kind, url, R2)).toBeNull();
  });

  it.each([
    ["drive", "https://dropbox.com/s/x"],
    ["drive", "https://drive.google.com.evil.com/file/d/x"],
    ["drive", "drive.google.com/file/d/x"],
    ["drive", "http://169.254.169.254/latest/meta-data"],
    ["youtube", "https://vimeo.com/1"],
    ["youtube", "https://youtube.com.evil.com/watch"],
    ["upload", "https://evil.example.com/x.mp4"],
    ["upload", `${R2}.evil.com/reference-assets/x.mp4`],
    ["upload", `${R2}/../../etc/passwd`],
    ["upload", `${R2}/reference-assets/x.mp4?redirect=evil`],
    ["upload", "/uploads/../../etc/passwd"],
    ["upload", "/uploads/reference-assets/.."],
    ["upload", "/uploads/reference-assets/.hidden"],
    ["upload", "/uploads/reference-assets/x.html/../y"],
    ["upload", "javascript:alert(1)"],
    ["cover", "data:image/svg+xml;base64,PHN2Zy8+"],
    ["product", "javascript:alert(document.cookie)"],
    ["product", "ftp://example.com/file"],
    ["product", "https://user:pass@example.com/"],
  ] as const)("refuses %s %s", (kind, url) => {
    expect(assetUrlProblem(kind, url, R2)).not.toBeNull();
  });

  it("without R2 configured, only local /uploads/ paths count as our storage", () => {
    expect(assetUrlProblem("upload", "/uploads/reference-assets/a.png", undefined)).toBeNull();
    expect(assetUrlProblem("upload", `${R2}/reference-assets/a.png`, undefined)).not.toBeNull();
  });

  it("each upload kind must be in its own folder", () => {
    expect(assetUrlProblem("cover", `${R2}/cover-images/a.png`, R2)).toBeNull();
    expect(assetUrlProblem("cover", `${R2}/kyc-documents/a.png`, R2)).not.toBeNull();
    expect(assetUrlProblem("upload", `${R2}/aadhaar-documents/a.png`, R2)).not.toBeNull();
    expect(assetUrlProblem("upload", "/uploads/pan-documents/a.png", undefined)).not.toBeNull();
    // A public base with a path prefix is honoured exactly.
    expect(assetUrlProblem("upload", "https://cdn.example.com/media/reference-assets/a.mp4", "https://cdn.example.com/media/")).toBeNull();
    expect(assetUrlProblem("upload", "https://cdn.example.com/other/reference-assets/a.mp4", "https://cdn.example.com/media")).not.toBeNull();
  });
});

describe("assertCampaignUrlsAllowed", () => {
  it("rejects a new bad link with a message naming the field", () => {
    expect(() =>
      assertCampaignUrlsAllowed({ sourceAssets: [{ type: "drive", url: "https://dropbox.com/s/x" }] }, null, R2),
    ).toThrow(BadRequestException);
    try {
      assertCampaignUrlsAllowed({ referenceAssets: [{ type: "image", url: "https://evil.example/x.png" }] }, null, R2);
    } catch (e) {
      expect(((e as BadRequestException).getResponse() as { message: string }).message).toMatch(/^Sample content:/);
    }
  });

  it("leaves links the campaign ALREADY has alone, so older campaigns stay editable", () => {
    const existing = {
      sourceAssets: [{ type: "drive", url: "drive.google.com/file/d/legacy-no-scheme" }],
      referenceAssets: [{ type: "image", url: "https://old-cdn.example.com/a.png" }],
      coverImageUrl: "https://old-cdn.example.com/cover.png",
      productUrl: "shop.example.com",
    };
    expect(() =>
      assertCampaignUrlsAllowed(
        {
          sourceAssets: [{ type: "drive", url: "drive.google.com/file/d/legacy-no-scheme" }],
          referenceAssets: [{ type: "image", url: "https://old-cdn.example.com/a.png" }],
          coverImageUrl: "https://old-cdn.example.com/cover.png",
          productUrl: "shop.example.com",
        },
        existing,
        R2,
      ),
    ).not.toThrow();
  });

  it("…but a NEW bad link added next to legacy ones is still refused", () => {
    expect(() =>
      assertCampaignUrlsAllowed(
        {
          sourceAssets: [
            { type: "drive", url: "drive.google.com/file/d/legacy-no-scheme" },
            { type: "youtube", url: "https://evil.example.com/" },
          ],
        },
        { sourceAssets: [{ type: "drive", url: "drive.google.com/file/d/legacy-no-scheme" }] },
        R2,
      ),
    ).toThrow(BadRequestException);
  });

  it("an existing URL reused under a different field still counts as known (no false refusal)", () => {
    expect(() =>
      assertCampaignUrlsAllowed({ coverImageUrl: "https://old-cdn.example.com/a.png" }, { referenceAssets: [{ url: "https://old-cdn.example.com/a.png" }] }, R2),
    ).not.toThrow();
  });
});
