import { Logger } from "@nestjs/common";

const logger = new Logger("AutoReviewMediaFetch");

// Gemini's inline-data path tops out at 100MB; anything larger needs the
// Files API (not implemented in this pass — falls back to unresolved
// instead, same as any other unfetchable-media case in this pipeline).
const MAX_INLINE_BYTES = 95 * 1024 * 1024;

const EXTENSION_MIME_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
  webm: "video/webm",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  flac: "audio/flac",
};

/** A Google Drive share link ("anyone with the link") isn't itself a
 * fetchable file — it's a webpage. But Drive's own direct-download
 * endpoint, unauthenticated, does return the real file for files that
 * don't trip Drive's "can't scan this file for viruses" interstitial —
 * confirmed live against a real 62.5MB video with no interstitial hit.
 * Returns null for anything that isn't a recognizable Drive file URL. */
function resolveDriveDirectDownloadUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!parsed.hostname.endsWith("drive.google.com")) return null;

  const fileMatch = parsed.pathname.match(/\/file\/d\/([^/]+)/);
  const fileId = fileMatch?.[1] ?? parsed.searchParams.get("id");
  if (!fileId) return null;

  return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`;
}

/** Drive shows an HTML "can't scan this file for viruses, download anyway?"
 * interstitial in place of the real bytes for some larger/riskier files —
 * this is a normal, click-through-able page for a human in a browser, but
 * an automated fetch just sees HTML where it expected the file. The page
 * embeds a real download link with a confirm token; extracting that token
 * and retrying (with the interstitial response's own cookie, which Drive
 * requires on the follow-up request) gets the actual file the same way a
 * person clicking "Download anyway" would, instead of giving up. Returns
 * the original interstitial response unchanged if no token is found (the
 * caller's existing HTML-content-type check still catches that case). */
async function followDriveInterstitialIfPresent(
  res: Response,
  requestUrl: string,
  signal: AbortSignal,
): Promise<Response> {
  const contentType = res.headers.get("content-type");
  if (contentType?.split(";")[0].trim() !== "text/html") return res;

  const html = await res.text();
  const confirmMatch = html.match(/confirm=([0-9A-Za-z_-]+)/);
  if (!confirmMatch) return res;

  const cookie = res.headers.get("set-cookie");
  const retryUrl = new URL(requestUrl);
  retryUrl.searchParams.set("confirm", confirmMatch[1]);

  return fetch(retryUrl.toString(), {
    signal,
    headers: cookie ? { cookie } : undefined,
  });
}

function filenameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;
  const match = header.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  return match ? decodeURIComponent(match[1]) : null;
}

function guessMimeType(
  url: string,
  contentTypeHeader: string | null,
  contentDispositionHeader: string | null,
): string {
  // A real Content-Type header wins when present and specific (R2/S3 sets
  // this from the upload's original mimetype) — the file extension is a
  // fallback for URLs that don't carry one.
  if (contentTypeHeader && contentTypeHeader !== "application/octet-stream") {
    return contentTypeHeader.split(";")[0].trim();
  }
  // Drive's direct-download URL has no file extension of its own (it's
  // `?id=...`, not `/name.mov`) and serves everything as
  // application/octet-stream — the real filename only shows up in
  // Content-Disposition.
  const dispositionName = filenameFromContentDisposition(contentDispositionHeader);
  const path = dispositionName ?? (() => {
    try {
      return new URL(url).pathname;
    } catch {
      return url;
    }
  })();
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_MIME_TYPES[ext] ?? "video/mp4";
}

export type FetchedMedia = { buffer: Buffer; mimeType: string };

export type MediaUrlCheckResult = { fetchable: true } | { fetchable: false; reason: string };

/** Cheap pre-flight for a source-asset URL a brand/admin is about to save —
 * same fetch + interstitial detection as fetchMedia, but never reads the
 * response body, so checking a multi-hundred-MB Drive video doesn't
 * actually download it. Lets the UI surface "this link won't work" at
 * save time instead of only discovering it hours later when the auto-review
 * pipeline runs against a real submission. */
export async function checkMediaUrlFetchable(url: string): Promise<MediaUrlCheckResult> {
  const fetchUrl = resolveDriveDirectDownloadUrl(url) ?? url;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    let res: Response;
    try {
      res = await fetch(fetchUrl, { signal: controller.signal });
      res = await followDriveInterstitialIfPresent(res, fetchUrl, controller.signal);
    } finally {
      clearTimeout(timer);
    }
    await res.body?.cancel().catch(() => {});

    if (!res.ok) {
      return {
        fetchable: false,
        reason:
          res.status === 403 || res.status === 404
            ? 'This link isn\'t publicly accessible. Set sharing to "Anyone with the link" and try again.'
            : `Could not reach this link (HTTP ${res.status}).`,
      };
    }
    const contentType = res.headers.get("content-type");
    if (contentType?.split(";")[0].trim() === "text/html") {
      return {
        fetchable: false,
        reason:
          "Google Drive is showing a security warning page for this file instead of serving it directly " +
          "(happens for some larger files) — we can't auto-download it. Upload the video from your device instead.",
      };
    }
    return { fetchable: true };
  } catch {
    return { fetchable: false, reason: "Could not reach this link — double-check the URL and try again." };
  }
}

/** Fetches a draft/live media file's raw bytes for local inspection
 * (ffprobe) and inline Gemini calls, along with its actual mime type —
 * callers submitting this to Gemini need the real type, not an assumed
 * "video/mp4" for everything (a mislabeled request produces a genuine
 * Gemini-side 500, not a clean validation error — confirmed live against a
 * real .jpg draft). Transparently resolves a Google Drive share link to
 * its direct-download URL first. Returns null on any failure — timeout,
 * non-2xx, too large, or Drive's virus-scan interstitial instead of the
 * real file — so callers can treat "couldn't fetch" as unresolved rather
 * than crashing. */
export async function fetchMedia(url: string): Promise<FetchedMedia | null> {
  const fetchUrl = resolveDriveDirectDownloadUrl(url) ?? url;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    const res = await fetch(fetchUrl, { signal: controller.signal }).finally(() => clearTimeout(timer));
    if (!res.ok) {
      logger.warn(`Fetch failed for ${url}: HTTP ${res.status}`);
      return null;
    }
    const contentType = res.headers.get("content-type");
    if (contentType?.split(";")[0].trim() === "text/html") {
      // Drive serves an HTML "can't scan this file for viruses, download
      // anyway?" interstitial for some larger/riskier files instead of the
      // real bytes — this is the one case a 200 OK doesn't mean success.
      logger.warn(`Media at ${url} returned an HTML page instead of the file (likely Drive's virus-scan interstitial)`);
      return null;
    }
    const contentLength = res.headers.get("content-length");
    if (contentLength && Number(contentLength) > MAX_INLINE_BYTES) {
      logger.warn(`Media at ${url} is ${contentLength} bytes — over the inline-fetch cap`);
      return null;
    }
    const mimeType = guessMimeType(fetchUrl, contentType, res.headers.get("content-disposition"));
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_INLINE_BYTES) {
      logger.warn(`Media at ${url} is ${buf.byteLength} bytes — over the inline-fetch cap`);
      return null;
    }
    return { buffer: buf, mimeType };
  } catch (err) {
    logger.warn(`Fetch error for ${url}: ${err}`);
    return null;
  }
}
