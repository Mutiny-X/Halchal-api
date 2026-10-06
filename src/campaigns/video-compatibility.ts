import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

import ffprobePath from "@ffprobe-installer/ffprobe";

// The only pixel format iOS/Android hardware video decoders reliably support
// for H.264 playback. Files exported in editing/mastering-oriented profiles
// (e.g. H.264 High 4:4:4 Predictive, pix_fmt yuv444p) decode audio fine but
// silently produce no video frames — see the MutinyX reference asset bug.
const SUPPORTED_PIXEL_FORMATS = new Set(["yuv420p", "yuvj420p"]);

type ProbeStream = {
  codec_type?: string;
  pix_fmt?: string;
  profile?: string;
};

export class UnsupportedVideoFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedVideoFormatError";
  }
}

/** ffprobe itself couldn't run or reach the file (missing binary, no https
 * support in this build, network timeout) — says nothing about the video. */
export class VideoProbeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VideoProbeUnavailableError";
  }
}

/** ffprobe errors that genuinely mean "this isn't a usable video". Anything
 * else (network, TLS, storage answering 400/401/403, I/O errors, a missing
 * protocol) says nothing about the file, so it must never reject an upload
 * — the file's signature has already been checked by then. */
const NOT_A_VIDEO = /Invalid data found when processing input|moov atom not found|does not contain any stream|could not find codec parameters|EBML header parsing failed|Invalid NAL unit|no decoder found|Unknown format/i;

/** Classifies a failed ffprobe run from its stderr. */
export function probeFailure(stderr: string): UnsupportedVideoFormatError | VideoProbeUnavailableError {
  return NOT_A_VIDEO.test(stderr)
    ? new UnsupportedVideoFormatError("Could not read this file as a video. Please upload a valid MP4, MOV or WebM.")
    : new VideoProbeUnavailableError(`ffprobe could not read the input: ${stderr.trim().slice(0, 500) || "no error output"}`);
}

function probe(input: string, timeoutMs = 45_000): Promise<ProbeStream[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffprobePath.path, [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_entries",
      "stream=codec_type,pix_fmt,profile",
      "-i",
      input,
    ]);

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => (stdout += chunk));
    proc.stderr.on("data", (chunk) => (stderr += chunk));

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new VideoProbeUnavailableError("ffprobe timed out"));
    }, timeoutMs);

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new VideoProbeUnavailableError(`ffprobe could not start: ${err.message}`));
    });

    proc.on("close", (code, signal) => {
      clearTimeout(timer);
      if (signal) {
        // Killed or crashed — never a verdict on the file.
        reject(new VideoProbeUnavailableError(`ffprobe stopped by ${signal}${stderr ? `: ${stderr.trim().slice(0, 300)}` : ""}`));
        return;
      }
      if (code !== 0) {
        reject(probeFailure(stderr));
        return;
      }
      try {
        resolve((JSON.parse(stdout).streams ?? []) as ProbeStream[]);
      } catch (e) {
        reject(new Error(`Failed to parse ffprobe output: ${e}`));
      }
    });
  });
}

/**
 * Rejects videos whose picture track uses a pixel format phones can't
 * hardware-decode, before they ever reach a campaign. ffprobe needs to seek
 * within the file to read MP4 metadata (the moov atom isn't always at the
 * front), so the upload is written to a short-lived temp file rather than
 * piped — an in-memory stream isn't seekable.
 */
