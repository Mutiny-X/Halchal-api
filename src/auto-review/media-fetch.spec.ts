import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { setSafeFetchResolverForTests } from "../common/safe-fetch";
import { checkMediaUrlFetchable, fetchMedia } from "./media-fetch";

// Hermetic DNS: every test host resolves to a public address, so these
// specs never touch the network (the SSRF guard has its own spec).
beforeAll(() => setSafeFetchResolverForTests(async () => ["93.184.216.34"]));
afterAll(() => setSafeFetchResolverForTests(null));

function makeResponse(opts: {
  ok?: boolean;
  status?: number;
  headers?: Record<string, string>;
  body?: Uint8Array;
  text?: string;
}) {
  const headers = new Headers(opts.headers ?? {});
  const body = opts.body ?? new Uint8Array([1, 2, 3]);
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    headers,
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    text: async () => opts.text ?? "",
  } as unknown as Response;
}

describe("fetchMedia", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves a Drive share URL (/file/d/<id>/view) to the direct-download endpoint", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeResponse({ headers: { "content-type": "video/quicktime" } }),
    );

    await fetchMedia("https://drive.google.com/file/d/10Sipz5m7MjvK4cdeT_3GfSqUj-9SuOkw/view?usp=drivesdk");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const requestedUrl = fetchSpy.mock.calls[0][0] as string;
    expect(requestedUrl).toBe(
      "https://drive.google.com/uc?export=download&id=10Sipz5m7MjvK4cdeT_3GfSqUj-9SuOkw",
    );
  });

  it("resolves a Drive open?id=<id> URL to the direct-download endpoint", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeResponse({ headers: { "content-type": "video/mp4" } }),
    );

    await fetchMedia("https://drive.google.com/open?id=abc123");

    const requestedUrl = fetchSpy.mock.calls[0][0] as string;
    expect(requestedUrl).toBe("https://drive.google.com/uc?export=download&id=abc123");
  });

  it("fetches a non-Drive URL as-is, unmodified", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeResponse({ headers: { "content-type": "video/mp4" } }),
    );

    await fetchMedia("https://cdn.example.com/videos/clip.mp4");

    const requestedUrl = fetchSpy.mock.calls[0][0] as string;
    expect(requestedUrl).toBe("https://cdn.example.com/videos/clip.mp4");
  });

  it("returns the real bytes and mime type for a successful Drive direct-download", async () => {
    const body = new Uint8Array([9, 9, 9, 9]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeResponse({ headers: { "content-type": "video/quicktime" }, body }),
    );

    const result = await fetchMedia("https://drive.google.com/file/d/FILEID/view");

    expect(result).not.toBeNull();
    expect(result?.mimeType).toBe("video/quicktime");
    expect(result?.buffer).toEqual(Buffer.from(body));
  });

  it("guesses mime type from Content-Disposition filename when Content-Type is octet-stream", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeResponse({
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": 'attachment; filename="IMG_9748.MOV"',
        },
      }),
    );

    const result = await fetchMedia("https://drive.google.com/file/d/FILEID/view");

    expect(result?.mimeType).toBe("video/quicktime");
  });

  it("treats an HTML response as Drive's virus-scan interstitial and returns null", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeResponse({ headers: { "content-type": "text/html; charset=utf-8" } }),
    );

    const result = await fetchMedia("https://drive.google.com/file/d/FILEID/view");

    expect(result).toBeNull();
  });

  it("returns null for a non-2xx response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(makeResponse({ ok: false, status: 404 }));

    const result = await fetchMedia("https://drive.google.com/file/d/FILEID/view");

    expect(result).toBeNull();
  });

  it("returns null for a Drive URL with no recognizable file id", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeResponse({ headers: { "content-type": "video/mp4" } }),
    );

    await fetchMedia("https://drive.google.com/drive/folders/someFolderId");

    // No file id found -> falls through to fetching the original URL as-is.
    const requestedUrl = fetchSpy.mock.calls[0][0] as string;
    expect(requestedUrl).toBe("https://drive.google.com/drive/folders/someFolderId");
  });

  it("returns null when fetch throws (e.g. timeout/network error)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network error"));

    const result = await fetchMedia("https://drive.google.com/file/d/FILEID/view");

    expect(result).toBeNull();
  });
});

