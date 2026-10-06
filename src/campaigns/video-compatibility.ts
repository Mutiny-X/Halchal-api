import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

    proc.on("close", (code) => {
      clearTimeout(timer);
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
  assertPlayableStreams(await probe(signedUrl));
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
