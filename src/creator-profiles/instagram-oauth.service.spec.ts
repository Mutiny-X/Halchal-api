import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InstagramOAuthService } from "./instagram-oauth.service";

function makePrisma() {
  return {
    instagramConnection: { findUnique: vi.fn() },
  };
}

function makeConfig() {
  const values: Record<string, string> = {
    INSTAGRAM_GRAPH_API_VERSION: "v23.0",
    INSTAGRAM_TOKEN_ENCRYPTION_KEY: "test-encryption-key-not-a-real-secret",
  };
  return { get: vi.fn((key: string) => values[key]) };
}

function makeResponse(body: unknown, ok = true) {
  return {
    ok,
    status: ok ? 200 : 400,
    json: async () => body,
  } as unknown as Response;
}

describe("InstagramOAuthService.getMediaInsightsForPost", () => {
  let prisma: ReturnType<typeof makePrisma>;
  let service: InstagramOAuthService;

  beforeEach(() => {
    prisma = makePrisma();
    service = new InstagramOAuthService(prisma as never, {} as never, makeConfig() as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function connectedRow(overrides: Record<string, unknown> = {}) {
    // Encrypt with the real method so getValidAccessToken's decrypt() round-trips —
    // exercises the actual crypto path rather than mocking it away.
    const encryptedAccessToken = (service as unknown as { encrypt(v: string): string }).encrypt("real-token");
    return {
      creatorProfileId: "profile-1",
      platformUserId: "ig-user-1",
      isConnected: true,
      encryptedAccessToken,
      tokenExpiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
      ...overrides,
    };
  }

  it("returns null immediately for a URL that isn't a recognizable Instagram post/reel link", async () => {
    const result = await service.getMediaInsightsForPost("profile-1", "https://example.com/not-instagram");
    expect(result).toBeNull();
    expect(prisma.instagramConnection.findUnique).not.toHaveBeenCalled();
  });

  it("returns null when the creator has no connected Instagram account", async () => {
    prisma.instagramConnection.findUnique.mockResolvedValue(null);

    const result = await service.getMediaInsightsForPost(
      "profile-1",
      "https://www.instagram.com/reel/Cxyz123/",
    );

    expect(result).toBeNull();
  });

  it("returns null when the connection exists but isConnected is false", async () => {
    prisma.instagramConnection.findUnique.mockResolvedValue(connectedRow({ isConnected: false }));

    const result = await service.getMediaInsightsForPost(
      "profile-1",
      "https://www.instagram.com/reel/Cxyz123/",
    );

    expect(result).toBeNull();
  });

  it("matches the post by shortcode (ignoring query params/trailing slash) and returns mapped metrics", async () => {
    prisma.instagramConnection.findUnique.mockResolvedValue(connectedRow());
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes("/media?")) {
        return makeResponse({
          data: [
            { id: "other-media", permalink: "https://www.instagram.com/reel/Different1/" },
            { id: "media-42", permalink: "https://www.instagram.com/reel/Cxyz123/" },
          ],
        });
      }
      if (u.includes("/insights?")) {
        return makeResponse({
          data: [
            { name: "views", total_value: { value: 12345 } },
            { name: "reach", total_value: { value: 9000 } },
            { name: "likes", values: [{ value: 500 }] },
            { name: "comments", total_value: { value: 20 } },
            { name: "shares", total_value: { value: 7 } },
          ],
        });
      }
      throw new Error(`unexpected fetch: ${u}`);
    });

    const result = await service.getMediaInsightsForPost(
      "profile-1",
      "https://www.instagram.com/reel/Cxyz123/?utm_source=ig_web_copy_link",
    );

    expect(result).toEqual({
      viewCount: 12345,
      reach: 9000,
      likeCount: 500,
      commentCount: 20,
      shareCount: 7,
      platform: "instagram",
    });
    // Confirms the insights call was made against the matched media id, not the other one.
    expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining("/media-42/insights"), expect.anything());
  });

  it("returns null when the post isn't found within the page cap (no Apify fallback — Instagram-only)", async () => {
    prisma.instagramConnection.findUnique.mockResolvedValue(connectedRow());
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeResponse({ data: [{ id: "other-media", permalink: "https://www.instagram.com/reel/Different1/" }] }),
    );

    const result = await service.getMediaInsightsForPost(
      "profile-1",
      "https://www.instagram.com/reel/NotFound99/",
    );

    expect(result).toBeNull();
  });

  it("pages further back when the post isn't on the first page", async () => {
    prisma.instagramConnection.findUnique.mockResolvedValue(connectedRow());
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes("after=cursor-page-2")) {
        // Second page: the actual post, further back than the first 100.
        return makeResponse({ data: [{ id: "media-old", permalink: "https://www.instagram.com/reel/OldPost1/" }] });
      }
      if (u.includes("/media?")) {
        // First page: no match, but says there's more.
        return makeResponse({
          data: [{ id: "other-media", permalink: "https://www.instagram.com/reel/Different1/" }],
          paging: { next: "https://graph.instagram.com/v23.0/ig-user-1/media?after=cursor-page-2" },
        });
      }
      if (u.includes("/insights?")) {
        return makeResponse({ data: [{ name: "views", total_value: { value: 500 } }] });
      }
      throw new Error(`unexpected fetch: ${u}`);
    });

    const result = await service.getMediaInsightsForPost(
      "profile-1",
      "https://www.instagram.com/reel/OldPost1/",
    );

    expect(result?.viewCount).toBe(500);
    expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining("after=cursor-page-2"), expect.anything());
  });

  it("stops paginating after the page cap instead of following paging.next forever", async () => {
    prisma.instagramConnection.findUnique.mockResolvedValue(connectedRow());
    let pageCount = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      pageCount++;
      return makeResponse({
        data: [{ id: `media-${pageCount}`, permalink: "https://www.instagram.com/reel/NeverThere/" }],
        paging: { next: `https://graph.instagram.com/v23.0/ig-user-1/media?after=page-${pageCount + 1}` },
      });
    });

    const result = await service.getMediaInsightsForPost(
      "profile-1",
      "https://www.instagram.com/reel/WontBeFound/",
    );

    expect(result).toBeNull();
    // Only the /media list calls happen here (never reaches /insights), so this count is the page count.
    expect(fetchSpy).toHaveBeenCalledTimes(5);
  });

  it("returns null (never throws) when the Graph API denies the insights permission", async () => {
    prisma.instagramConnection.findUnique.mockResolvedValue(connectedRow());
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes("/media?")) {
        return makeResponse({ data: [{ id: "media-42", permalink: "https://www.instagram.com/reel/Cxyz123/" }] });
      }
      // Simulates a token that lacks instagram_business_manage_insights.
      return makeResponse({ error: { message: "Permission denied", code: 10 } }, false);
    });

    const result = await service.getMediaInsightsForPost(
      "profile-1",
      "https://www.instagram.com/reel/Cxyz123/",
    );

    expect(result).toBeNull();
  });

  it("returns null (never throws) on a network error", async () => {
    prisma.instagramConnection.findUnique.mockResolvedValue(connectedRow());
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));

    const result = await service.getMediaInsightsForPost(
      "profile-1",
      "https://www.instagram.com/reel/Cxyz123/",
    );

    expect(result).toBeNull();
  });
});

