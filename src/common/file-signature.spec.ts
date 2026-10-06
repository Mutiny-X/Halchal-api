import { describe, expect, it } from "vitest";

import { detectFileType } from "./file-signature";

const bytes = (...parts: Array<number[] | string>) =>
  Buffer.concat(parts.map((p) => (typeof p === "string" ? Buffer.from(p, "latin1") : Buffer.from(p))));

describe("detectFileType", () => {
  it.each([
    ["JPEG", bytes([0xff, 0xd8, 0xff, 0xe0], "rest"), "image/jpeg", ".jpg"],
    ["PNG", bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "rest"), "image/png", ".png"],
    ["WebP", bytes("RIFF", [0, 0, 0, 0], "WEBPVP8 "), "image/webp", ".webp"],
    ["GIF", bytes("GIF89a", "rest"), "image/gif", ".gif"],
    ["MP4", bytes([0, 0, 0, 0x20], "ftypisom", "rest"), "video/mp4", ".mp4"],
    ["M4V", bytes([0, 0, 0, 0x20], "ftypM4V ", "rest"), "video/mp4", ".mp4"],
    ["QuickTime ftyp", bytes([0, 0, 0, 0x14], "ftypqt  ", "rest"), "video/quicktime", ".mov"],
    ["QuickTime moov-first", bytes([0, 0, 0, 0x08], "moov", "rest"), "video/quicktime", ".mov"],
    ["WebM", bytes([0x1a, 0x45, 0xdf, 0xa3], "rest"), "video/webm", ".webm"],
  ])("recognizes %s", (_label, buf, mimeType, extension) => {
    expect(detectFileType(buf)).toMatchObject({ mimeType, extension });
  });

  it.each([
    ["SVG (can carry scripts)", bytes('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
    ["SVG with XML prolog", bytes('<?xml version="1.0"?><svg/>')],
    ["HTML", bytes("<!doctype html><script>alert(1)</script>")],
    ["HTML renamed .jpg (same bytes)", bytes("<html><body>phish</body></html>")],
    ["PDF", bytes("%PDF-1.7")],
    ["plain text", bytes("hello world")],
    ["empty", Buffer.alloc(0)],
    ["truncated PNG header", bytes([0x89, 0x50, 0x4e])],
  ])("rejects %s", (_label, buf) => {
    expect(detectFileType(buf)).toBeNull();
  });
});
