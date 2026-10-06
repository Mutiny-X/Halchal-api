import { UserRole } from "@prisma/client";

/**
 * Every kind of file the website (brands, staff, admins) uploads from a
 * device. All of them go browser → R2 directly: the API signs the upload,
 * then inspects a few KB and copies the object inside R2 — the file's bytes
 * never pass through the API server's memory or bandwidth.
 */
export type DirectUploadPurpose =
  | "campaign-cover"
  | "campaign-asset"
  | "campaign-source"
  | "brand-logo"
  | "admin-brand-logo"
  | "avatar"
  | "admin-draft-copy";

const MB = 1024 * 1024;
const PICTURE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const IMAGE_TYPES = [...PICTURE_TYPES, "image/gif"];
const VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm", "video/x-m4v"];

export const CONTENT_TYPE_EXTENSION: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "video/x-m4v": ".m4v",
};

export type DirectUploadRule = {
  /** Final folder in the bucket (asset-url-rules checks campaign ones). */
  folder: string;
  roles: UserRole[];
  contentTypes: string[];
  maxBytes: number;
  /** Run the "will this play on phones" check on videos. */
  checkVideoPlayable: boolean;
  /** Needs a deliverableId the caller can write to. */
  needsDeliverable: boolean;
  /** Admin panel section the caller must be able to manage. */
  adminSection?: "brands";
};

export const DIRECT_UPLOAD_RULES: Record<DirectUploadPurpose, DirectUploadRule> = {
  "campaign-cover": {
    folder: "cover-images",
    roles: [UserRole.brand, UserRole.staff, UserRole.admin],
    contentTypes: PICTURE_TYPES,
    maxBytes: 10 * MB,
    checkVideoPlayable: false,
    needsDeliverable: false,
  },
  "campaign-asset": {
    folder: "reference-assets",
    roles: [UserRole.brand, UserRole.staff, UserRole.admin],
    contentTypes: [...IMAGE_TYPES, ...VIDEO_TYPES],
    // R2 caps a single PUT at 4.995 GiB — stay safely under it (and under
    // the 5 GiB single CopyObject limit used to move it into place).
    maxBytes: Math.floor(4.9 * 1024 * MB),
    checkVideoPlayable: true,
    needsDeliverable: false,
  },
  // "Upload from device" source files for creators to reuse — capped
  // lower than sample content (product decision: 3 GB).
  "campaign-source": {
    folder: "reference-assets",
    roles: [UserRole.brand, UserRole.staff, UserRole.admin],
    contentTypes: [...IMAGE_TYPES, ...VIDEO_TYPES],
    maxBytes: 3 * 1024 * MB,
    checkVideoPlayable: true,
    needsDeliverable: false,
  },
  "brand-logo": {
    folder: "brand-logos",
    roles: [UserRole.brand],
    contentTypes: PICTURE_TYPES,
    maxBytes: 5 * MB,
    checkVideoPlayable: false,
    needsDeliverable: false,
  },
  "admin-brand-logo": {
    folder: "brand-logos",
    roles: [UserRole.admin],
    contentTypes: PICTURE_TYPES,
    maxBytes: 5 * MB,
    checkVideoPlayable: false,
    needsDeliverable: false,
    adminSection: "brands",
  },
  avatar: {
    folder: "avatars",
    roles: [UserRole.brand, UserRole.staff, UserRole.admin],
    contentTypes: PICTURE_TYPES,
    maxBytes: 5 * MB,
    checkVideoPlayable: false,
    needsDeliverable: false,
  },
  "admin-draft-copy": {
    folder: "admin-draft-copies",
    roles: [UserRole.brand, UserRole.staff, UserRole.admin],
    contentTypes: [...IMAGE_TYPES, ...VIDEO_TYPES],
    maxBytes: 500 * MB,
    checkVideoPlayable: false,
    needsDeliverable: true,
  },
};

export const DIRECT_UPLOAD_PURPOSES = Object.keys(DIRECT_UPLOAD_RULES) as DirectUploadPurpose[];