describe("InstagramOAuthService.getOwnLivePostMedia", () => {
  let prisma: ReturnType<typeof makePrisma>;
  let service: InstagramOAuthService;

  beforeEach(() => {
    prisma = makePrisma();
    service = new InstagramOAuthService(prisma as never, {} as never, makeConfig() as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function connectedRow(overrides: Record<string, unknown> = {}) {
    const encryptedAccessToken = (service as unknown as { encrypt(v: string): string }).encrypt("real-token");
    return {
      creatorProfileId: "profile-1",
      platformUserId: "ig-user-1",
      isConnected: true,
      encryptedAccessToken,
      tokenExpiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
      ...overrides,
    };
  }

  it("returns the real media_url for a matched video post", async () => {
    prisma.instagramConnection.findUnique.mockResolvedValue(connectedRow());
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeResponse({
        data: [
          {
            id: "media-42",
            permalink: "https://www.instagram.com/reel/Cxyz123/",
            media_type: "VIDEO",
            media_url: "https://real-cdn.example.com/video.mp4",
            thumbnail_url: "https://real-cdn.example.com/thumb.jpg",
          },
        ],
      }),
    );

    const result = await service.getOwnLivePostMedia("profile-1", "https://www.instagram.com/reel/Cxyz123/");

    expect(result).toEqual({ kind: "video", url: "https://real-cdn.example.com/video.mp4" });
  });

  it("returns the image media_url for a non-video post", async () => {
    prisma.instagramConnection.findUnique.mockResolvedValue(connectedRow());
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeResponse({
        data: [
          {
            id: "media-42",
            permalink: "https://www.instagram.com/p/Cxyz123/",
            media_type: "IMAGE",
            media_url: "https://real-cdn.example.com/photo.jpg",
          },
        ],
      }),
    );

    const result = await service.getOwnLivePostMedia("profile-1", "https://www.instagram.com/p/Cxyz123/");

    expect(result).toEqual({ kind: "image", url: "https://real-cdn.example.com/photo.jpg" });
  });

  it("falls back to thumbnail_url when there's no direct media_url", async () => {
    prisma.instagramConnection.findUnique.mockResolvedValue(connectedRow());
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeResponse({
        data: [
          {
            id: "media-42",
            permalink: "https://www.instagram.com/reel/Cxyz123/",
            media_type: "VIDEO",
            thumbnail_url: "https://real-cdn.example.com/thumb.jpg",
          },
        ],
      }),
    );

    const result = await service.getOwnLivePostMedia("profile-1", "https://www.instagram.com/reel/Cxyz123/");

    expect(result).toEqual({ kind: "image", url: "https://real-cdn.example.com/thumb.jpg" });
  });

  it("returns null when the post isn't found on the connected account", async () => {
    prisma.instagramConnection.findUnique.mockResolvedValue(connectedRow());
    vi.spyOn(globalThis, "fetch").mockResolvedValue(makeResponse({ data: [] }));

    const result = await service.getOwnLivePostMedia("profile-1", "https://www.instagram.com/reel/NotThere/");

    expect(result).toBeNull();
  });

  it("returns null (never throws) when the Graph API call fails", async () => {
    prisma.instagramConnection.findUnique.mockResolvedValue(connectedRow());
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));

    const result = await service.getOwnLivePostMedia("profile-1", "https://www.instagram.com/reel/Cxyz123/");

    expect(result).toBeNull();
  });

  it("returns null when there's no connected account at all", async () => {
    prisma.instagramConnection.findUnique.mockResolvedValue(null);

    const result = await service.getOwnLivePostMedia("profile-1", "https://www.instagram.com/reel/Cxyz123/");

    expect(result).toBeNull();
  });
});

