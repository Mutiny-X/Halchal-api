import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  PORT: z.coerce.number().default(3001),
  DATABASE_URL: z.string().min(1),
  /** Signs every sign-in token. At least 32 random characters. */
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  JWT_ACCESS_TTL: z.string().default("15m"),
  JWT_REFRESH_TTL: z.string().default("7d"),
  /** Password reset link lifetime, e.g. `1h`, `30m` */
  PASSWORD_RESET_TTL: z.string().default("1h"),
  REDIS_URL: z.string().optional(),
  /** Comma-separated websites allowed to call the API. Required in
   * production (see validateEnv) — there is no safe value to assume. */
  CORS_ORIGINS: z.string().default("http://localhost:3000"),
  /**
   * Lets the App Store / Play Store reviewer phone numbers and per-account
   * fixed OTP codes work in production. Off by default: turn it on for a
   * store review, off again afterwards. Always on outside production.
   */
  /** Serves the interactive API reference at /docs in production. Off by
   * default there; always on outside production. Read in main.ts. */
  ENABLE_API_DOCS: z.string().optional(),
  REVIEWER_OTP_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  /** Unified portal public URL (reset links, invite links). */
  WEB_URL: z.string().url().default("http://localhost:3000"),
  /** Staff portal URL — used in welcome emails. Falls back to WEB_URL if unset. */
  STAFF_WEB_URL: z.string().url().optional(),
  /** @deprecated use WEB_URL */
  BRAND_WEB_URL: z.string().url().optional(),
  /** @deprecated use WEB_URL */
  AGENCY_WEB_URL: z.string().url().optional(),
  /** Brand owner invite link lifetime, e.g. `7d` */
  BRAND_INVITE_TTL: z.string().default("7d"),
  WITHDRAWAL_FEE_BPS: z.coerce.number().default(500),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_API_VERSION: z.string().default("v25.0"),
  WHATSAPP_OTP_TEMPLATE_NAME: z.string().optional(),
  /** Meta template language code, e.g. en or en_US (must match approved template). */
  WHATSAPP_OTP_TEMPLATE_LANGUAGE: z.string().default("en"),
  /** Set false only if your WhatsApp template has no URL button. Defaults true (halchal_otp_login has a button). */
  WHATSAPP_OTP_TEMPLATE_HAS_BUTTON: z
    .string()
    .default("true")
    .transform((v) => v === "true" || v === "1"),
  /** Approved Meta template for admin bulk broadcasts, e.g. "mutiny_general_update".
   * Unset until a general-purpose template is approved — bulk WhatsApp sends
   * report as not-configured until then. Expected body params: {{1}} recipient
   * name, {{2}} title, {{3}} message. */
  WHATSAPP_GENERAL_TEMPLATE_NAME: z.string().optional(),
  WHATSAPP_GENERAL_TEMPLATE_LANGUAGE: z.string().default("en"),
  /** Resend HTTP API key (preferred on Railway; same `re_...` key as SMTP password). */
  RESEND_API_KEY: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(465),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  OTP_TTL_SECONDS: z.coerce.number().default(600),
  OTP_MAX_ATTEMPTS: z.coerce.number().default(5),
  /** When true, log OTP codes in API console (use with NODE_ENV=development). */
  OTP_DEV_LOG: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  /**
   * Fixed OTP for local testing (e.g. 000000). Only used when NODE_ENV=development.
   * Run seed for demo creator phones; no WhatsApp required.
   */
  OTP_DEV_BYPASS_CODE: z.string().length(6).optional(),
  /** Cloudflare R2 (S3-compatible). When all five are set, uploads go to R2. */
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default("auto"),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_PUBLIC_BASE_URL: z.string().url().optional(),
  /** Latest published version, e.g. "1.2.0". Unset = no update banner shown. */
  APP_LATEST_IOS_VERSION: z.string().optional(),
  APP_LATEST_ANDROID_VERSION: z.string().optional(),
  APP_STORE_URL: z.string().url().optional(),
  PLAY_STORE_URL: z.string().url().optional(),
  /** Instagram Login for creator social connection. */
  INSTAGRAM_APP_ID: z.string().optional(),
  INSTAGRAM_APP_SECRET: z.string().optional(),
  INSTAGRAM_REDIRECT_URI: z.string().url().optional(),
  INSTAGRAM_GRAPH_API_VERSION: z.string().default("v23.0"),
  INSTAGRAM_OAUTH_SCOPES: z.string().default("instagram_business_basic"),
  INSTAGRAM_OAUTH_DEBUG_LOG_SECRETS: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  INSTAGRAM_TOKEN_ENCRYPTION_KEY: z.string().optional(),
  /** Gates Clip Marketplace reposts that publish to Instagram on a clipper's
   * behalf. Default off — only enable once INSTAGRAM_APP_ID etc. point at an
   * app with instagram_business_content_publish approved (or a dev-mode test
   * user for sandbox testing). */
  INSTAGRAM_PUBLISHING_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  /** Google OAuth for creator YouTube social connection. */
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  YOUTUBE_REDIRECT_URI: z.string().url().optional(),
  YOUTUBE_OAUTH_SCOPES: z
    .string()
    .default(
      "https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly https://www.googleapis.com/auth/youtube.upload",
    ),
  YOUTUBE_TOKEN_ENCRYPTION_KEY: z.string().optional(),
  /** Gates Clip Marketplace reposts that upload to YouTube on a clipper's
   * behalf. Default off, same reasoning as INSTAGRAM_PUBLISHING_ENABLED.
   * Existing YouTube connections were granted before the youtube.upload
   * scope existed — those creators must reconnect before their first
   * repost regardless of this flag. */
  YOUTUBE_PUBLISHING_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  PAYOUT_ACCOUNT_ENCRYPTION_KEY: z.string().optional(),
  /** Gemini API key for the automated proof-of-work review pipeline's Tier 2
   * content-compliance checks (draft and live-proof stages both use this). */
  GEMINI_API_KEY: z.string().optional(),
  /** Master switch for the whole automated proof-of-work review pipeline —
   * both stages, both tiers. Default off: with no key configured or this
   * unset, nothing runs and nothing is called. */
  AUTO_REVIEW_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  /** When true, an `auto_approved`/`auto_rejected` decision actually applies
   * — approving/rejecting the real deliverable, same as a human would,
   * instead of only being logged. `needs_review` decisions are never
   * enforced; a human always reviews those. Requires AUTO_REVIEW_ENABLED.
   * Default off — shadow-mode logging only. */
  AUTO_REVIEW_ENFORCE_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  /** Cashfree Secure ID (Verification Suite) credentials — a separate
   * product from Cashfree Payments; having one doesn't mean the other is
   * active on the same account. Used for real PAN + Aadhaar verification
   * during clipper signup. With no key configured, CashfreeVerificationService
   * degrades to not-configured (same pattern as GeminiService/ApifyService),
   * so nothing here is called until real credentials exist. */
  CASHFREE_CLIENT_ID: z.string().optional(),
  CASHFREE_CLIENT_SECRET: z.string().optional(),
  /** "sandbox" (default) or "production" — selects which Cashfree base URL
   * to call. Sandbox responses are mocked by Cashfree, not real lookups. */
  CASHFREE_ENV: z.enum(["sandbox", "production"]).default("sandbox"),
  /** Firebase Admin SDK service account JSON, base64-encoded (one line —
   * Firebase Console > Project Settings > Service Accounts > Generate new
   * private key, then `base64 -i key.json`). Unset = push notifications
   * report as not-configured and only log what would be sent. */
  FIREBASE_SERVICE_ACCOUNT_BASE64: z.string().optional(),
  /** Rollout escape hatch: re-opens the website's old upload routes that
   * send file bytes through this API even when R2 is configured. Leave
   * unset — the website uploads straight to R2 via /uploads/direct. */
  ALLOW_BUFFERED_WEB_UPLOADS: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),
}).superRefine((data, ctx) => {
  const r2Fields = [
    ["S3_ENDPOINT", data.S3_ENDPOINT],
    ["S3_BUCKET", data.S3_BUCKET],
    ["S3_ACCESS_KEY_ID", data.S3_ACCESS_KEY_ID],
    ["S3_SECRET_ACCESS_KEY", data.S3_SECRET_ACCESS_KEY],
    ["S3_PUBLIC_BASE_URL", data.S3_PUBLIC_BASE_URL],
  ] as const;
  const setCount = r2Fields.filter(([, value]) => Boolean(value)).length;

  if (setCount === 0 || setCount === r2Fields.length) {
    return;
  }

  for (const [field] of r2Fields) {
    ctx.addIssue({
      code: "custom",
      path: [field],
      message: "Set all S3_* variables together for R2 uploads, or leave them all unset",
    });
  }
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(
  config: Record<string, unknown>,
): Env {
  const normalized = { ...config };
  if (!normalized.WEB_URL) {
    normalized.WEB_URL =
      normalized.BRAND_WEB_URL ?? normalized.AGENCY_WEB_URL ?? "http://localhost:3000";
  }
  if (normalized.NODE_ENV === "production" && !String(normalized.CORS_ORIGINS ?? "").trim()) {
    throw new Error(
      "Invalid environment: CORS_ORIGINS is required in production (comma-separated website addresses allowed to call the API)",
    );
  }
  const parsed = envSchema.safeParse(normalized);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment: ${message}`);
  }

  const env = parsed.data;
  if (
    env.OTP_DEV_BYPASS_CODE &&
    env.NODE_ENV !== "development"
  ) {
    console.warn(
      "[env] OTP_DEV_BYPASS_CODE is set but ignored outside NODE_ENV=development",
    );
  }
  if (env.OTP_DEV_LOG && env.NODE_ENV !== "development") {
    console.warn(
      "[env] OTP_DEV_LOG is set but OTP console logging only runs in NODE_ENV=development",
    );
  }

  return env;
}
