import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assertPublicHttpUrl,
  isNonPublicAddress,
  safeFetch,
  setSafeFetchResolverForTests,
  UnsafeUrlError,
} from "./safe-fetch";

const PUBLIC_IP = "93.184.216.34";

function redirect(location: string, status = 302) {
  return { status, ok: false, headers: new Headers({ location }), body: null } as unknown as Response;
}

function ok() {
  return { status: 200, ok: true, headers: new Headers(), body: null } as unknown as Response;
}

describe("isNonPublicAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fd00::1",
    "fe80::1",
    "::ffff:10.0.0.1",
    "::ffff:a00:1",
    "64:ff9b::a00:1",
    "not-an-ip",
  ])("blocks %s", (ip) => {
    expect(isNonPublicAddress(ip)).toBe(true);
  });

  it.each(["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700:4700::1111"])(
    "allows public %s",
    (ip) => {
      expect(isNonPublicAddress(ip)).toBe(false);
    },
  );
});

describe("assertPublicHttpUrl", () => {
  beforeEach(() => setSafeFetchResolverForTests(async () => [PUBLIC_IP]));
  afterEach(() => setSafeFetchResolverForTests(null));

  it("accepts a normal https URL that resolves publicly", async () => {
    await expect(assertPublicHttpUrl("https://drive.google.com/file/d/abc/view")).resolves.toBeInstanceOf(URL);
  });

  it.each([
    ["internal IP literal", "http://169.254.169.254/latest/meta-data/"],
    ["loopback", "http://127.0.0.1/"],
    ["IPv6 loopback", "http://[::1]/"],
    ["localhost name", "http://localhost/"],
    ["railway private network", "http://postgres.railway.internal/"],
    ["non-web port", "https://example.com:5432/"],
    ["file scheme", "file:///etc/passwd"],
    ["javascript scheme", "javascript:alert(1)"],
    ["embedded credentials", "https://user:pw@example.com/"],
    ["garbage", "not a url"],
  ])("rejects %s", async (_label, url) => {
    await expect(assertPublicHttpUrl(url)).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it("rejects a public-looking name that resolves to a private address", async () => {
    setSafeFetchResolverForTests(async () => ["10.0.0.5"]);
    await expect(assertPublicHttpUrl("https://evil.example.com/")).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it("rejects when ANY resolved address is private (mixed answers)", async () => {
    setSafeFetchResolverForTests(async () => [PUBLIC_IP, "127.0.0.1"]);
    await expect(assertPublicHttpUrl("https://evil.example.com/")).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it("rejects a host that does not resolve", async () => {
    setSafeFetchResolverForTests(async () => {
      throw new Error("ENOTFOUND");
    });
    await expect(assertPublicHttpUrl("https://nope.example.com/")).rejects.toBeInstanceOf(UnsafeUrlError);
  });
});

describe("safeFetch", () => {
  beforeEach(() => setSafeFetchResolverForTests(async (host) => (host === "internal.example.com" ? ["10.0.0.9"] : [PUBLIC_IP])));
  afterEach(() => {
    setSafeFetchResolverForTests(null);
    vi.restoreAllMocks();
  });

  it("never follows redirects automatically", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(ok());
    await safeFetch("https://example.com/a");
    expect(spy.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
  });

  it("follows a redirect to another public host", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(redirect("https://cdn.example.com/b"))
      .mockResolvedValueOnce(ok());
    const res = await safeFetch("https://example.com/a");
    expect(res.status).toBe(200);
    expect(spy.mock.calls[1][0]).toBe("https://cdn.example.com/b");
  });

  it("resolves a relative redirect against the current URL", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(redirect("/next?x=1"))
      .mockResolvedValueOnce(ok());
    await safeFetch("https://example.com/a/b");
    expect(spy.mock.calls[1][0]).toBe("https://example.com/next?x=1");
  });

  it("refuses a redirect that bounces to an internal address", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(redirect("http://169.254.169.254/latest/meta-data/"));
    await expect(safeFetch("https://example.com/a")).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("refuses a redirect to a name that resolves internally", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(redirect("https://internal.example.com/"));
    await expect(safeFetch("https://example.com/a")).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it("gives up after too many redirects", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => redirect("https://example.com/loop"));
    await expect(safeFetch("https://example.com/a")).rejects.toThrow("Too many redirects");
  });

  it("never calls fetch for an internal URL", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    await expect(safeFetch("http://127.0.0.1:80/admin")).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(spy).not.toHaveBeenCalled();
  });
});
