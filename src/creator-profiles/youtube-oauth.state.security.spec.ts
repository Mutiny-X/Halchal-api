import { BadRequestException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { YoutubeOAuthService } from "./youtube-oauth.service";

const ME = "user-1";
const PROFILE = "profile-1";
const sha = (v: string) => createHash("sha256").update(v).digest("hex");

function build(stored?: Partial<{ userId: string; creatorProfileId: string; consumedAt: Date | null; expiresAt: Date }>) {
  const rows: Record<string, unknown>[] = [];
  const prisma = {
    youtubeOAuthTransaction: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      create: vi.fn().mockImplementation(async ({ data }) => {
        rows.push({ id: `tx-${rows.length + 1}`, consumedAt: null, ...data });
        return rows.at(-1);
      }),
      findUnique: vi.fn().mockImplementation(async ({ where }) => {
        if (stored) return { id: "tx-x", stateHash: where.stateHash, codeVerifier: "verifier-abc", userId: ME, creatorProfileId: PROFILE, consumedAt: null, expiresAt: new Date(Date.now() + 60_000), ...stored };
        return rows.find((r) => r.stateHash === where.stateHash) ?? null;
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const profiles = { assertOwnership: vi.fn().mockResolvedValue(undefined) };
  const values: Record<string, string> = {
    GOOGLE_CLIENT_ID: "client-id",
    GOOGLE_CLIENT_SECRET: "client-secret",
    YOUTUBE_REDIRECT_URI: "https://api.example.com/cb",
    YOUTUBE_OAUTH_SCOPES: "scope-a",
    JWT_SECRET: "j".repeat(40),
  };
  const config = { get: vi.fn((k: string) => values[k]) };
  const service = new YoutubeOAuthService(prisma as never, profiles as never, config as never);
  return { service, prisma, rows };
}

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return ((e as BadRequestException).getResponse() as { code?: string }).code;
  }
  return undefined;
};

describe("YouTube connect — authorization URL", () => {
  it("mints its own state, remembers only its hash, and asks Google for PKCE", async () => {
    const { service, rows } = build();
    const out = await service.authUrl(ME, PROFILE);
    const url = new URL(out.authorizationUrl);
    const state = url.searchParams.get("state")!;
    expect(state).toBe(out.state);
    expect(state.length).toBeGreaterThanOrEqual(24);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stateHash: sha(state), userId: ME, creatorProfileId: PROFILE });
    expect(JSON.stringify(rows[0])).not.toContain(state);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    // The challenge is the SHA-256 of the verifier kept on the server.
    const verifier = (rows[0] as { codeVerifier: string }).codeVerifier;
    expect(url.searchParams.get("code_challenge")).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(url.search).not.toContain(verifier);
  });

  it("expires the attempt after ten minutes", async () => {
    const { service, rows } = build();
    await service.authUrl(ME, PROFILE);
    const ttl = (rows[0] as { expiresAt: Date }).expiresAt.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(9 * 60_000);
    expect(ttl).toBeLessThanOrEqual(10 * 60_000);
  });
});

describe("YouTube connect — redeeming the code", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    // Stop at Google's token endpoint: what matters here is whether we got that far, and with what.
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({}) }) as never;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("refuses a missing state, before contacting Google", async () => {
    const { service } = build();
    expect(await codeOf(service.connect(ME, PROFILE, "auth-code", ""))).toBe("YOUTUBE_STATE_INVALID");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("refuses a state nobody started", async () => {
    const { service } = build();
    expect(await codeOf(service.connect(ME, PROFILE, "auth-code", "made-up-state"))).toBe("YOUTUBE_STATE_INVALID");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("refuses a state started by a different account — the stolen-code case", async () => {
    const { service } = build({ userId: "someone-else" });
    expect(await codeOf(service.connect(ME, PROFILE, "stolen-code", "their-state"))).toBe("YOUTUBE_STATE_INVALID");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("refuses a state started for a different profile", async () => {
    const { service } = build({ creatorProfileId: "profile-2" });
    expect(await codeOf(service.connect(ME, PROFILE, "code", "state"))).toBe("YOUTUBE_STATE_INVALID");
  });

  it("refuses a state that was already used", async () => {
    const { service } = build({ consumedAt: new Date() });
    expect(await codeOf(service.connect(ME, PROFILE, "code", "state"))).toBe("YOUTUBE_STATE_INVALID");
  });

  it("refuses an expired state", async () => {
    const { service } = build({ expiresAt: new Date(Date.now() - 1000) });
    expect(await codeOf(service.connect(ME, PROFILE, "code", "state"))).toBe("YOUTUBE_STATE_INVALID");
  });

  it("loses the race when two requests redeem the same state at once", async () => {
    const { service, prisma } = build({});
    prisma.youtubeOAuthTransaction.updateMany.mockResolvedValue({ count: 0 });
    expect(await codeOf(service.connect(ME, PROFILE, "code", "state"))).toBe("YOUTUBE_STATE_INVALID");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("spends a valid attempt first, then sends Google the server-held PKCE verifier", async () => {
    const { service, prisma } = build({});
    await codeOf(service.connect(ME, PROFILE, "the-code", "good-state"));
    expect(prisma.youtubeOAuthTransaction.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "tx-x", consumedAt: null } }),
    );
    const body = String((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body).toContain("code_verifier=verifier-abc");
    expect(body).toContain("code=the-code");
  });
});