function makeCompleteConfig() {
  const values: Record<string, string> = {
    INSTAGRAM_GRAPH_API_VERSION: "v23.0",
    INSTAGRAM_TOKEN_ENCRYPTION_KEY: "test-encryption-key-not-a-real-secret",
    INSTAGRAM_APP_ID: "test-app-id",
    INSTAGRAM_APP_SECRET: "test-app-secret",
    INSTAGRAM_REDIRECT_URI: "https://example.com/callback",
    INSTAGRAM_OAUTH_SCOPES: "instagram_business_basic",
  };
  return { get: vi.fn((key: string) => values[key]) };
}

describe("InstagramOAuthService.complete", () => {
  const USER_ID = "user-1";
  const PROFILE_ID = "profile-1";
  const TRANSACTION_ID = "tx-1";

  let prisma: {
    instagramOAuthTransaction: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    instagramConnection: { findUnique: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn> };
    creatorProfile: { findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    user: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };
  let profiles: { assertOwnership: ReturnType<typeof vi.fn> };
  let service: InstagramOAuthService;

  function oauthTransaction(overrides: Record<string, unknown> = {}) {
    return {
      id: "oauth-tx-row-1",
      transactionId: TRANSACTION_ID,
      userId: USER_ID,
      creatorProfileId: PROFILE_ID,
      status: "ready",
      encryptedAccessToken: "encrypted-token",
      expiresAt: new Date(Date.now() + 60_000),
      tokenExpiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
      dataAccessExpiresAt: null,
      completedAt: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    profiles = { assertOwnership: vi.fn().mockResolvedValue(undefined) };
    prisma = {
      instagramOAuthTransaction: { findUnique: vi.fn(), update: vi.fn() },
      instagramConnection: { findUnique: vi.fn(), findFirst: vi.fn(), upsert: vi.fn() },
      creatorProfile: { findFirst: vi.fn().mockResolvedValue({ socialLinks: {}, socialStats: {} }), update: vi.fn() },
      user: { findUnique: vi.fn().mockResolvedValue({ instagramReviewStatus: "verified" }), update: vi.fn() },
      $transaction: vi.fn((callback: (tx: unknown) => unknown) => callback(prisma)),
    };
    service = new InstagramOAuthService(prisma as never, profiles as never, makeCompleteConfig() as never);
    // decrypt/fetchProfileAndMedia hit real crypto / the live Instagram Graph
    // API respectively — stub both so these tests exercise complete()'s own
    // logic (the new cross-user conflict check, specifically) rather than
    // those.
    vi.spyOn(service as unknown as { decrypt(v: string): string }, "decrypt").mockReturnValue("real-token");
    vi.spyOn(
      service as unknown as { fetchProfileAndMedia(token: string): Promise<Record<string, unknown>> },
      "fetchProfileAndMedia",
    ).mockResolvedValue({
      igUserId: "ig-user-999",
      username: "shared_handle",
      displayName: null,
      followerCount: 100,
      followsCount: 10,
      mediaCount: 5,
      profilePictureUrl: null,
      accountType: null,
      biography: null,
      website: null,
      engagementRate: 0,
      avgLikes: 0,
      avgComments: 0,
      topPosts: [],
      fetchedAt: new Date().toISOString(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("blocks completion when another creator profile already has this Instagram account actively connected", async () => {
    prisma.instagramOAuthTransaction.findUnique.mockResolvedValue(oauthTransaction());
    prisma.instagramConnection.findFirst.mockResolvedValue({ id: "some-other-connection-row" });

    await expect(service.complete(USER_ID, PROFILE_ID, TRANSACTION_ID)).rejects.toMatchObject({
      response: { code: "INSTAGRAM_ACCOUNT_ALREADY_LINKED" },
    });
    expect(prisma.instagramConnection.upsert).not.toHaveBeenCalled();
  });

  it("queries the conflict check by the stable platformUserId, excluding this profile's own row and this same user", async () => {
    prisma.instagramOAuthTransaction.findUnique.mockResolvedValue(oauthTransaction());
    prisma.instagramConnection.findFirst.mockResolvedValue(null);

    await service.complete(USER_ID, PROFILE_ID, TRANSACTION_ID);

    expect(prisma.instagramConnection.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          platformUserId: "ig-user-999",
          isConnected: true,
          NOT: { creatorProfileId: PROFILE_ID },
          userId: { not: USER_ID },
        }),
      }),
    );
  });


  it("completes normally when no other profile has this Instagram account connected", async () => {
    prisma.instagramOAuthTransaction.findUnique.mockResolvedValue(oauthTransaction());
    prisma.instagramConnection.findFirst.mockResolvedValue(null);

    const result = await service.complete(USER_ID, PROFILE_ID, TRANSACTION_ID);

    expect(result).toMatchObject({ connected: true, handle: "shared_handle" });
    expect(prisma.instagramConnection.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { creatorProfileId: PROFILE_ID } }),
    );
  });
});
