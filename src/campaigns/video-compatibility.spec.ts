import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assertRemoteVideoIsPlayable,
  probeFailure,
  UnsupportedVideoFormatError,
  VideoProbeUnavailableError,
} from "./video-compatibility";

const FIXTURE = join(__dirname, "__fixtures__", "tiny.mp4");

describe("classifying ffprobe failures", () => {
  it.each([
    "Invalid data found when processing input",
    "[mov,mp4] moov atom not found",
    "EBML header parsing failed",
  ])("'%s' → not a video (rejects the upload)", (stderr) => {
    expect(probeFailure(stderr)).toBeInstanceOf(UnsupportedVideoFormatError);
  });

  it.each([
    "Server returned 400 Bad Request",
    "Server returned 401 Unauthorized (authorization failed)",
    "Server returned 4XX Client Error, but not one of 40{0,1,3,4}",
    "Input/output error",
    "error:0A000086:SSL routines::certificate verify failed",
    "Error in the pull function.",
    "",
  ])("'%s' → probe unavailable (upload is NOT rejected)", (stderr) => {
    expect(probeFailure(stderr)).toBeInstanceOf(VideoProbeUnavailableError);
  });
});

describe("real ffprobe over HTTP (like a signed R2 URL)", () => {
  let server: Server;
  let base = "";
  const video = readFileSync(FIXTURE);
  const corrupt = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(4000, 7)]);

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/400") return res.writeHead(400, { "Content-Type": "application/xml" }).end("<Error><Code>InvalidArgument</Code></Error>");
      if (req.url === "/401") return res.writeHead(401).end("Unauthorized");
      const body = req.url === "/good.mp4" ? video : corrupt;
      res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": body.length, "Accept-Ranges": "bytes" }).end(body);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  afterAll(() => server.close());

  it("storage answering 400 / 401 → skipped, not 'not a video'", async () => {
    await expect(assertRemoteVideoIsPlayable(`${base}/400`)).rejects.toBeInstanceOf(VideoProbeUnavailableError);
    await expect(assertRemoteVideoIsPlayable(`${base}/401`)).rejects.toBeInstanceOf(VideoProbeUnavailableError);
  });

  it("a corrupt file that only looks like an MP4 is still rejected", async () => {
    await expect(assertRemoteVideoIsPlayable(`${base}/bad.mp4`)).rejects.toBeInstanceOf(UnsupportedVideoFormatError);
  });

  it("a valid video passes", async () => {
    await expect(assertRemoteVideoIsPlayable(`${base}/good.mp4`)).resolves.toBeUndefined();
  });
});
