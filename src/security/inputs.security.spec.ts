/* Security checks for input validation: outside downloads, file types, links,
 * profile fields, passwords and unexpected fields. Each test asserts the
 * SECURE behaviour; a failing test confirms a weakness. */
import { ValidationPipe } from "@nestjs/common";
import { describe, expect, it, vi, afterAll } from "vitest";

import { AdminLoginDto } from "../auth/dto/admin-auth.dto";
import { BrandLoginDto, BrandResetPasswordDto } from "../auth/dto/brand-auth.dto";
import { ApifyService } from "../common/apify.service";
import { detectFileType, DIRECT_UPLOAD_CONTENT_TYPES } from "../common/file-signature";
import { assertPublicHttpUrl, isNonPublicAddress, setSafeFetchResolverForTests } from "../common/safe-fetch";
import { safeUploadContentType, uploadFilename } from "../common/upload.util";
import { validateEnv } from "../config/env";
import { liveLinkProblem } from "../participation/deliverable-transition";
import { isValidDraftUrl } from "../participation/drive-url";
import { ChangePasswordDto, UpdateProfileDto } from "../users/dto/update-profile.dto";

const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
const accepts = async (cls: unknown, value: unknown) => {
  try { await pipe.transform(value, { type: "body", metatype: cls as never }); return true; } catch { return false; }
};

describe("Outside downloads are blocked from internal addresses", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.5.4", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254", "64:ff9b::a9fe:a9fe"]) {
    it(`treats ${ip} as internal`, () => expect(isNonPublicAddress(ip)).toBe(true));
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) {
    it(`treats ${ip} as public`, () => expect(isNonPublicAddress(ip)).toBe(false));
  }
  setSafeFetchResolverForTests(async (host: string) => (host === "rebind.example" ? ["93.184.216.34", "10.0.0.5"] : ["93.184.216.34"]));
  afterAll(() => setSafeFetchResolverForTests(null));
  for (const url of ["file:///etc/passwd", "gopher://example.com/", "ftp://example.com/x", "http://localhost/x", "http://127.0.0.1/x", "http://[::1]/x", "http://api.railway.internal/x", "http://rebind.example/x", "http://example.com:5432/x", "http://user:pw@example.com/x"]) {
    it(`refuses ${url}`, async () => {
      await expect(assertPublicHttpUrl(url)).rejects.toThrow();
    });
  }
  it("allows a normal https address", async () => {
    await expect(assertPublicHttpUrl("https://example.com/video.mp4")).resolves.toBeTruthy();
  });
});

describe("Uploaded file types are judged by their real contents", () => {
  const bytes = (s: string) => Buffer.from(s, "latin1");
  it("rejects an HTML page", () => expect(detectFileType(bytes("<!doctype html><script>alert(1)</script>"))).toBeNull());
  it("rejects an SVG image (can carry script)", () => expect(detectFileType(bytes('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'))).toBeNull());
  it("rejects a renamed executable", () => expect(detectFileType(bytes("MZ\x90\x00\x03\x00\x00\x00"))).toBeNull());
  it("recognises a real PNG", () => expect(detectFileType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]))?.mimeType).toBe("image/png"));
  it("recognises a real JPEG", () => expect(detectFileType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]))?.mimeType).toBe("image/jpeg"));
  it("direct uploads never sign HTML, SVG or JavaScript", () => {
    for (const t of ["text/html", "image/svg+xml", "application/javascript", "text/javascript", "application/xhtml+xml"]) {
      expect(DIRECT_UPLOAD_CONTENT_TYPES[t]).toBeUndefined();
    }
  });
  it("app uploads don't keep a dangerous extension from the file name [M5]", () => {
    expect(uploadFilename("avatar.html", "text/html")).not.toMatch(/\.html?$/);
  });
  it("app uploads don't keep an .svg extension [M5]", () => {
    expect(uploadFilename("id.svg", "image/svg+xml")).not.toMatch(/\.svg$/);
  });
  it("an unknown file type is stored as an opaque download, never as a web page [M5]", () => {
    expect(uploadFilename("page.html", "text/html")).toMatch(/\.bin$/);
    expect(safeUploadContentType("x.bin")).toBe("application/octet-stream");
    expect(safeUploadContentType("x.html")).toBe("application/octet-stream");
  });
  it("normal photos, PDFs and videos keep their type", () => {
    expect(uploadFilename("IMG_1.HEIC", "image/heic")).toMatch(/\.heic$/);
    expect(uploadFilename("pan.pdf", "application/pdf")).toMatch(/\.pdf$/);
    expect(uploadFilename("clip.MOV", "video/quicktime")).toMatch(/\.mov$/);
    expect(safeUploadContentType("a.mp4")).toBe("video/mp4");
  });
});