export async function assertVideoIsPlayable(buffer: Buffer): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "video-check-"));
  const filePath = join(dir, `${randomUUID()}.mp4`);
  try {
    await writeFile(filePath, buffer);
    assertPlayableStreams(await probe(filePath));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Same check for a file already in storage, without downloading it here:
 * ffprobe reads only the container headers over HTTP range requests from a
 * short-lived signed URL. Throws VideoProbeUnavailableError when the probe
 * itself can't run (callers decide whether that blocks the upload).
 */
export async function assertRemoteVideoIsPlayable(signedUrl: string): Promise<void> {
  const relay = await startRangeRelay(signedUrl);
  try {
    assertPlayableStreams(await probeThroughRelay(relay));
  } finally {
    await relay.close();
  }
}

type Relay = Awaited<ReturnType<typeof startRangeRelay>>;

/** If storage misbehaved or the byte cap was hit, ffprobe saw a partial
 * file — whatever it concluded says nothing about the real video. */
async function probeThroughRelay(relay: Relay): Promise<ProbeStream[]> {
  try {
    return await probe(relay.url);
  } catch (error) {
    if (relay.problem()) throw new VideoProbeUnavailableError(`storage read failed: ${relay.problem()}`);
    throw error;
  }
}

/** Most bytes one probe may pull through the relay. ffprobe only reads the
 * container headers (plus the index, which can sit at the end of an MP4),
 * so a few MB is normal; this just bounds a pathological file. */
export const MAX_PROBE_BYTES = 64 * 1024 * 1024;

/**
 * ffprobe never opens the storage URL itself: the static ffprobe build
 * crashes (SIGSEGV) on any network address inside Railway's containers, as
 * its built-in DNS lookup can't cope there. Instead it reads from this
 * loopback relay — Node does the DNS and TLS, and passes through only the
 * byte ranges ffprobe asks for, streaming, so a multi-GB video isn't
 * downloaded to probe its headers.
 */
async function startRangeRelay(
  sourceUrl: string,
  maxBytes = MAX_PROBE_BYTES,
): Promise<{ url: string; close: () => Promise<void>; bytesRelayed: () => number; problem: () => string | null }> {
  let relayed = 0;
  let problem: string | null = null;
  const upstreams = new Set<AbortController>();
  const server: Server = createServer(async (req, res) => {
    const abort = new AbortController();
    upstreams.add(abort);
    res.on("close", () => {
      abort.abort();
      upstreams.delete(abort);
    });
    try {
      if (relayed >= maxBytes) {
        problem ??= `probe read more than ${maxBytes} bytes`;
        res.writeHead(416).end();
        return;
      }
      const upstream = await fetch(sourceUrl, {
        method: req.method === "HEAD" ? "HEAD" : "GET",
        headers: req.headers.range ? { range: req.headers.range } : {},
        signal: abort.signal,
      });
      const headers: Record<string, string> = { "accept-ranges": "bytes" };
      for (const name of ["content-type", "content-length", "content-range"]) {
        const value = upstream.headers.get(name);
        if (value) headers[name] = value;
      }
      if (upstream.status >= 400) problem ??= `storage answered ${upstream.status}`;
      res.writeHead(upstream.status, headers);
      if (!upstream.body || req.method === "HEAD") {
        res.end();
        return;
      }
      const body = Readable.fromWeb(upstream.body as unknown as WebReadableStream);
      body.on("data", (chunk: Buffer) => {
        relayed += chunk.length;
        if (relayed > maxBytes) {
          problem ??= `probe read more than ${maxBytes} bytes`;
          body.destroy();
          res.destroy();
        }
      });
      body.on("error", () => res.destroy());
      body.pipe(res);
    } catch (error) {
      if (!abort.signal.aborted) problem ??= `storage request failed: ${(error as Error).message}`;
      if (!res.headersSent) res.writeHead(502);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/video`,
    bytesRelayed: () => relayed,
    problem: () => problem,
    close: () =>
      new Promise<void>((resolve) => {
        for (const a of upstreams) a.abort();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** For tests: probe through the relay and report how much was transferred. */
export async function probeRemoteForTest(signedUrl: string, maxBytes?: number) {
  const relay = await startRangeRelay(signedUrl, maxBytes);
  try {
    const streams = await probeThroughRelay(relay);
    return { streams, bytes: relay.bytesRelayed() };
  } finally {
    await relay.close();
  }
}

function assertPlayableStreams(streams: ProbeStream[]): void {
  const videoStream = streams.find((s) => s.codec_type === "video");
  if (!videoStream) {
    throw new UnsupportedVideoFormatError(
      "Could not read a video track from this file. Please upload a valid video.",
    );
  }

  if (!SUPPORTED_PIXEL_FORMATS.has(videoStream.pix_fmt ?? "")) {
    throw new UnsupportedVideoFormatError(
      `This video is encoded in a format phones can't play (${videoStream.pix_fmt ?? "unknown"}` +
        `${videoStream.profile ? `, profile: ${videoStream.profile}` : ""}). ` +
        "Please re-export it as standard H.264 (yuv420p) and upload again.",
    );
  }
}
