import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assertRemoteVideoIsPlayable,
  probeFailure,
  probeRemoteForTest,
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
  const HUGE_PADDING = 200 * 1024 * 1024;
  let hugeServed = 0;
  let base = "";
  const video = readFileSync(FIXTURE);
  const corrupt = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(4000, 7)]);

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/400") return res.writeHead(400, { "Content-Type": "application/xml" }).end("<Error><Code>InvalidArgument</Code></Error>");
      if (req.url === "/401") return res.writeHead(401).end("Unauthorized");
      if (req.url === "/huge.mp4") {
        // A valid video followed by ~200 MB, served with Range support like R2.
        const total = video.length + HUGE_PADDING;
        const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
        const start = m ? Number(m[1]) : 0;
        const end = m && m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
        res.writeHead(m ? 206 : 200, {
          "Content-Type": "video/mp4",
          "Content-Length": end - start + 1,
          "Accept-Ranges": "bytes",
          ...(m ? { "Content-Range": `bytes ${start}-${end}/${total}` } : {}),
        });
        let pos = start;
        const pump = () => {
          while (pos <= end) {
            const chunk = pos < video.length ? video.subarray(pos, Math.min(video.length, end + 1)) : Buffer.alloc(Math.min(65536, end - pos + 1));
            pos += chunk.length;
            hugeServed += chunk.length;
            if (!res.write(chunk)) return void res.once("drain", pump);
          }
          res.end();
        };
        res.on("close", () => (pos = end + 1));
        return pump();
      }
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

  it("ffprobe reads through the local relay and only pulls the headers of a huge file", async () => {
    const { streams, bytes } = await probeRemoteForTest(`${base}/huge.mp4`);
    expect(streams.some((x) => x.codec_type === "video")).toBe(true);
    expect(bytes).toBeLessThan(16 * 1024 * 1024);
    expect(hugeServed).toBeLessThan(32 * 1024 * 1024); // the source wasn't drained either
  });

  it("hitting the byte cap is 'couldn't check', never 'not a video'", async () => {
    await expect(probeRemoteForTest(`${base}/huge.mp4`, 1024)).rejects.toBeInstanceOf(VideoProbeUnavailableError);
  });

  it("a valid video passes", async () => {
    await expect(assertRemoteVideoIsPlayable(`${base}/good.mp4`)).resolves.toBeUndefined();
  });
});