describe("Draft and live-post links", () => {
  it("accepts a Google Drive file link", () => expect(isValidDraftUrl("https://drive.google.com/file/d/abc123/view")).toBe(true));
  it("refuses javascript: links", () => expect(isValidDraftUrl("javascript:alert(1)")).toBe(false));
  it("refuses a look-alike Drive host", () => expect(isValidDraftUrl("https://drive.google.com.evil.example/file/d/x")).toBe(false));
  it("refuses another website's /creator-drafts/ path [M7]", () => expect(isValidDraftUrl("https://evil.example/creator-drafts/x.mp4")).toBe(false));
  it("refuses plain-http draft links [M7]", () => expect(isValidDraftUrl("http://files.example/creator-drafts/x.mp4")).toBe(false));
  it("refuses internal addresses as draft links [M7]", () => expect(isValidDraftUrl("http://169.254.169.254/creator-drafts/x")).toBe(false));
  it("accepts a draft uploaded to our own storage, and only there [M7]", () => {
    process.env.S3_PUBLIC_BASE_URL = "https://files.halchal.test";
    expect(isValidDraftUrl("https://files.halchal.test/creator-drafts/1-abc.mp4")).toBe(true);
    expect(isValidDraftUrl("https://files.halchal.test.evil.example/creator-drafts/1-abc.mp4")).toBe(false);
    expect(isValidDraftUrl("https://files.halchal.test/avatars/1-abc.jpg")).toBe(false);
    delete process.env.S3_PUBLIC_BASE_URL;
  });
  for (const url of ["https://instagram.com.evil.example/reel/x", "https://evil.example/?u=instagram.com", "javascript:alert('instagram.com')", "http://www.instagram.com/reel/x"]) {
    it(`refuses ${url} as an Instagram live post`, () => expect(liveLinkProblem("instagram_reel", url)).not.toBeNull());
  }
  it("accepts a real Instagram reel link", () => expect(liveLinkProblem("instagram_reel", "https://www.instagram.com/reel/Cxyz123/")).toBeNull());
  it("refuses an Instagram link for a YouTube clip", () => expect(liveLinkProblem("youtube_shorts", "https://www.instagram.com/reel/x/")).not.toBeNull());
});

