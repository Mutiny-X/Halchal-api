import { createCipheriv, createHash, randomBytes } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { validateEnv } from "../config/env";
import { InstagramOAuthService } from "../creator-profiles/instagram-oauth.service";
import { YoutubeOAuthService } from "../creator-profiles/youtube-oauth.service";

const JWT = "j".repeat(40);
const IG_KEY = "instagram-token-key-0123456789-abcdef";
const YT_KEY = "youtube-token-key-0123456789-abcdefgh";

const sha = (s: string) => createHash("sha256").update(s).digest();
function encryptWith(secret: string, value: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", sha(secret), iv);
  const enc = Buffer.concat([c.update(value, "utf8"), c.final()]);
  return `${iv.toString("base64url")}.${c.getAuthTag().toString("base64url")}.${enc.toString("base64url")}`;
}

function config(values: Record<string, string | undefined>) {
  return { get: vi.fn((k: string) => values[k]) } as never;
}

// ── dedicated keys, with the old one as a read-only fallback ──────────────

describe.each([
  ["Instagram", InstagramOAuthService, "INSTAGRAM_TOKEN_ENCRYPTION_KEY", IG_KEY],
  ["YouTube", YoutubeOAuthService, "YOUTUBE_TOKEN_ENCRYPTION_KEY", YT_KEY],
] as const)("%s token encryption", (_name, Service, envKey, key) => {
  type Svc = Record<string, (v: string) => string>;
  const Ctor = Service as unknown as new (a: unknown, b: unknown, c: unknown) => Svc;
  const make = (extra: Record<string, string | undefined> = {}) =>
    new Ctor({}, {}, config({ JWT_SECRET: JWT, [envKey]: key, ...extra }));

  it("writes with the dedicated key — not one derived from the login-signing secret", () => {
    const stored = make().encrypt!("access-token-abc");
    expect(make().decrypt!(stored)).toBe("access-token-abc");
    // The old (JWT-derived) key can no longer open anything written now.
    const legacyOnly = new Ctor({}, {}, config({ JWT_SECRET: JWT }));
    expect(() => legacyOnly.decrypt!(stored)).toThrow();
  });

  it("still reads tokens saved before the dedicated key was required", () => {
    const old = encryptWith(JWT, "legacy-token-xyz");
    expect(make().decrypt!(old)).toBe("legacy-token-xyz");
  });

  it("refuses a token neither key opens", () => {
    expect(() => make().decrypt!(encryptWith("some-other-secret-entirely-0123456789", "x"))).toThrow();
  });
});

describe("production refuses to start without separate token keys", () => {
  const base = {
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://u:p@localhost:5432/db",
    JWT_SECRET: JWT,
    CORS_ORIGINS: "https://app.example.com",
    PAYOUT_ACCOUNT_ENCRYPTION_KEY: "p".repeat(40),
  };

  it("when Instagram is configured but has no key of its own", () => {
    expect(() => validateEnv({ ...base, INSTAGRAM_APP_SECRET: "app-secret" })).toThrow(/INSTAGRAM_TOKEN_ENCRYPTION_KEY is required/);
  });

  it("when YouTube is configured but its key equals the login secret", () => {
    expect(() => validateEnv({ ...base, GOOGLE_CLIENT_SECRET: "g", YOUTUBE_TOKEN_ENCRYPTION_KEY: JWT })).toThrow(/YOUTUBE_TOKEN_ENCRYPTION_KEY is required/);
  });

  it("but not for an integration that isn't configured at all", () => {
    expect(() => validateEnv({ ...base })).not.toThrow();
  });

  it("and starts when each configured integration has its own key", () => {
    expect(() =>
      validateEnv({ ...base, INSTAGRAM_APP_SECRET: "a", INSTAGRAM_TOKEN_ENCRYPTION_KEY: IG_KEY, GOOGLE_CLIENT_SECRET: "g", YOUTUBE_TOKEN_ENCRYPTION_KEY: YT_KEY }),
    ).not.toThrow();
  });
});

// ── disconnecting destroys the stored token ───────────────────────────────

describe("disconnecting a social account", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const profile = { socialLinks: { instagram: "x", youtube: "y" }, socialStats: { instagram: {}, youtube: {} } };
  const profiles = { assertOwnership: vi.fn().mockResolvedValue(profile) };

  it("Instagram: the stored token is wiped, not just flagged", async () => {
    const prisma = {
      instagramConnection: { updateMany: vi.fn().mockReturnValue("a") },
      creatorProfile: { update: vi.fn().mockReturnValue("b") },
      $transaction: vi.fn().mockResolvedValue([]),
    };
    const svc = new InstagramOAuthService(prisma as never, profiles as never, config({ JWT_SECRET: JWT }));
    await svc.disconnect("u1", "p1");
    expect(prisma.instagramConnection.updateMany.mock.calls[0][0].data).toEqual({ isConnected: false, encryptedAccessToken: "" });
  });

  it("YouTube: both tokens are wiped and Google is told to cancel the grant", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as never;
    const prisma = {
      youtubeConnection: {
        findFirst: vi.fn().mockResolvedValue({ encryptedRefreshToken: encryptWith(JWT, "the-refresh-token"), encryptedAccessToken: encryptWith(JWT, "the-access-token") }),
        updateMany: vi.fn().mockReturnValue("a"),
      },
      creatorProfile: { update: vi.fn().mockReturnValue("b") },
      $transaction: vi.fn().mockResolvedValue([]),
    };
    const svc = new YoutubeOAuthService(prisma as never, profiles as never, config({ JWT_SECRET: JWT }));
    await svc.disconnect("u1", "p1");
    expect(prisma.youtubeConnection.updateMany.mock.calls[0][0].data).toEqual({
      isConnected: false,
      encryptedAccessToken: "",
      encryptedRefreshToken: null,
    });
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://oauth2.googleapis.com/revoke");
    expect(String(init.body)).toBe("token=the-refresh-token");
  });

  it("YouTube: still disconnects when Google can't be reached", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("offline")) as never;
    const prisma = {
      youtubeConnection: {
        findFirst: vi.fn().mockResolvedValue({ encryptedRefreshToken: encryptWith(JWT, "rt"), encryptedAccessToken: null }),
        updateMany: vi.fn().mockReturnValue("a"),
      },
      creatorProfile: { update: vi.fn().mockReturnValue("b") },
      $transaction: vi.fn().mockResolvedValue([]),
    };
    const svc = new YoutubeOAuthService(prisma as never, profiles as never, config({ JWT_SECRET: JWT }));
    await expect(svc.disconnect("u1", "p1")).resolves.toEqual({ platform: "youtube", status: "disconnected" });
    expect(prisma.$transaction).toHaveBeenCalled();
  });
});