describe("checkMediaUrlFetchable", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports fetchable for a Drive link that resolves to real video content", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeResponse({ headers: { "content-type": "video/quicktime" } }),
    );

    const result = await checkMediaUrlFetchable("https://drive.google.com/file/d/FILEID/view");

    expect(result).toEqual({ fetchable: true });
  });

  it("never reads the response body — only checks headers", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "video/mp4" }),
      body: { cancel },
      arrayBuffer: () => {
        throw new Error("should never be called — this would download the whole file");
      },
    } as unknown as Response);

    const result = await checkMediaUrlFetchable("https://drive.google.com/file/d/FILEID/view");

    expect(result).toEqual({ fetchable: true });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("reports not fetchable, with a sharing-settings hint, for a private (403) link", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(makeResponse({ ok: false, status: 403 }));

    const result = await checkMediaUrlFetchable("https://drive.google.com/file/d/FILEID/view");

    expect(result.fetchable).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/anyone with the link/i);
  });

  it("reports not fetchable, with an upload hint, when Drive's interstitial has no confirm form fields to follow", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeResponse({ headers: { "content-type": "text/html; charset=utf-8" }, text: "<html>no form here</html>" }),
    );

    const result = await checkMediaUrlFetchable("https://drive.google.com/file/d/FILEID/view");

    expect(result.fetchable).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/upload the video from your device/i);
  });

  const INTERSTITIAL_FORM_HTML =
    '<form action="https://drive.usercontent.google.com/download" method="get">' +
    '<input type="hidden" name="id" value="FILEID">' +
    '<input type="hidden" name="export" value="download">' +
    '<input type="hidden" name="confirm" value="t">' +
    '<input type="hidden" name="uuid" value="uuid-123">' +
    "</form>";

  it("follows the hidden-form confirm fields in Drive's virus-scan interstitial and reports fetchable when the retry returns real content", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      makeResponse({
        headers: { "content-type": "text/html; charset=utf-8" },
        text: INTERSTITIAL_FORM_HTML,
      }),
    );
    fetchSpy.mockResolvedValueOnce(makeResponse({ headers: { "content-type": "video/mp4" } }));

    const result = await checkMediaUrlFetchable("https://drive.google.com/file/d/FILEID/view");

    expect(result).toEqual({ fetchable: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const retryUrl = fetchSpy.mock.calls[1][0] as string;
    expect(retryUrl).toBe(
      "https://drive.usercontent.google.com/download?id=FILEID&export=download&confirm=t&uuid=uuid-123",
    );
  });

  it("sends the interstitial's cookie on the confirm retry request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      makeResponse({
        headers: {
          "content-type": "text/html; charset=utf-8",
          "set-cookie": "download_warning=abc; Path=/",
        },
        text: INTERSTITIAL_FORM_HTML,
      }),
    );
    fetchSpy.mockResolvedValueOnce(makeResponse({ headers: { "content-type": "video/mp4" } }));

    await checkMediaUrlFetchable("https://drive.google.com/file/d/FILEID/view");

    const retryOptions = fetchSpy.mock.calls[1][1] as RequestInit;
    expect((retryOptions.headers as Record<string, string>).cookie).toBe("download_warning=abc; Path=/");
  });

  it("still reports not fetchable when the confirm retry itself returns another interstitial", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValue(
      makeResponse({
        headers: { "content-type": "text/html; charset=utf-8" },
        text: INTERSTITIAL_FORM_HTML,
      }),
    );

    const result = await checkMediaUrlFetchable("https://drive.google.com/file/d/FILEID/view");

    expect(result.fetchable).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("reports not fetchable when fetch throws", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network error"));

    const result = await checkMediaUrlFetchable("https://drive.google.com/file/d/FILEID/view");

    expect(result.fetchable).toBe(false);
  });
});