describe("Profile fields", () => {
  const apify = new ApifyService({ get: vi.fn() } as never);
  it("connecting Instagram refuses an outside link that merely mentions instagram.com [T2]", () => {
    expect(() => apify.normalizeProfileUrl("instagram", "https://evil.example/?instagram.com")).toThrow();
    expect(() => apify.normalizeProfileUrl("instagram", "https://instagram.com.evil.example/x")).toThrow();
  });
  it("connecting X refuses a javascript: link [T2]", () => {
    expect(() => apify.normalizeProfileUrl("twitter", "javascript:alert('x.com')")).toThrow();
  });
  it("a real profile link is kept, on https, without tracking parameters", () => {
    expect(apify.normalizeProfileUrl("instagram", "instagram.com/halchal?igsh=abc")).toBe("https://instagram.com/halchal");
    expect(apify.normalizeProfileUrl("youtube", "https://www.youtube.com/@halchal")).toBe("https://www.youtube.com/@halchal");
  });
  it("a link is recognised as a platform by its host, not by text inside it", () => {
    expect(apify.detectPlatform("https://www.instagram.com/reel/abc/")).toBe("instagram");
    expect(apify.detectPlatform("https://youtu.be/abc")).toBe("youtube");
    expect(apify.detectPlatform("https://evil.example/?u=instagram.com")).toBe("unknown");
    expect(apify.detectPlatform("https://instagram.com.evil.example/reel/abc")).toBe("unknown");
    expect(apify.detectPlatform("not a link at all")).toBe("unknown");
  });
  it("a plain handle becomes the real profile link", () => {
    expect(apify.normalizeProfileUrl("instagram", "@halchal")).toBe("https://www.instagram.com/halchal/");
  });
  it("social links must be https links [M8]", async () => {
    expect(await accepts(UpdateProfileDto, { socialLinks: { instagram: "javascript:alert(1)" } })).toBe(false);
  });
  it("avatar must be an https image address [M8]", async () => {
    expect(await accepts(UpdateProfileDto, { avatarUrl: "http://tracker.example/pixel.gif" })).toBe(false);
  });
  it("in production an avatar must be a file on our own storage [M8]", async () => {
    process.env.S3_PUBLIC_BASE_URL = "https://files.halchal.test";
    expect(await accepts(UpdateProfileDto, { avatarUrl: "https://tracker.example/pixel.gif" })).toBe(false);
    expect(await accepts(UpdateProfileDto, { avatarUrl: "https://files.halchal.test/avatars/1-abc.jpg" })).toBe(true);
    delete process.env.S3_PUBLIC_BASE_URL;
  });
  it("normal https social links are still accepted", async () => {
    expect(await accepts(UpdateProfileDto, { socialLinks: { instagram: "https://instagram.com/halchal", website: "" } })).toBe(true);
  });
  it("can't set your own role through the profile update", async () => {
    expect(await accepts(UpdateProfileDto, { displayName: "x", role: "admin" })).toBe(false);
  });
  it("can't mark yourself verified through the profile update", async () => {
    expect(await accepts(UpdateProfileDto, { kycStatus: "approved" })).toBe(false);
  });
  it("can't sneak fields in via __proto__", async () => {
    expect(await accepts(UpdateProfileDto, JSON.parse('{"displayName":"x","__proto__":{"role":"admin"}}'))).toBe(true);
    expect(({} as any).role).toBeUndefined();
  });
});

describe("Passwords", () => {
  it("a new password like 12345678 is refused [M12]", async () => {
    expect(await accepts(ChangePasswordDto, { currentPassword: "Old-Pass-1", newPassword: "12345678" })).toBe(false);
  });
  it("a new password like password is refused [M12]", async () => {
    expect(await accepts(ChangePasswordDto, { currentPassword: "Old-Pass-1", newPassword: "password" })).toBe(false);
  });
  it("reset links refuse passwords over 128 characters", async () => {
    expect(await accepts(BrandResetPasswordDto, { token: "t".repeat(64), password: "a".repeat(129) })).toBe(false);
  });
  it("admin sign-in refuses a 100,000-character password [M12]", async () => {
    expect(await accepts(AdminLoginDto, { email: "a@x.test", password: "a".repeat(100_000) })).toBe(false);
  });
  it("team sign-in refuses a 100,000-character password [M12]", async () => {
    expect(await accepts(BrandLoginDto, { email: "a@x.test", password: "a".repeat(100_000) })).toBe(false);
  });
  it("sign-in refuses a malformed email", async () => {
    expect(await accepts(AdminLoginDto, { email: "not-an-email", password: "Long-Password-1" })).toBe(false);
  });
  it("sign-in refuses unexpected extra fields", async () => {
    expect(await accepts(AdminLoginDto, { email: "a@x.test", password: "Long-Password-1", role: "admin" })).toBe(false);
  });
});

describe("Server settings", () => {
  const base = { DATABASE_URL: "postgresql://u@h/db", JWT_SECRET: "x".repeat(64) };
  it("refuses to start without a JWT secret", () => expect(() => validateEnv({ DATABASE_URL: base.DATABASE_URL })).toThrow());
  it("refuses a JWT secret shorter than 32 characters [new: weak minimum]", () => expect(() => validateEnv({ ...base, JWT_SECRET: "x".repeat(16) })).toThrow());
  it("refuses to start in production without CORS_ORIGINS, instead of silently defaulting [N11]", () => expect(() => validateEnv({ ...base, NODE_ENV: "production" })).toThrow());
});
