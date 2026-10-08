import { existsSync, mkdirSync } from "node:fs";
import { extname, join } from "node:path";
import { randomBytes } from "node:crypto";

export function ensureUploadDir(...segments: string[]): string {
  const dir = join(process.cwd(), "uploads", ...segments);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

const MIME_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
};

/**
 * The only extensions an upload may be stored under, and the Content-Type
 * each is served with. Both the file name and the type an uploader sends
 * are just claims — a ".html" or ".svg" stored and served as such is a web
 * page on our storage domain. Anything not listed here is kept, but as an
 * opaque download (".bin", application/octet-stream) that no browser runs.
 */
const SAFE_EXTENSION_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
  ".3gp": "video/3gpp",
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpeg",
};
const OPAQUE_EXTENSION = ".bin";
const OPAQUE_TYPE = "application/octet-stream";

/** The extension an upload is stored under: its own if that is a known
 * media/document type, else the one its claimed type maps to, else ".bin". */
export function safeUploadExtension(originalname: string, mimetype: string): string {
  const fromName = extname(originalname).toLowerCase();
  if (SAFE_EXTENSION_TYPES[fromName]) return fromName;
  return MIME_EXT[mimetype?.toLowerCase()] ?? OPAQUE_EXTENSION;
}

/** The Content-Type a stored upload is served with — decided by the stored
 * extension, never by what the uploader claimed. */
export function safeUploadContentType(storedName: string): string {
  return SAFE_EXTENSION_TYPES[extname(storedName).toLowerCase()] ?? OPAQUE_TYPE;
}

export function uploadFilename(originalname: string, mimetype: string): string {
  return `${Date.now()}-${randomBytes(8).toString("hex")}${safeUploadExtension(originalname, mimetype)}`;
}

export { MIME_EXT };
