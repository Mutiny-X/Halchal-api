/**
 * Identifies an uploaded file from its leading bytes ("magic numbers")
 * instead of trusting the browser-supplied MIME type or file name, both of
 * which the uploader fully controls. Only formats we deliberately serve back
 * to people are recognized — notably NOT SVG or HTML, which a browser will
 * execute scripts from when opened directly off our storage domain.
 */
export type DetectedFileType = {
  mimeType: string;
  extension: string;
  kind: "image" | "video";
};

const JPEG: DetectedFileType = { mimeType: "image/jpeg", extension: ".jpg", kind: "image" };
const PNG: DetectedFileType = { mimeType: "image/png", extension: ".png", kind: "image" };
const WEBP: DetectedFileType = { mimeType: "image/webp", extension: ".webp", kind: "image" };
const GIF: DetectedFileType = { mimeType: "image/gif", extension: ".gif", kind: "image" };
const MP4: DetectedFileType = { mimeType: "video/mp4", extension: ".mp4", kind: "video" };
const MOV: DetectedFileType = { mimeType: "video/quicktime", extension: ".mov", kind: "video" };
const WEBM: DetectedFileType = { mimeType: "video/webm", extension: ".webm", kind: "video" };

function ascii(buf: Buffer, start: number, end: number): string {
  return buf.subarray(start, end).toString("latin1");
}

/** ISO base-media (MP4 family): bytes 4-7 are a box type. An `ftyp` box
 * carries a brand saying which flavour; older QuickTime files can open
 * straight onto another top-level box instead. */
function detectIsoBaseMedia(buf: Buffer): DetectedFileType | null {
  if (buf.length < 12) return null;
  const box = ascii(buf, 4, 8);
  if (box === "ftyp") {
    const brand = ascii(buf, 8, 12);
    return brand === "qt  " ? MOV : MP4;
  }
  if (["moov", "mdat", "wide", "free", "skip"].includes(box)) {
    return MOV;
  }
  return null;
}

export function detectFileType(buf: Buffer): DetectedFileType | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return JPEG;
  }
  if (
    buf.length >= 8 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return PNG;
  }
  if (buf.length >= 12 && ascii(buf, 0, 4) === "RIFF" && ascii(buf, 8, 12) === "WEBP") {
    return WEBP;
  }
  if (buf.length >= 6 && (ascii(buf, 0, 6) === "GIF87a" || ascii(buf, 0, 6) === "GIF89a")) {
    return GIF;
  }
  if (buf.length >= 4 && buf.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    return WEBM;
  }
  return detectIsoBaseMedia(buf);
}

/** Content types a browser may PUT straight to storage through a presigned
 * URL (large videos). The bytes never pass through the API there, so the
 * declared type is pinned into the signature instead — storage then serves
 * the object with exactly this type, never as something executable. */
export const DIRECT_UPLOAD_CONTENT_TYPES: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "video/x-m4v": ".m4v",
};
