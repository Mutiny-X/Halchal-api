import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AutoReviewService } from "./auto-review.service";
import * as videoCompress from "./video-compress";
import { setSafeFetchResolverForTests } from "../common/safe-fetch";

// Hermetic DNS for the SSRF guard inside fetchMedia: test hosts resolve to a
// public address instead of hitting the network.
beforeAll(() => setSafeFetchResolverForTests(async () => ["93.184.216.34"]));
afterAll(() => setSafeFetchResolverForTests(null));

// compressVideoForGemini shells out to a real ffmpeg process — not
// something a unit test should depend on. Tests that care about the
// source-video-match path mock its output explicitly; everything else
// just needs it to not hang, so this passthrough default is enough.
vi.spyOn(videoCompress, "compressVideoForGemini").mockImplementation(async (buffer) => buffer);

function makePrisma() {
  const prisma = {
    formatDeliverable: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    instagramConnection: { findUnique: vi.fn() },
    youtubeConnection: { findUnique: vi.fn() },
    autoReviewResult: { create: vi.fn() },
    deliverableRejectionEvent: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation((cb: (tx: typeof prisma) => unknown) => cb(prisma));
  return prisma;
}

function makeApify() {
  return {
    checkPostResolves: vi.fn().mockResolvedValue({ status: "resolved" }),
    getPostAuthor: vi.fn().mockResolvedValue(null),
    detectPlatform: vi.fn().mockReturnValue("instagram"),
  };
}

function makeGemini() {
  return {
    evaluateCompliance: vi.fn().mockResolvedValue(null),
    compareDraftToLive: vi.fn().mockResolvedValue(null),
  };
}

function makeChecklist() {
  return { getOrCreateChecklist: vi.fn().mockResolvedValue(null) };
}

function makeRealtime() {
  return { emitDeliverableReviewed: vi.fn(), emitDeliverableLiveProof: vi.fn() };
}

function makeNotifications() {
  return { create: vi.fn().mockResolvedValue(undefined) };
}

function makeInstagramOAuth() {
  // Defaults to "nothing found here", so every existing test's Apify-based
  // behavior is unaffected unless a test explicitly overrides this.
  return { getOwnLivePostMedia: vi.fn().mockResolvedValue(null) };
}

function makeConfig(enabled: boolean, enforceEnabled = false) {
  return {
    get: vi.fn((key: string) => (key === "AUTO_REVIEW_ENFORCE_ENABLED" ? enforceEnabled : enabled)),
  };
}

const baseDeliverable = {
  id: "deliverable-1",
  platform: "instagram_reel",
  livePostUrl: "https://www.instagram.com/reel/abc123/",
  draftDriveUrl: null,
  participation: {
    creatorProfileId: "profile-1",
    campaign: { id: "campaign-1", brief: "brief", doRules: null, avoidRules: null },
  },
};

describe("AutoReviewService", () => {
  let prisma: ReturnType<typeof makePrisma>;
  let apify: ReturnType<typeof makeApify>;
  let gemini: ReturnType<typeof makeGemini>;
  let checklist: ReturnType<typeof makeChecklist>;
  let realtime: ReturnType<typeof makeRealtime>;
  let notifications: ReturnType<typeof makeNotifications>;
  let instagramOAuth: ReturnType<typeof makeInstagramOAuth>;
  let service: AutoReviewService;

  function build(enabled = true, enforceEnabled = false) {
    prisma = makePrisma();
    apify = makeApify();
    gemini = makeGemini();
    checklist = makeChecklist();
    realtime = makeRealtime();
    notifications = makeNotifications();
    instagramOAuth = makeInstagramOAuth();
    service = new AutoReviewService(
      prisma as never,
      apify as never,
      gemini as never,
      checklist as never,
      makeConfig(enabled, enforceEnabled) as never,
      realtime as never,
      notifications as never,
      instagramOAuth as never,
    );
  }

  beforeEach(() => build());

  describe("runProofPipeline", () => {
    it("does nothing at all when AUTO_REVIEW_ENABLED is false — no lookups, no calls", async () => {
      build(false);
      prisma.formatDeliverable.findUnique.mockResolvedValue(baseDeliverable);

      await service.runProofPipeline("deliverable-1");

      expect(prisma.formatDeliverable.findUnique).not.toHaveBeenCalled();
      expect(prisma.autoReviewResult.create).not.toHaveBeenCalled();
    });

    it("does nothing when the deliverable has no live URL", async () => {
      prisma.formatDeliverable.findUnique.mockResolvedValue({ ...baseDeliverable, livePostUrl: null });

      await service.runProofPipeline("deliverable-1");

      expect(prisma.autoReviewResult.create).not.toHaveBeenCalled();
    });

    it("auto_rejects when the live link doesn't resolve (non-Instagram, still Apify-backed)", async () => {
      apify.detectPlatform.mockReturnValue("youtube");
      prisma.formatDeliverable.findUnique.mockResolvedValue({ ...baseDeliverable, platform: "youtube_short" });
      apify.checkPostResolves.mockResolvedValue({ status: "not_found" });

      await service.runProofPipeline("deliverable-1");

      expect(prisma.autoReviewResult.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ deliverableId: "deliverable-1", stage: "proof", decision: "auto_rejected" }),
        }),
      );
    });

    it("needs_review when Tier 1 passes but there's no draft to run Tier 2 against", async () => {
      prisma.formatDeliverable.findUnique.mockResolvedValue(baseDeliverable);
      prisma.instagramConnection.findUnique.mockResolvedValue({
        platformHandle: "creator",
        platformUserId: "1",
      });
      apify.getPostAuthor.mockResolvedValue({ handle: "creator", platformUserId: "1" });

      await service.runProofPipeline("deliverable-1");

      const call = prisma.autoReviewResult.create.mock.calls[0][0];
      expect(call.data.decision).toBe("needs_review");
      expect(call.data.tier2Results).toBeUndefined();
    });

    it("prefers the connected account's own Graph API media over Apify's scrape once ownership is verified", async () => {
      prisma.formatDeliverable.findUnique.mockResolvedValue({
        ...baseDeliverable,
        draftDriveUrl: "https://pub-example.r2.dev/creator-drafts/x.mp4",
      });
      prisma.instagramConnection.findUnique.mockResolvedValue({
        platformHandle: "creator",
        platformUserId: "1",
      });
      apify.getPostAuthor.mockResolvedValue({ handle: "creator", platformUserId: "1" });
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(
          async () =>
            new Response(new Blob(["x"]), { status: 200, headers: { "content-type": "video/mp4" } }),
        );
      instagramOAuth.getOwnLivePostMedia.mockResolvedValue({
        kind: "video",
        url: "https://graph.example.com/own-media.mp4",
      });
      gemini.compareDraftToLive.mockResolvedValue({ same: true, confidence: 0.9, reason: "matches" });

      await service.runProofPipeline("deliverable-1");

      expect(instagramOAuth.getOwnLivePostMedia).toHaveBeenCalledWith(
        "profile-1",
        "https://www.instagram.com/reel/abc123/",
      );
      expect(fetchSpy).toHaveBeenCalledWith("https://graph.example.com/own-media.mp4", expect.anything());
      expect(gemini.compareDraftToLive).toHaveBeenCalledWith(
        expect.objectContaining({ liveMediaKind: "video" }),
      );
      fetchSpy.mockRestore();
    });

    it("stays unresolved (no scrape fallback) when the connected account has no matching media for this post", async () => {
      prisma.formatDeliverable.findUnique.mockResolvedValue({
        ...baseDeliverable,
        draftDriveUrl: "https://pub-example.r2.dev/creator-drafts/x.mp4",
      });
      prisma.instagramConnection.findUnique.mockResolvedValue({
        platformHandle: "creator",
        platformUserId: "1",
      });
      apify.getPostAuthor.mockResolvedValue({ handle: "creator", platformUserId: "1" });
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(
          async () =>
            new Response(new Blob(["x"]), { status: 200, headers: { "content-type": "video/mp4" } }),
        );
      instagramOAuth.getOwnLivePostMedia.mockResolvedValue(null);

      await service.runProofPipeline("deliverable-1");
      fetchSpy.mockRestore();

      expect(instagramOAuth.getOwnLivePostMedia).toHaveBeenCalled();
      expect(gemini.compareDraftToLive).not.toHaveBeenCalled();
      const call = prisma.autoReviewResult.create.mock.calls[0][0];
      expect(
        call.data.tier1Results.find((g: { gate: string }) => g.gate === "draft_live_match").status,
      ).toBe("unresolved");
    });

    it("auto_rejects on a confident content mismatch even while ownership is unresolved — rejecting never risks an unconfirmed-ownership payout", async () => {
      prisma.formatDeliverable.findUnique.mockResolvedValue({
        ...baseDeliverable,
        draftDriveUrl: "https://pub-example.r2.dev/creator-drafts/x.mp4",
      });
      prisma.instagramConnection.findUnique.mockResolvedValue({
        platformHandle: "creator",
        platformUserId: "1",
      });
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(
          async () =>
            new Response(new Blob(["x"]), { status: 200, headers: { "content-type": "video/mp4" } }),
        );
      // Ownership can't be verified — the Graph API lookup found nothing,
      // same shape as a live "could not find this post" case.
      instagramOAuth.getOwnLivePostMedia.mockResolvedValue(null);
      checklist.getOrCreateChecklist.mockResolvedValue([{ id: "c1", label: "matches brief", source: "brief" }]);
      gemini.evaluateCompliance.mockResolvedValue([
        { criterionId: "c1", label: "matches brief", pass: false, confidence: 0.95, reason: "off-brief content", required: true },
      ]);

      await service.runProofPipeline("deliverable-1");
      fetchSpy.mockRestore();

      const call = prisma.autoReviewResult.create.mock.calls[0][0];
      expect(call.data.decision).toBe("auto_rejected");
      // Confirms the reject happened despite — not because of — ownership
      // still being unresolved, so this is genuinely testing the new path.
      expect(
        call.data.tier1Results.find((g: { gate: string }) => g.gate === "ownership_verified").status,
      ).toBe("unresolved");
    });

    it("still needs_review (never auto_approved) when the checklist passes but ownership is unresolved", async () => {
      prisma.formatDeliverable.findUnique.mockResolvedValue({
        ...baseDeliverable,
        draftDriveUrl: "https://pub-example.r2.dev/creator-drafts/x.mp4",
      });
      prisma.instagramConnection.findUnique.mockResolvedValue({
        platformHandle: "creator",
        platformUserId: "1",
      });
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(
          async () =>
            new Response(new Blob(["x"]), { status: 200, headers: { "content-type": "video/mp4" } }),
        );
      instagramOAuth.getOwnLivePostMedia.mockResolvedValue(null);
      checklist.getOrCreateChecklist.mockResolvedValue([{ id: "c1", label: "matches brief", source: "brief" }]);
      gemini.evaluateCompliance.mockResolvedValue([
        { criterionId: "c1", label: "matches brief", pass: true, confidence: 0.95, reason: "matches", required: true },
      ]);

      await service.runProofPipeline("deliverable-1");
      fetchSpy.mockRestore();

      const call = prisma.autoReviewResult.create.mock.calls[0][0];
      expect(call.data.decision).toBe("needs_review");
    });

    it("never compares draft-vs-live when there's no connection — resolves_and_public/ownership/draft_live_match all stay unresolved", async () => {
      prisma.formatDeliverable.findUnique.mockResolvedValue({
        ...baseDeliverable,
        draftDriveUrl: "https://pub-example.r2.dev/creator-drafts/x.mp4",
      });
      // No connection at all — resolves_and_public and ownership_verified
      // both now come from this same Instagram lookup, so it's still
      // called (there's no connection check to short-circuit on before
      // calling it), it just can't find anything without a connection.
      prisma.instagramConnection.findUnique.mockResolvedValue(null);
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(
          async () =>
            new Response(new Blob(["x"]), { status: 200, headers: { "content-type": "video/mp4" } }),
        );

      await service.runProofPipeline("deliverable-1");
      fetchSpy.mockRestore();

      expect(instagramOAuth.getOwnLivePostMedia).toHaveBeenCalled();
      expect(gemini.compareDraftToLive).not.toHaveBeenCalled();
      const call = prisma.autoReviewResult.create.mock.calls[0][0];
      expect(
        call.data.tier1Results.find((g: { gate: string }) => g.gate === "resolves_and_public").status,
      ).toBe("unresolved");
      expect(
        call.data.tier1Results.find((g: { gate: string }) => g.gate === "ownership_verified").status,
      ).toBe("unresolved");
    });
  });

  describe("runDraftPipeline", () => {
    it("does nothing at all when AUTO_REVIEW_ENABLED is false", async () => {
      build(false);
      await service.runDraftPipeline("deliverable-1");
      expect(prisma.formatDeliverable.findUnique).not.toHaveBeenCalled();
    });

    it("needs_review (not a failure) when the draft is Drive-linked and unfetchable", async () => {
      prisma.formatDeliverable.findUnique.mockResolvedValue({
        ...baseDeliverable,
        draftDriveUrl: "https://drive.google.com/file/d/abc/view",
      });
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(null, { status: 404 }),
      );

      await service.runDraftPipeline("deliverable-1");
      fetchSpy.mockRestore();

      const call = prisma.autoReviewResult.create.mock.calls[0][0];
      expect(call.data.stage).toBe("draft");
      expect(call.data.decision).toBe("needs_review");
    });

    it("fetches from adminUploadedDraftUrl instead of a Drive-linked draftDriveUrl when both are set", async () => {
      prisma.formatDeliverable.findUnique.mockResolvedValue({
        ...baseDeliverable,
        platform: "instagram_post", // no strict aspect-ratio check — Tier 1 auto-passes
        draftDriveUrl: "https://drive.google.com/file/d/abc/view",
        adminUploadedDraftUrl: "https://pub-example.r2.dev/admin-draft-copies/real.mp4",
      });
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
        async () =>
          new Response(new Blob(["x"]), { status: 200, headers: { "content-type": "video/mp4" } }),
      );
      checklist.getOrCreateChecklist.mockResolvedValue([{ id: "c1", label: "x", source: "brief" }]);
      gemini.evaluateCompliance.mockResolvedValue([
        { criterionId: "c1", label: "x", pass: true, confidence: 0.9, reason: "ok", required: true },
      ]);

      await service.runDraftPipeline("deliverable-1");

      // Assert on the spy's recorded calls before mockRestore() — restoring
      // clears the call history, not just the mocked implementation.
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://pub-example.r2.dev/admin-draft-copies/real.mp4",
        expect.anything(),
      );
      expect(fetchSpy).not.toHaveBeenCalledWith(
        "https://drive.google.com/file/d/abc/view",
        expect.anything(),
      );
      fetchSpy.mockRestore();
      // Proves the fetched bytes actually made it to Tier 2, not just that
      // fetch was called with the right URL — the Drive-unfetchable branch
      // never reaches evaluateCompliance at all.
      expect(gemini.evaluateCompliance).toHaveBeenCalled();
      const call = prisma.autoReviewResult.create.mock.calls[0][0];
      expect(call.data.decision).not.toBe("needs_review");
    });

    it("does nothing when the deliverable has no draft at all", async () => {
      prisma.formatDeliverable.findUnique.mockResolvedValue({ ...baseDeliverable, draftDriveUrl: null });

      await service.runDraftPipeline("deliverable-1");

      expect(prisma.autoReviewResult.create).not.toHaveBeenCalled();
    });

    it("passes an uploaded campaign source asset through to evaluateCompliance as sourceMedia", async () => {
      prisma.formatDeliverable.findUnique.mockResolvedValue({
        ...baseDeliverable,
        platform: "instagram_post",
        draftDriveUrl: "https://pub-example.r2.dev/creator-drafts/draft.mp4",
        participation: {
          campaign: {
            ...baseDeliverable.participation.campaign,
            sourceAssets: [
              { id: "s1", type: "drive", url: "https://drive.google.com/file/d/xyz/view", label: "" },
              { id: "s2", type: "upload", url: "https://pub-example.r2.dev/reference-assets/source.mp4", label: "" },
            ],
          },
        },
      });
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
        async () =>
          new Response(new Blob(["x"]), { status: 200, headers: { "content-type": "video/mp4" } }),
      );
      checklist.getOrCreateChecklist.mockResolvedValue([{ id: "c1", label: "x", source: "brief" }]);
      gemini.evaluateCompliance.mockResolvedValue([
        { criterionId: "c1", label: "x", pass: true, confidence: 0.9, reason: "ok", required: true },
      ]);

      await service.runDraftPipeline("deliverable-1");

      // Fetched the "upload" source asset, not the unfetchable Drive one.
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://pub-example.r2.dev/reference-assets/source.mp4",
        expect.anything(),
      );
      expect(fetchSpy).not.toHaveBeenCalledWith(
        "https://drive.google.com/file/d/xyz/view",
        expect.anything(),
      );
      fetchSpy.mockRestore();

      expect(gemini.evaluateCompliance).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceMedia: { buffer: expect.any(Buffer), mimeType: "video/mp4" },
        }),
      );
    });

    it("fetches a Drive source asset via its direct-download URL when there's no uploaded one", async () => {
      prisma.formatDeliverable.findUnique.mockResolvedValue({
        ...baseDeliverable,
        platform: "instagram_post",
        draftDriveUrl: "https://pub-example.r2.dev/creator-drafts/draft.mp4",
        participation: {
          campaign: {
            ...baseDeliverable.participation.campaign,
            sourceAssets: [{ id: "s1", type: "drive", url: "https://drive.google.com/file/d/xyz/view", label: "" }],
          },
        },
      });
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
        async () =>
          new Response(new Blob(["x"]), { status: 200, headers: { "content-type": "video/mp4" } }),
      );
      checklist.getOrCreateChecklist.mockResolvedValue([{ id: "c1", label: "x", source: "brief" }]);
      gemini.evaluateCompliance.mockResolvedValue([
        { criterionId: "c1", label: "x", pass: true, confidence: 0.9, reason: "ok", required: true },
      ]);

      await service.runDraftPipeline("deliverable-1");

      // The share-link URL itself is never fetched — it's resolved to
      // Drive's direct-download endpoint first.
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://drive.google.com/uc?export=download&id=xyz",
        expect.anything(),
      );
      fetchSpy.mockRestore();

      expect(gemini.evaluateCompliance).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceMedia: { buffer: expect.any(Buffer), mimeType: "video/mp4" },
        }),
      );
    });

    it("passes sourceMedia: null when the Drive source asset fails to fetch, without falling back to YouTube", async () => {
      prisma.formatDeliverable.findUnique.mockResolvedValue({
        ...baseDeliverable,
        platform: "instagram_post",
        draftDriveUrl: "https://pub-example.r2.dev/creator-drafts/draft.mp4",
        participation: {
          campaign: {
            ...baseDeliverable.participation.campaign,
            sourceAssets: [
              { id: "s1", type: "drive", url: "https://drive.google.com/file/d/xyz/view", label: "" },
              { id: "s2", type: "youtube", url: "https://www.youtube.com/watch?v=jNQXAC9IVRw", label: "" },
            ],
          },
        },
      });
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
        if (typeof url === "string" && url.includes("uc?export=download")) {
          // Drive's virus-scan interstitial: an HTML page instead of the file.
          return new Response("<html>can't scan for viruses</html>", {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        return new Response(new Blob(["x"]), { status: 200, headers: { "content-type": "video/mp4" } });
      });
      checklist.getOrCreateChecklist.mockResolvedValue([{ id: "c1", label: "x", source: "brief" }]);
      gemini.evaluateCompliance.mockResolvedValue([
        { criterionId: "c1", label: "x", pass: true, confidence: 0.9, reason: "ok", required: true },
      ]);

      await service.runDraftPipeline("deliverable-1");
      fetchSpy.mockRestore();

      expect(gemini.evaluateCompliance).toHaveBeenCalledWith(
        expect.objectContaining({ sourceMedia: null }),
      );
    });

    it("passes sourceMedia: null when the campaign has no source assets at all", async () => {
      prisma.formatDeliverable.findUnique.mockResolvedValue({
        ...baseDeliverable,
        platform: "instagram_post",
        draftDriveUrl: "https://pub-example.r2.dev/creator-drafts/draft.mp4",
        participation: {
          campaign: { ...baseDeliverable.participation.campaign, sourceAssets: [] },
        },
      });
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
        async () =>
          new Response(new Blob(["x"]), { status: 200, headers: { "content-type": "video/mp4" } }),
      );
      checklist.getOrCreateChecklist.mockResolvedValue([{ id: "c1", label: "x", source: "brief" }]);
      gemini.evaluateCompliance.mockResolvedValue([
        { criterionId: "c1", label: "x", pass: true, confidence: 0.9, reason: "ok", required: true },
      ]);

      await service.runDraftPipeline("deliverable-1");
      fetchSpy.mockRestore();

      expect(gemini.evaluateCompliance).toHaveBeenCalledWith(
        expect.objectContaining({ sourceMedia: null }),
      );
    });

    it("falls back to a YouTube source asset (sent as a direct reference, not fetched) when there's no uploaded or Drive one", async () => {
      prisma.formatDeliverable.findUnique.mockResolvedValue({
        ...baseDeliverable,
        platform: "instagram_post",
        draftDriveUrl: "https://pub-example.r2.dev/creator-drafts/draft.mp4",
        participation: {
          campaign: {
            ...baseDeliverable.participation.campaign,
            sourceAssets: [
              { id: "s2", type: "youtube", url: "https://www.youtube.com/watch?v=jNQXAC9IVRw", label: "" },
            ],
          },
        },
      });
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
        async () =>
          new Response(new Blob(["x"]), { status: 200, headers: { "content-type": "video/mp4" } }),
      );
      checklist.getOrCreateChecklist.mockResolvedValue([{ id: "c1", label: "x", source: "brief" }]);
      gemini.evaluateCompliance.mockResolvedValue([
        { criterionId: "c1", label: "x", pass: true, confidence: 0.9, reason: "ok", required: true },
      ]);

      await service.runDraftPipeline("deliverable-1");

      // Only the draft gets fetched — the YouTube source is never
      // downloaded, just referenced by URL.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://pub-example.r2.dev/creator-drafts/draft.mp4",
        expect.anything(),
      );
      fetchSpy.mockRestore();

      expect(gemini.evaluateCompliance).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceMedia: { youtubeUrl: "https://www.youtube.com/watch?v=jNQXAC9IVRw" },
        }),
      );
    });

    it("passes sourceMedia: null — never calls Gemini with it — when a 'youtube' source asset's url isn't actually a URL", async () => {
      // Confirmed live: a campaign whose brief text got pasted into the
      // YouTube URL field by mistake sent that raw text to Gemini as
      // fileData.fileUri, which rejected the whole evaluateCompliance call
      // with a 400 — silently forcing needs_review on every submission to
      // that campaign, not just skipping the one source-video-match check.
      prisma.formatDeliverable.findUnique.mockResolvedValue({
        ...baseDeliverable,
        platform: "instagram_post",
        draftDriveUrl: "https://pub-example.r2.dev/creator-drafts/draft.mp4",
        participation: {
          campaign: {
            ...baseDeliverable.participation.campaign,
            sourceAssets: [
              { id: "s2", type: "youtube", url: "we want to make this song halchal in the instagram", label: "" },
            ],
          },
        },
      });
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
        async () =>
          new Response(new Blob(["x"]), { status: 200, headers: { "content-type": "video/mp4" } }),
      );
      checklist.getOrCreateChecklist.mockResolvedValue([{ id: "c1", label: "x", source: "brief" }]);
      gemini.evaluateCompliance.mockResolvedValue([
        { criterionId: "c1", label: "x", pass: true, confidence: 0.9, reason: "ok", required: true },
      ]);

      await service.runDraftPipeline("deliverable-1");
      fetchSpy.mockRestore();

      expect(gemini.evaluateCompliance).toHaveBeenCalledWith(
        expect.objectContaining({ sourceMedia: null }),
      );
    });

    it("passes sourceMedia: null when a 'youtube' source asset's url is a real URL but not actually YouTube", async () => {
      prisma.formatDeliverable.findUnique.mockResolvedValue({
        ...baseDeliverable,
        platform: "instagram_post",
        draftDriveUrl: "https://pub-example.r2.dev/creator-drafts/draft.mp4",
        participation: {
          campaign: {
            ...baseDeliverable.participation.campaign,
            sourceAssets: [
              { id: "s2", type: "youtube", url: "https://example.com/not-youtube", label: "" },
            ],
          },
        },
      });
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
        async () =>
          new Response(new Blob(["x"]), { status: 200, headers: { "content-type": "video/mp4" } }),
      );
      checklist.getOrCreateChecklist.mockResolvedValue([{ id: "c1", label: "x", source: "brief" }]);
      gemini.evaluateCompliance.mockResolvedValue([
        { criterionId: "c1", label: "x", pass: true, confidence: 0.9, reason: "ok", required: true },
      ]);

      await service.runDraftPipeline("deliverable-1");
      fetchSpy.mockRestore();

      expect(gemini.evaluateCompliance).toHaveBeenCalledWith(
        expect.objectContaining({ sourceMedia: null }),
      );
    });

    it("prefers an uploaded source asset over a YouTube one when both exist", async () => {
      prisma.formatDeliverable.findUnique.mockResolvedValue({
        ...baseDeliverable,
        platform: "instagram_post",
        draftDriveUrl: "https://pub-example.r2.dev/creator-drafts/draft.mp4",
        participation: {
          campaign: {
            ...baseDeliverable.participation.campaign,
            sourceAssets: [
              { id: "s1", type: "youtube", url: "https://www.youtube.com/watch?v=jNQXAC9IVRw", label: "" },
              { id: "s2", type: "upload", url: "https://pub-example.r2.dev/reference-assets/source.mp4", label: "" },
            ],
          },
        },
      });
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
        async () =>
          new Response(new Blob(["x"]), { status: 200, headers: { "content-type": "video/mp4" } }),
      );
      checklist.getOrCreateChecklist.mockResolvedValue([{ id: "c1", label: "x", source: "brief" }]);
      gemini.evaluateCompliance.mockResolvedValue([
        { criterionId: "c1", label: "x", pass: true, confidence: 0.9, reason: "ok", required: true },
      ]);

      await service.runDraftPipeline("deliverable-1");
      fetchSpy.mockRestore();

      expect(gemini.evaluateCompliance).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceMedia: { buffer: expect.any(Buffer), mimeType: "video/mp4" },
        }),
      );
    });
  });

  describe("sourceVideoRequirement / sourceAudioRequirement toggles", () => {
    const sourceAssetFixture = (overrides: Record<string, unknown>) => ({
      ...baseDeliverable,
      platform: "instagram_post",
      draftDriveUrl: "https://pub-example.r2.dev/creator-drafts/draft.mp4",
      participation: {
        ...baseDeliverable.participation,
        campaign: {
          ...baseDeliverable.participation.campaign,
          sourceAssets: [
            { id: "s1", type: "upload", url: "https://pub-example.r2.dev/reference-assets/source.mp4", label: "" },
          ],
          ...overrides,
        },
      },
    });

    it("a failing 'optional' video-match check never gates the decision", async () => {
      prisma.formatDeliverable.findUnique.mockResolvedValue(
        sourceAssetFixture({ sourceVideoRequirement: "optional" }),
      );
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
        async () =>
          new Response(new Blob(["x"]), { status: 200, headers: { "content-type": "video/mp4" } }),
      );
      checklist.getOrCreateChecklist.mockResolvedValue([{ id: "c1", label: "x", source: "brief" }]);
      gemini.evaluateCompliance.mockResolvedValue([
        { criterionId: "c1", label: "x", pass: true, confidence: 0.9, reason: "ok", required: true },
        {
          criterionId: "source_video_match",
          label: "visual match",
          pass: false,
          confidence: 0.95,
          reason: "different footage",
          required: false,
        },
      ]);

      await service.runDraftPipeline("deliverable-1");
      fetchSpy.mockRestore();

      const call = prisma.autoReviewResult.create.mock.calls[0][0];
      expect(call.data.decision).toBe("auto_approved");
    });

    it("a failing 'mandatory' audio-match check does gate the decision, for a song campaign with no video requirement", async () => {
      prisma.formatDeliverable.findUnique.mockResolvedValue(
        sourceAssetFixture({ sourceVideoRequirement: "not_required", sourceAudioRequirement: "mandatory" }),
      );
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
        async () =>
          new Response(new Blob(["x"]), { status: 200, headers: { "content-type": "video/mp4" } }),
      );
      checklist.getOrCreateChecklist.mockResolvedValue([{ id: "c1", label: "x", source: "brief" }]);
      gemini.evaluateCompliance.mockResolvedValue([
        { criterionId: "c1", label: "x", pass: true, confidence: 0.9, reason: "ok", required: true },
        {
          criterionId: "source_audio_match",
          label: "audio match",
          pass: false,
          confidence: 0.95,
          reason: "different song",
          required: true,
        },
      ]);

      await service.runDraftPipeline("deliverable-1");
      fetchSpy.mockRestore();

      // The checklist sent to Gemini should ask about audio, not video —
      // any footage is fine for a song-push campaign.
      const checklistSent = gemini.evaluateCompliance.mock.calls[0][0].checklist as Array<{ id: string }>;
      expect(checklistSent.some((c) => c.id === "source_audio_match")).toBe(true);
      expect(checklistSent.some((c) => c.id === "source_video_match")).toBe(false);

      const call = prisma.autoReviewResult.create.mock.calls[0][0];
      expect(call.data.decision).toBe("auto_rejected");
    });

    it("never fetches the source asset at all when both requirements are not_required", async () => {
      prisma.formatDeliverable.findUnique.mockResolvedValue(
        sourceAssetFixture({ sourceVideoRequirement: "not_required", sourceAudioRequirement: "not_required" }),
      );
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
        async () =>
          new Response(new Blob(["x"]), { status: 200, headers: { "content-type": "video/mp4" } }),
      );
      checklist.getOrCreateChecklist.mockResolvedValue([{ id: "c1", label: "x", source: "brief" }]);
      gemini.evaluateCompliance.mockResolvedValue([
        { criterionId: "c1", label: "x", pass: true, confidence: 0.9, reason: "ok", required: true },
      ]);

      await service.runDraftPipeline("deliverable-1");
      fetchSpy.mockRestore();

      // Only the draft itself gets fetched — the source asset URL never does.
      expect(fetchSpy).not.toHaveBeenCalledWith(
        "https://pub-example.r2.dev/reference-assets/source.mp4",
        expect.anything(),
      );
      expect(gemini.evaluateCompliance).toHaveBeenCalledWith(
        expect.objectContaining({ sourceMedia: null }),
      );
    });
  });

  describe("Campaign.autoReviewEnabled", () => {
    it("skips the draft pipeline entirely — never touches checklist/Gemini — when the campaign has it disabled", async () => {
      prisma.formatDeliverable.findUnique.mockResolvedValue({
        ...baseDeliverable,
        draftDriveUrl: "https://pub-example.r2.dev/creator-drafts/draft.mp4",
        participation: {
          ...baseDeliverable.participation,
          campaign: { ...baseDeliverable.participation.campaign, autoReviewEnabled: false },
        },
      });
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      await service.runDraftPipeline("deliverable-1");

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(checklist.getOrCreateChecklist).not.toHaveBeenCalled();
      expect(gemini.evaluateCompliance).not.toHaveBeenCalled();
      expect(prisma.autoReviewResult.create).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it("skips the proof pipeline entirely when the campaign has it disabled", async () => {
      prisma.formatDeliverable.findUnique.mockResolvedValue({
        ...baseDeliverable,
        participation: {
          ...baseDeliverable.participation,
          campaign: { ...baseDeliverable.participation.campaign, autoReviewEnabled: false },
        },
      });

      await service.runProofPipeline("deliverable-1");

      expect(apify.checkPostResolves).not.toHaveBeenCalled();
      expect(prisma.autoReviewResult.create).not.toHaveBeenCalled();
    });

    it("still runs normally when autoReviewEnabled is true", async () => {
      prisma.formatDeliverable.findUnique.mockResolvedValue({
        ...baseDeliverable,
        participation: {
          ...baseDeliverable.participation,
          campaign: { ...baseDeliverable.participation.campaign, autoReviewEnabled: true },
        },
      });

      await service.runProofPipeline("deliverable-1");

      expect(prisma.autoReviewResult.create).toHaveBeenCalled();
    });
  });

  it("never throws out of either pipeline, even if the deliverable lookup fails", async () => {
    prisma.formatDeliverable.findUnique.mockRejectedValue(new Error("db down"));

    await expect(service.runProofPipeline("deliverable-1")).resolves.toBeUndefined();
    await expect(service.runDraftPipeline("deliverable-1")).resolves.toBeUndefined();
  });

  describe("enforcement (AUTO_REVIEW_ENFORCE_ENABLED)", () => {
    const enforceFixture = {
      id: "deliverable-1",
      platform: "instagram_reel",
      livePostUrl: "https://www.instagram.com/reel/abc123/",
      draftDriveUrl: null as string | null,
      status: "under_review",
      participation: {
        id: "participation-1",
        creatorId: "creator-1",
        creatorProfileId: "profile-1",
        campaignId: "campaign-1",
        campaign: {
          id: "campaign-1",
          title: "Test Campaign",
          brief: "brief",
          doRules: null,
          avoidRules: null,
          brandProfileId: "brand-1",
        },
      },
    };

    it("stays shadow-mode by default — an auto_rejected decision never touches real status", async () => {
      build(true, false);
      prisma.formatDeliverable.findUnique.mockResolvedValue(enforceFixture);
      apify.checkPostResolves.mockResolvedValue({ status: "not_found" });

      await service.runProofPipeline("deliverable-1");

      expect(prisma.formatDeliverable.update).not.toHaveBeenCalled();
      expect(realtime.emitDeliverableLiveProof).not.toHaveBeenCalled();
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it("applies a real auto_rejected proof decision when enforcement is on (non-Instagram, still Apify-backed)", async () => {
      build(true, true);
      apify.detectPlatform.mockReturnValue("youtube");
      prisma.formatDeliverable.findUnique.mockResolvedValue({
        ...enforceFixture,
        platform: "youtube_short",
        status: "proof_under_review",
      });
      prisma.formatDeliverable.update.mockResolvedValue({
        ...enforceFixture,
        status: "proof_rejected",
      });
      apify.checkPostResolves.mockResolvedValue({ status: "not_found" });

      await service.runProofPipeline("deliverable-1");

      expect(prisma.formatDeliverable.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "deliverable-1" },
          data: expect.objectContaining({ status: "proof_rejected" }),
        }),
      );
      expect(realtime.emitDeliverableLiveProof).toHaveBeenCalledWith(
        expect.objectContaining({ deliverableId: "deliverable-1", status: "proof_rejected" }),
      );
      expect(notifications.create).toHaveBeenCalledWith(
        "creator-1",
        "creator",
        expect.objectContaining({ type: "proof_rejected" }),
      );
    });

    it("applies a real auto_approved proof decision when enforcement is on, without touching payout fields", async () => {
      build(true, true);
      prisma.formatDeliverable.findUnique.mockResolvedValue({
        ...enforceFixture,
        status: "proof_under_review",
        draftDriveUrl: "https://pub-example.r2.dev/creator-drafts/x.mp4",
      });
      prisma.instagramConnection.findUnique.mockResolvedValue({
        platformHandle: "creator",
        platformUserId: "1",
      });
      apify.getPostAuthor.mockResolvedValue({ handle: "creator", platformUserId: "1" });
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(
          async () =>
            new Response(new Blob(["x"]), { status: 200, headers: { "content-type": "video/mp4" } }),
        );
      instagramOAuth.getOwnLivePostMedia.mockResolvedValue({ kind: "video", url: "https://example.com/live.mp4" });
      gemini.compareDraftToLive.mockResolvedValue({ same: true, confidence: 0.95, reason: "matches" });
      gemini.evaluateCompliance.mockResolvedValue([
        { criterionId: "c1", label: "x", pass: true, confidence: 0.95, reason: "ok", required: true },
      ]);
      checklist.getOrCreateChecklist.mockResolvedValue([{ id: "c1", label: "x", source: "brief" }]);
      prisma.formatDeliverable.update.mockResolvedValue({
        ...enforceFixture,
        status: "proof_approved",
      });

      await service.runProofPipeline("deliverable-1");
      fetchSpy.mockRestore();

      const updateCall = prisma.formatDeliverable.update.mock.calls[0][0];
      expect(updateCall.data.status).toBe("proof_approved");
      expect(updateCall.data).not.toHaveProperty("paidAmountPaise");
      expect(notifications.create).toHaveBeenCalledWith(
        "creator-1",
        "creator",
        expect.objectContaining({ type: "proof_approved" }),
      );
    });

    it("applies a real auto_rejected proof decision when the live content confidently doesn't match the approved draft", async () => {
      build(true, true);
      prisma.formatDeliverable.findUnique.mockResolvedValue({
        ...enforceFixture,
        status: "proof_under_review",
        draftDriveUrl: "https://pub-example.r2.dev/creator-drafts/x.mp4",
      });
      prisma.instagramConnection.findUnique.mockResolvedValue({
        platformHandle: "creator",
        platformUserId: "1",
      });
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(
          async () =>
            new Response(new Blob(["x"]), { status: 200, headers: { "content-type": "video/mp4" } }),
        );
      instagramOAuth.getOwnLivePostMedia.mockResolvedValue({ kind: "video", url: "https://example.com/live.mp4" });
      // A confident mismatch — the creator's actual live post doesn't
      // resemble their approved draft at all (e.g. the wrong URL).
      gemini.compareDraftToLive.mockResolvedValue({
        same: false,
        confidence: 0.95,
        reason: "completely different subject and setting",
      });
      prisma.formatDeliverable.update.mockResolvedValue({
        ...enforceFixture,
        status: "proof_rejected",
      });

      await service.runProofPipeline("deliverable-1");
      fetchSpy.mockRestore();

      const updateCall = prisma.formatDeliverable.update.mock.calls[0][0];
      expect(updateCall.data.status).toBe("proof_rejected");
      expect(updateCall.data.rejectionReason).toContain("resubmit");
      expect(updateCall.data.rejectionReason).toContain("completely different subject and setting");
      expect(notifications.create).toHaveBeenCalledWith(
        "creator-1",
        "creator",
        expect.objectContaining({ type: "proof_rejected" }),
      );
    });

    it("applies a real auto_rejected draft decision when enforcement is on, recording a rejection event", async () => {
      build(true, true);
      prisma.formatDeliverable.findUnique.mockResolvedValue({
        ...enforceFixture,
        // instagram_post has no strict aspect-ratio requirement, so Tier 1's
        // format gate always passes without ever shelling out to ffprobe —
        // keeps this test deterministic and lets Tier 2 alone drive the
        // auto_rejected decision.
        platform: "instagram_post",
        draftDriveUrl: "https://pub-example.r2.dev/creator-drafts/x.mp4",
      });
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(
          async () =>
            new Response(new Blob(["x"]), { status: 200, headers: { "content-type": "video/mp4" } }),
        );
      checklist.getOrCreateChecklist.mockResolvedValue([{ id: "c1", label: "x", source: "brief" }]);
      gemini.evaluateCompliance.mockResolvedValue([
        { criterionId: "c1", label: "x", pass: false, confidence: 0.95, reason: "off-brief content", required: true },
      ]);
      prisma.formatDeliverable.update.mockResolvedValue({
        ...enforceFixture,
        status: "draft_rejected",
      });

      await service.runDraftPipeline("deliverable-1");
      fetchSpy.mockRestore();

      expect(prisma.deliverableRejectionEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ deliverableId: "deliverable-1" }),
        }),
      );
      expect(prisma.formatDeliverable.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "draft_rejected" }) }),
      );
    });

    it("never enforces a needs_review decision, regardless of the flag", async () => {
      build(true, true);
      prisma.formatDeliverable.findUnique.mockResolvedValue({
        ...enforceFixture,
        draftDriveUrl: null,
      });

      await service.runDraftPipeline("deliverable-1");

      expect(prisma.formatDeliverable.update).not.toHaveBeenCalled();
    });

    it("skips applying the decision if a human already reviewed it while the pipeline was running", async () => {
      build(true, true);
      prisma.formatDeliverable.findUnique
        .mockResolvedValueOnce(enforceFixture) // evaluate() fetch
        .mockResolvedValueOnce({ ...enforceFixture, status: "draft_approved" }); // apply() re-fetch
      apify.checkPostResolves.mockResolvedValue({ status: "not_found" });

      await service.runProofPipeline("deliverable-1");

      expect(prisma.formatDeliverable.update).not.toHaveBeenCalled();
    });
  });

  describe("catchUpMissedAutoReviews", () => {
    it("does nothing at all when AUTO_REVIEW_ENABLED is false — not even the backlog lookup", async () => {
      build(false);

      await service.catchUpMissedAutoReviews();

      expect(prisma.formatDeliverable.findMany).not.toHaveBeenCalled();
    });

    it("does nothing when there's no backlog", async () => {
      prisma.formatDeliverable.findMany.mockResolvedValue([]);

      await service.catchUpMissedAutoReviews();

      expect(prisma.formatDeliverable.findUnique).not.toHaveBeenCalled();
    });

    it("processes never-evaluated drafts and proofs together in first-submitted-first-served order", async () => {
      // Two draft-stage and one proof-stage deliverable, deliberately
      // returned out of chronological order by each individual query (as
      // real Prisma results could be) — the merge step must still process
      // them oldest-submitted-first across both stages combined.
      prisma.formatDeliverable.findMany.mockImplementation(({ where }: any) => {
        if (where.autoReviewResults?.some) return Promise.resolve([]); // no stuck candidates in this test
        if (where.status === "under_review") {
          return Promise.resolve([
            { id: "draft-newer", draftSubmittedAt: new Date("2026-01-01T12:00:00Z") },
            { id: "draft-oldest", draftSubmittedAt: new Date("2026-01-01T08:00:00Z") },
          ]);
        }
        return Promise.resolve([
          { id: "proof-middle", liveSubmittedAt: new Date("2026-01-01T10:00:00Z") },
        ]);
      });
      // Each pipeline call re-fetches the deliverable itself — short-circuit
      // via "no live URL"/"no draft" so this test only has to verify which
      // deliverables get looked up, and in what order, not the full
      // evaluation path (already covered by the other describe blocks).
      prisma.formatDeliverable.findUnique.mockResolvedValue({ ...baseDeliverable, livePostUrl: null, draftDriveUrl: null });

      await service.catchUpMissedAutoReviews();

      const lookedUpIds = prisma.formatDeliverable.findUnique.mock.calls.map(
        (call: any) => call[0].where.id,
      );
      expect(lookedUpIds).toEqual(["draft-oldest", "proof-middle", "draft-newer"]);
    });

    it(
      "caps how many it processes in one run instead of unloading the whole backlog at once",
      async () => {
        const manyDrafts = Array.from({ length: 15 }, (_, i) => ({
          id: `draft-${i}`,
          draftSubmittedAt: new Date(2026, 0, 1, 0, i),
        }));
        prisma.formatDeliverable.findMany.mockImplementation(({ where }: any) =>
          Promise.resolve(where.status === "under_review" ? manyDrafts : []),
        );
        prisma.formatDeliverable.findUnique.mockResolvedValue({ ...baseDeliverable, draftDriveUrl: null });

        await service.catchUpMissedAutoReviews();

        expect(prisma.formatDeliverable.findUnique.mock.calls.length).toBeLessThanOrEqual(10);
      },
      10_000, // 10 items × the sweep's own 500ms courtesy pause between each
    );

    it("retries a deliverable stuck on needs_review with no Tier 2 check — a transient checklist failure", async () => {
      prisma.formatDeliverable.findMany.mockImplementation(({ where }: any) => {
        if (!where.autoReviewResults?.some) return Promise.resolve([]); // no backlog in this test
        return Promise.resolve([
          {
            id: "stuck-checklist-failure",
            status: "under_review",
            draftSubmittedAt: new Date("2026-01-01T08:00:00Z"),
            liveSubmittedAt: null,
            _count: { autoReviewResults: 1 },
            autoReviewResults: [
              {
                decision: "needs_review",
                tier2Results: null,
                // format_match resolved fine (the draft WAS fetchable) — the
                // only reason tier2Results is null is the checklist call
                // itself failing, which is exactly the transient case worth
                // retrying.
                tier1Results: [{ gate: "format_match", status: "pass", reason: "Vertical video" }],
              },
            ],
          },
        ]);
      });
      prisma.formatDeliverable.findUnique.mockResolvedValue({ ...baseDeliverable, draftDriveUrl: null });

      await service.catchUpMissedAutoReviews();

      expect(prisma.formatDeliverable.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "stuck-checklist-failure" } }),
      );
    });

    it("retries a draft stuck on a lone unresolved format_match — confirmed live: real, fetchable drafts fail this the same transient way draft_live_match does", async () => {
      prisma.formatDeliverable.findMany.mockImplementation(({ where }: any) => {
        if (!where.autoReviewResults?.some) return Promise.resolve([]);
        return Promise.resolve([
          {
            id: "stuck-format-match",
            status: "under_review",
            draftSubmittedAt: new Date("2026-01-01T08:00:00Z"),
            liveSubmittedAt: null,
            _count: { autoReviewResults: 1 },
            autoReviewResults: [
              {
                decision: "needs_review",
                tier2Results: null,
                tier1Results: [
                  { gate: "format_match", status: "unresolved", reason: "Draft is not an app-uploaded file" },
                ],
              },
            ],
          },
        ]);
      });
      prisma.formatDeliverable.findUnique.mockResolvedValue({ ...baseDeliverable, draftDriveUrl: null });

      await service.catchUpMissedAutoReviews();

      expect(prisma.formatDeliverable.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "stuck-format-match" } }),
      );
    });

    it("stops retrying once a deliverable hits MAX_STUCK_RETRIES — confirmed live: two deliverables were retried 900+ times each over 17 days with no cap", async () => {
      prisma.formatDeliverable.findMany.mockImplementation(({ where }: any) => {
        if (!where.autoReviewResults?.some) return Promise.resolve([]);
        return Promise.resolve([
          {
            id: "retried-too-many-times",
            status: "under_review",
            draftSubmittedAt: new Date("2026-01-01T08:00:00Z"),
            liveSubmittedAt: null,
            _count: { autoReviewResults: 12 },
            autoReviewResults: [
              {
                decision: "needs_review",
                tier2Results: null,
                tier1Results: [
                  { gate: "format_match", status: "unresolved", reason: "Draft is not an app-uploaded file" },
                ],
              },
            ],
          },
        ]);
      });

      await service.catchUpMissedAutoReviews();

      expect(prisma.formatDeliverable.findUnique).not.toHaveBeenCalled();
    });

    it("auto_rejects a proof once retries are exhausted with ownership still unconfirmed, when enforcement is on", async () => {
      build(true, true);
      prisma.formatDeliverable.findMany.mockImplementation(({ where }: any) => {
        if (!where.autoReviewResults?.some) return Promise.resolve([]);
        return Promise.resolve([
          {
            id: "ownership-never-confirmed",
            status: "proof_under_review",
            livePostUrl: "https://www.instagram.com/reel/abc123/",
            draftSubmittedAt: null,
            liveSubmittedAt: new Date("2026-01-01T08:00:00Z"),
            _count: { autoReviewResults: 12 },
            autoReviewResults: [
              {
                decision: "needs_review",
                modelVersion: "gemini-2.5-flash",
                tier2Results: [
                  { criterionId: "c1", label: "logo shown", pass: true, confidence: 1, reason: "ok", required: true },
                ],
                tier1Results: [
                  {
                    gate: "resolves_and_public",
                    status: "unresolved",
                    reason: "Could not find this post on the connected account's own Instagram media",
                  },
                  { gate: "platform_match", status: "pass", reason: "matches" },
                  {
                    gate: "ownership_verified",
                    status: "unresolved",
                    reason: "Could not find this post on the connected account's own Instagram media — needs a human to check",
                  },
                  {
                    gate: "draft_live_match",
                    status: "unresolved",
                    reason: "Could not compare draft and live content (unfetchable media, unsupported platform, or Tier 2 not configured)",
                  },
                ],
              },
            ],
          },
        ]);
      });
      prisma.formatDeliverable.findUnique.mockResolvedValue({
        id: "ownership-never-confirmed",
        status: "proof_under_review",
        platform: "instagram_reel",
        participation: {
          id: "participation-1",
          creatorId: "creator-1",
          campaignId: "campaign-1",
          campaign: { title: "Test Campaign", brandProfileId: "brand-1" },
        },
      });
      prisma.formatDeliverable.update.mockResolvedValue({ status: "proof_rejected", platform: "instagram_reel" });

      await service.catchUpMissedAutoReviews();

      expect(prisma.formatDeliverable.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "ownership-never-confirmed" },
          data: expect.objectContaining({
            status: "proof_rejected",
            rejectionReason: expect.stringContaining("Could not verify this post belongs to your connected account"),
          }),
        }),
      );
      expect(notifications.create).toHaveBeenCalledWith(
        "creator-1",
        "creator",
        expect.objectContaining({ type: "proof_rejected" }),
      );
      // Never re-runs the check — this applies a final decision from the
      // already-exhausted retry history, it doesn't attempt attempt #13.
      expect(instagramOAuth.getOwnLivePostMedia).not.toHaveBeenCalled();
    });

    it("does NOT auto_reject an exhausted ownership-unconfirmed proof when enforcement is off — shadow mode never changes status", async () => {
      // build()'s default from beforeEach already has enforceEnabled: false.
      prisma.formatDeliverable.findMany.mockImplementation(({ where }: any) => {
        if (!where.autoReviewResults?.some) return Promise.resolve([]);
        return Promise.resolve([
          {
            id: "ownership-never-confirmed-shadow",
            status: "proof_under_review",
            livePostUrl: "https://www.instagram.com/reel/abc123/",
            draftSubmittedAt: null,
            liveSubmittedAt: new Date("2026-01-01T08:00:00Z"),
            _count: { autoReviewResults: 12 },
            autoReviewResults: [
              {
                decision: "needs_review",
                tier2Results: null,
                tier1Results: [
                  {
                    gate: "ownership_verified",
                    status: "unresolved",
                    reason: "Could not find this post on the connected account's own Instagram media",
                  },
                ],
              },
            ],
          },
        ]);
      });

      await service.catchUpMissedAutoReviews();

      expect(prisma.formatDeliverable.update).not.toHaveBeenCalled();
      expect(prisma.formatDeliverable.findUnique).not.toHaveBeenCalled();
    });

    it("retries a proof stuck on needs_review when draft_live_match is the only unresolved gate and ownership is verified", async () => {
      prisma.formatDeliverable.findMany.mockImplementation(({ where }: any) => {
        if (!where.autoReviewResults?.some) return Promise.resolve([]);
        return Promise.resolve([
          {
            id: "stuck-live-match",
            status: "proof_under_review",
            draftSubmittedAt: null,
            liveSubmittedAt: new Date("2026-01-01T08:00:00Z"),
            _count: { autoReviewResults: 1 },
            autoReviewResults: [
              {
                decision: "needs_review",
                tier2Results: null,
                tier1Results: [
                  { gate: "resolves_and_public", status: "pass", reason: "resolved" },
                  { gate: "platform_match", status: "pass", reason: "matches" },
                  { gate: "ownership_verified", status: "pass", reason: "matches connected account" },
                  { gate: "draft_live_match", status: "unresolved", reason: "Could not compare draft and live content" },
                ],
              },
            ],
          },
        ]);
      });
      prisma.formatDeliverable.findUnique.mockResolvedValue({ ...baseDeliverable, livePostUrl: null });

      await service.catchUpMissedAutoReviews();

      expect(prisma.formatDeliverable.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "stuck-live-match" } }),
      );
    });

    it("retries an Instagram proof when both ownership_verified and draft_live_match are unresolved together", async () => {
      // Neither gate touches HikerAPI for Instagram anymore — a shared
      // failure across just these two (and/or resolves_and_public) is the
      // exact shape a HikerAPI outage produced live, and none of them are
      // structural once the whole check is first-party.
      prisma.formatDeliverable.findMany.mockImplementation(({ where }: any) => {
        if (!where.autoReviewResults?.some) return Promise.resolve([]);
        return Promise.resolve([
          {
            id: "instagram-double-unresolved",
            status: "proof_under_review",
            livePostUrl: "https://www.instagram.com/reel/abc123/",
            draftSubmittedAt: null,
            liveSubmittedAt: new Date("2026-01-01T08:00:00Z"),
            _count: { autoReviewResults: 1 },
            autoReviewResults: [
              {
                decision: "needs_review",
                tier2Results: null,
                tier1Results: [
                  { gate: "resolves_and_public", status: "pass", reason: "resolved" },
                  { gate: "platform_match", status: "pass", reason: "matches" },
                  { gate: "ownership_verified", status: "unresolved", reason: "needs a human to check" },
                  { gate: "draft_live_match", status: "unresolved", reason: "Could not compare draft and live content" },
                ],
              },
            ],
          },
        ]);
      });
      prisma.formatDeliverable.findUnique.mockResolvedValue({ ...baseDeliverable, livePostUrl: null });

      await service.catchUpMissedAutoReviews();

      expect(prisma.formatDeliverable.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "instagram-double-unresolved" } }),
      );
    });

    it("retries a stuck draft_live_match even when tier2Results already succeeded — they're independent Gemini calls", async () => {
      // Confirmed live: once Gemini started working again, a real
      // evaluateCompliance pass completed (tier2Results populated) in the
      // very same run that left draft_live_match unresolved — a separate
      // compareDraftToLive call. The old filter treated any non-null
      // tier2Results as "nothing left to retry" and silently stopped
      // retrying this deliverable forever.
      prisma.formatDeliverable.findMany.mockImplementation(({ where }: any) => {
        if (!where.autoReviewResults?.some) return Promise.resolve([]);
        return Promise.resolve([
          {
            id: "tier2-succeeded-but-live-match-stuck",
            status: "proof_under_review",
            livePostUrl: "https://www.instagram.com/reel/abc123/",
            draftSubmittedAt: null,
            liveSubmittedAt: new Date("2026-01-01T08:00:00Z"),
            _count: { autoReviewResults: 1 },
            autoReviewResults: [
              {
                decision: "needs_review",
                tier2Results: [
                  { criterionId: "c1", label: "x", pass: true, confidence: 1, reason: "ok", required: true },
                ],
                tier1Results: [
                  { gate: "resolves_and_public", status: "pass", reason: "resolved" },
                  { gate: "platform_match", status: "pass", reason: "matches" },
                  { gate: "ownership_verified", status: "pass", reason: "matches" },
                  { gate: "draft_live_match", status: "unresolved", reason: "Could not compare draft and live content" },
                ],
              },
            ],
          },
        ]);
      });
      prisma.formatDeliverable.findUnique.mockResolvedValue({ ...baseDeliverable, livePostUrl: null });

      await service.catchUpMissedAutoReviews();

      expect(prisma.formatDeliverable.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "tier2-succeeded-but-live-match-stuck" } }),
      );
    });

    it("does not retry the same double-unresolved shape on a non-Instagram platform — no first-party check to fall back on", async () => {
      apify.detectPlatform.mockReturnValue("youtube");
      prisma.formatDeliverable.findMany.mockImplementation(({ where }: any) => {
        if (!where.autoReviewResults?.some) return Promise.resolve([]);
        return Promise.resolve([
          {
            id: "youtube-double-unresolved",
            status: "proof_under_review",
            livePostUrl: "https://youtube.com/shorts/abc123",
            draftSubmittedAt: null,
            liveSubmittedAt: new Date("2026-01-01T08:00:00Z"),
            _count: { autoReviewResults: 1 },
            autoReviewResults: [
              {
                decision: "needs_review",
                tier2Results: null,
                tier1Results: [
                  { gate: "resolves_and_public", status: "pass", reason: "resolved" },
                  { gate: "platform_match", status: "pass", reason: "matches" },
                  { gate: "ownership_verified", status: "unresolved", reason: "needs a human to check" },
                  { gate: "draft_live_match", status: "unresolved", reason: "Could not compare draft and live content" },
                ],
              },
            ],
          },
        ]);
      });

      await service.catchUpMissedAutoReviews();

      expect(prisma.formatDeliverable.findUnique).not.toHaveBeenCalled();
    });

    it("applies an already-decided auto_rejected outcome when enforcement is on, instead of re-evaluating", async () => {
      // Confirmed live: "one piece" reached a confident auto_rejected
      // decision in shadow mode, then AUTO_REVIEW_ENFORCE_ENABLED was
      // turned on a few minutes later — nothing retroactively applies a
      // decision made before that flip, since every other gap here only
      // ever looks for needs_review.
      build(true, true);
      prisma.formatDeliverable.findMany.mockImplementation(({ where }: any) => {
        if (!where.autoReviewResults?.some) return Promise.resolve([]);
        return Promise.resolve([
          {
            id: "decided-but-unenforced",
            status: "proof_under_review",
            livePostUrl: "https://www.instagram.com/reel/abc123/",
            draftSubmittedAt: null,
            liveSubmittedAt: new Date("2026-01-01T08:00:00Z"),
            autoReviewResults: [
              {
                decision: "auto_rejected",
                modelVersion: "gemini-2.5-flash",
                tier2Results: [
                  { criterionId: "c1", label: "x", pass: true, confidence: 1, reason: "ok", required: true },
                ],
                tier1Results: [
                  { gate: "resolves_and_public", status: "pass", reason: "resolved" },
                  { gate: "platform_match", status: "pass", reason: "matches" },
                  { gate: "ownership_verified", status: "pass", reason: "matches" },
                  {
                    gate: "draft_live_match",
                    status: "fail",
                    reason: "Your live post doesn't match your approved draft — double-check the link and resubmit. (different clip)",
                  },
                ],
              },
            ],
          },
        ]);
      });
      prisma.formatDeliverable.findUnique.mockResolvedValue({
        id: "decided-but-unenforced",
        status: "proof_under_review",
        platform: "instagram_reel",
        participation: {
          id: "participation-1",
          creatorId: "creator-1",
          campaignId: "campaign-1",
          campaign: { title: "Test Campaign", brandProfileId: "brand-1" },
        },
      });
      prisma.formatDeliverable.update.mockResolvedValue({ status: "proof_rejected", platform: "instagram_reel" });

      await service.catchUpMissedAutoReviews();

      expect(prisma.formatDeliverable.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "decided-but-unenforced" },
          data: expect.objectContaining({
            status: "proof_rejected",
            rejectionReason: expect.stringContaining("resubmit"),
          }),
        }),
      );
      expect(notifications.create).toHaveBeenCalledWith(
        "creator-1",
        "creator",
        expect.objectContaining({ type: "proof_rejected" }),
      );
      // Applies the stored decision directly — never re-fetches the live
      // post or re-runs the comparison, and never writes a second
      // AutoReviewResult row for the same decision.
      expect(instagramOAuth.getOwnLivePostMedia).not.toHaveBeenCalled();
      expect(prisma.autoReviewResult.create).not.toHaveBeenCalled();
    });

    it("never applies an already-decided outcome when enforcement is off", async () => {
      // build() defaults to enforceEnabled: false.
      prisma.formatDeliverable.findMany.mockImplementation(({ where }: any) => {
        if (!where.autoReviewResults?.some) return Promise.resolve([]);
        return Promise.resolve([
          {
            id: "decided-shadow-mode",
            status: "proof_under_review",
            livePostUrl: "https://www.instagram.com/reel/abc123/",
            draftSubmittedAt: null,
            liveSubmittedAt: new Date("2026-01-01T08:00:00Z"),
            autoReviewResults: [
              {
                decision: "auto_rejected",
                modelVersion: "gemini-2.5-flash",
                tier2Results: null,
                tier1Results: [
                  { gate: "resolves_and_public", status: "pass", reason: "resolved" },
                  { gate: "platform_match", status: "pass", reason: "matches" },
                  { gate: "ownership_verified", status: "pass", reason: "matches" },
                  { gate: "draft_live_match", status: "fail", reason: "doesn't match" },
                ],
              },
            ],
          },
        ]);
      });

      await service.catchUpMissedAutoReviews();

      expect(prisma.formatDeliverable.findUnique).not.toHaveBeenCalled();
      expect(prisma.formatDeliverable.update).not.toHaveBeenCalled();
    });
  });
});
