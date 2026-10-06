import { BadRequestException } from "@nestjs/common";

/**
 * Which links a campaign may carry. These are shown to creators and brand
 * stakeholders as links, images, video and embeds, and fetched by the
 * auto-review pipeline — so a link must point where its type says it does:
 *  - "drive" source assets → Google Drive
 *  - "youtube" source assets → YouTube
 *  - uploaded files (source "upload", sample content, cover) → our own storage
 *  - product link → an ordinary http(s) page
 */

const DRIVE_HOSTS = new Set(["drive.google.com", "docs.google.com"]);
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"]);
/** A stored file name: <timestamp>-<hex><.ext> today, but any plain name
 * that doesn't start with a dot (no "..", no hidden files, no slashes). */
const FILE_NAME = "[A-Za-z0-9_-][A-Za-z0-9._-]*";
/** The folder each kind of campaign upload is written to by the API. */
const UPLOAD_FOLDER: Record<"upload" | "cover", string> = {
  upload: "reference-assets",
  cover: "cover-images",
};

export type AssetUrlKind = "drive" | "youtube" | "upload" | "cover" | "product";

function parseWebUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

function isOwnStorageUrl(
  raw: string,
  folder: string,
  storagePublicBaseUrl: string | undefined,
): boolean {
  // Local-disk storage serves files at /uploads/<folder>/<file>.
  if (new RegExp(`^/uploads/${folder}/${FILE_NAME}$`).test(raw)) return true;
  if (!storagePublicBaseUrl) return false;
  const url = parseWebUrl(raw);
  const base = parseWebUrl(storagePublicBaseUrl);
  if (!url || !base || url.search || url.hash) return false;
  // R2: exactly <public base>/<folder>/<file>. The URL parser has already
  // resolved any "..", so this compares the path a browser would request.
  const basePath = base.pathname.replace(/\/$/, "");
  return (
    url.origin === base.origin &&
    new RegExp(`^${basePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/${folder}/${FILE_NAME}$`).test(url.pathname)
  );
}

/** Returns a user-facing problem with `raw`, or null when it's allowed. */
export function assetUrlProblem(
  kind: AssetUrlKind,
  raw: string,
  storagePublicBaseUrl: string | undefined,
): string | null {
  const value = raw.trim();
  switch (kind) {
    case "drive": {
      const url = parseWebUrl(value);
      return url && DRIVE_HOSTS.has(url.hostname.toLowerCase())
        ? null
        : "Drive links must be a Google Drive link (https://drive.google.com/...)";
    }
    case "youtube": {
      const url = parseWebUrl(value);
      return url && YOUTUBE_HOSTS.has(url.hostname.toLowerCase())
        ? null
        : "YouTube links must be a youtube.com or youtu.be link";
    }
    case "upload":
    case "cover":
      return isOwnStorageUrl(value, UPLOAD_FOLDER[kind], storagePublicBaseUrl)
        ? null
        : "Files must be uploaded here — links to other sites can't be used for uploads";
    case "product":
      return parseWebUrl(value) ? null : "Product link must be a web address starting with https://";
  }
}

type AssetLike = { type?: unknown; url?: unknown };

function assetUrls(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((a: AssetLike | null) => (a && typeof a.url === "string" ? a.url.trim() : ""))
    .filter(Boolean);
}

/**
 * Validates every NEW or CHANGED link in a create/update. Links the campaign
 * already holds are left alone on purpose: the wizard re-sends every field on
 * each save, so re-validating an older stored link against today's rules
 * would make that campaign impossible to save at all.
 */
export function assertCampaignUrlsAllowed(
  incoming: {
    sourceAssets?: Array<{ type: string; url: string }>;
    referenceAssets?: Array<{ type: string; url: string }>;
    coverImageUrl?: string;
    productUrl?: string;
  },
  existing: {
    sourceAssets?: unknown;
    referenceAssets?: unknown;
    coverImageUrl?: string | null;
    productUrl?: string | null;
  } | null,
  storagePublicBaseUrl: string | undefined,
): void {
  const known = new Set<string>([
    ...assetUrls(existing?.sourceAssets),
    ...assetUrls(existing?.referenceAssets),
    ...(existing?.coverImageUrl ? [existing.coverImageUrl.trim()] : []),
    ...(existing?.productUrl ? [existing.productUrl.trim()] : []),
  ]);

  const check = (kind: AssetUrlKind, raw: string | undefined, label: string) => {
    const value = raw?.trim();
    if (!value || known.has(value)) return;
    const problem = assetUrlProblem(kind, value, storagePublicBaseUrl);
    if (problem) {
      throw new BadRequestException({ code: "VALIDATION_ERROR", message: `${label}: ${problem}` });
    }
  };

  for (const asset of incoming.sourceAssets ?? []) {
    const kind: AssetUrlKind = asset.type === "drive" ? "drive" : asset.type === "youtube" ? "youtube" : "upload";
    check(kind, asset.url, "Source asset");
  }
  for (const asset of incoming.referenceAssets ?? []) {
    check("upload", asset.url, "Sample content");
  }
  check("cover", incoming.coverImageUrl, "Cover image");
  check("product", incoming.productUrl, "Product link");
}
