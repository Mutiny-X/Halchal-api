const GOOGLE_DRIVE_HOST = "drive.google.com";

export function isGoogleDriveUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }

  if (parsed.protocol !== "https:") return false;
  if (parsed.hostname.toLowerCase() !== GOOGLE_DRIVE_HOST) return false;

  const path = parsed.pathname.toLowerCase();
  return (
    path.startsWith("/file/") ||
    path.startsWith("/open") ||
    path.startsWith("/drive/")
  );
}

const DRAFT_FOLDER = "creator-drafts";
/** Hosts the API serves its own local-disk uploads from when no object
 * storage is configured — development only. */
const LOCAL_UPLOAD_HOSTS = new Set(["localhost", "127.0.0.1", "10.0.2.2"]);

/**
 * True only for a file uploaded through this API: a link into the
 * creator-drafts folder of OUR storage. The host is checked, not just the
 * path — a link to anyone else's site whose path happens to contain
 * "/creator-drafts/" is not an upload, and the server later downloads these
 * links itself (auto-review, marketplace reposts).
 */
export function isUploadedFileUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password) return false;

  const storageBase = process.env.S3_PUBLIC_BASE_URL?.trim();
  if (storageBase) {
    try {
      const base = new URL(storageBase);
      const prefix = `${base.pathname.replace(/\/$/, "")}/${DRAFT_FOLDER}/`;
      if (
        parsed.protocol === "https:" &&
        base.protocol === "https:" &&
        parsed.host === base.host &&
        parsed.pathname.startsWith(prefix)
      ) {
        return true;
      }
    } catch {
      // a malformed base matches nothing
    }
  }

  // Local-disk uploads: only outside production, only on the local machine.
  return (
    process.env.NODE_ENV !== "production" &&
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    LOCAL_UPLOAD_HOSTS.has(parsed.hostname) &&
    parsed.pathname.startsWith(`/uploads/${DRAFT_FOLDER}/`)
  );
}

export function isValidDraftUrl(url: string): boolean {
  return isGoogleDriveUrl(url) || isUploadedFileUrl(url);
}

export const GOOGLE_DRIVE_URL_MESSAGE =
  "draftDriveUrl must be a Google Drive link (https://drive.google.com/...) with sharing set to Anyone with the link";

export const DRAFT_URL_MESSAGE =
  "draftDriveUrl must be a Google Drive link or an uploaded file URL";
