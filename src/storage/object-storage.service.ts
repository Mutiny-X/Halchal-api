import { BadRequestException, Injectable, InternalServerErrorException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Env } from "../config/env";
import { DIRECT_UPLOAD_CONTENT_TYPES, type DetectedFileType } from "../common/file-signature";
import { ensureUploadDir, uploadFilename } from "../common/upload.util";

export type PresignedUpload = {
  uploadUrl: string;
  publicUrl: string;
};

export type UploadedFilePayload = {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
};

export type StoredUploadResult = {
  url: string;
  path: string;
  name: string;
};

@Injectable()
export class ObjectStorageService {
  private readonly s3Client: S3Client | null;

  constructor(private readonly config: ConfigService<Env, true>) {
    if (this.isR2Configured()) {
      this.s3Client = new S3Client({
        region: this.config.get("S3_REGION", { infer: true }),
        endpoint: this.config.get("S3_ENDPOINT", { infer: true }),
        credentials: {
          accessKeyId: this.config.get("S3_ACCESS_KEY_ID", { infer: true }),
          secretAccessKey: this.config.get("S3_SECRET_ACCESS_KEY", { infer: true }),
        },
        // Newer AWS SDKs add a CRC32 checksum to every request by default —
        // for a presigned PUT that's the checksum of an EMPTY body baked into
        // the URL, so the browser's real upload can't match it. Cloudflare's
        // R2 docs recommend only sending checksums when an operation needs one.
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
      });
      return;
    }

    this.s3Client = null;
  }

  isR2Configured(): boolean {
    return Boolean(
      this.config.get("S3_ENDPOINT", { infer: true }) &&
        this.config.get("S3_BUCKET", { infer: true }) &&
        this.config.get("S3_ACCESS_KEY_ID", { infer: true }) &&
        this.config.get("S3_SECRET_ACCESS_KEY", { infer: true }) &&
        this.config.get("S3_PUBLIC_BASE_URL", { infer: true }),
    );
  }

  async saveUploadedFile(
    folder: string,
    file: UploadedFilePayload,
  ): Promise<StoredUploadResult> {
    const filename = uploadFilename(file.originalname, file.mimetype);
    const key = `${folder}/${filename}`;

    if (this.isR2Configured()) {
      await this.uploadToR2(key, file.buffer, file.mimetype);
      return buildR2UploadResponse(
        this.config.get("S3_PUBLIC_BASE_URL", { infer: true }),
        key,
        file.originalname,
      );
    }

    return this.saveToLocalDisk(folder, filename, file);
  }

  /** Stores a file whose real type was already established from its bytes
   * (see detectFileType). Both the stored extension and the Content-Type it
   * is served with come from that detection — never from the uploader's file
   * name or claimed MIME type — so a renamed .html/.svg can't ride in. */
  async saveVerifiedFile(
    folder: string,
    buffer: Buffer,
    detected: DetectedFileType,
    originalname: string,
  ): Promise<StoredUploadResult> {
    const filename = `${Date.now()}-${randomBytes(8).toString("hex")}${detected.extension}`;
    const key = `${folder}/${filename}`;

    if (this.isR2Configured()) {
      await this.uploadToR2(key, buffer, detected.mimeType);
      return buildR2UploadResponse(
        this.config.get("S3_PUBLIC_BASE_URL", { infer: true }),
        key,
        originalname,
      );
    }

    return this.saveToLocalDisk(folder, filename, {
      buffer,
      originalname,
      mimetype: detected.mimeType,
    });
  }

  /** A presigned URL the client PUTs the file bytes to directly — R2 never
   * passes through this server at all, so file size is bounded only by
   * R2's own single-PUT ceiling (5GB), not by how much this process can
   * safely hold in memory. Only meaningful when R2 is configured; the
   * local-disk fallback (dev without R2 creds) has no presigned-URL
   * equivalent, so callers should fall back to the existing buffered
   * saveUploadedFile() path when isR2Configured() is false. */
  async presignUpload(
    folder: string,
    originalFileName: string,
    contentType: string,
  ): Promise<PresignedUpload> {
    if (!this.isR2Configured() || !this.s3Client) {
      throw new InternalServerErrorException("Object storage is not configured");
    }

    // The bytes never pass through this server on this path, so the type
    // can't be sniffed — instead only known-safe types are signed, and the
    // extension comes from that type, not the client's file name. R2 then
    // serves the object with exactly this Content-Type.
    const extension = DIRECT_UPLOAD_CONTENT_TYPES[contentType];
    if (!extension) {
      throw new BadRequestException({
        code: "VALIDATION_ERROR",
        message: "Only JPEG, PNG, WebP, GIF, MP4, MOV and WebM files can be uploaded",
      });
    }
    const filename = `${Date.now()}-${randomBytes(8).toString("hex")}${extension}`;
    const key = `${folder}/${filename}`;

    // Cast: @aws-sdk/s3-request-presigner pulls in its own, slightly newer
    // copy of @smithy/core (via its @aws-sdk/signature-v4-multi-region
    // dependency) than @aws-sdk/client-s3 resolves for this.s3Client —
    // pnpm-workspace.yaml's override fixes the equivalent @smithy/types
    // duplication but doesn't reach this one. Both are genuinely S3Client
    // at runtime; this is purely a duplicate-package structural-typing
    // mismatch (TypeScript treats the two @smithy/core Client types as
    // distinct even though they're semver-compatible), not a real
    // incompatibility.
    const uploadUrl = await getSignedUrl(
      this.s3Client as unknown as Parameters<typeof getSignedUrl>[0],
      new PutObjectCommand({
        Bucket: this.config.get("S3_BUCKET", { infer: true }),
        Key: key,
        ContentType: contentType,
      }),
      {
        expiresIn: 3600,
        // Sign the Content-Type too: otherwise the URL is only bound to the
        // host, and whoever holds it could PUT the object as text/html and
        // have our storage domain serve it as a web page.
        signableHeaders: new Set(["content-type"]),
      },
    );

    const { url: publicUrl } = buildR2UploadResponse(
      this.config.get("S3_PUBLIC_BASE_URL", { infer: true }),
      key,
      originalFileName,
    );

    return { uploadUrl, publicUrl };
  }

  // ── Direct (browser → R2) uploads ─────────────────────────────────────
  // The API only signs, inspects a few KB, and copies inside R2 — the file's
  // bytes never pass through this server.

  private requireR2(): S3Client {
    if (!this.isR2Configured() || !this.s3Client) {
      throw new InternalServerErrorException("Object storage is not configured");
    }
    return this.s3Client;
  }

  private bucket(): string {
    return this.config.get("S3_BUCKET", { infer: true });
  }

  /** Presigned PUT bound to an exact key, Content-Type AND byte size: the
   * browser can only upload exactly the file it declared. */
  async presignExactPut(
    key: string,
    contentType: string,
    sizeBytes: number,
    expiresInSeconds = 3600,
  ): Promise<string> {
    const client = this.requireR2();
    return getSignedUrl(
      client as unknown as Parameters<typeof getSignedUrl>[0],
      new PutObjectCommand({
        Bucket: this.bucket(),
        Key: key,
        ContentType: contentType,
        ContentLength: sizeBytes,
      }),
      {
        expiresIn: expiresInSeconds,
        signableHeaders: new Set(["content-type", "content-length"]),
      },
    );
  }

  /** Short-lived signed GET — lets ffprobe read a video's headers straight
   * from storage with range requests instead of downloading it here. */
  async presignGet(key: string, expiresInSeconds = 300): Promise<string> {
    const client = this.requireR2();
    return getSignedUrl(
      client as unknown as Parameters<typeof getSignedUrl>[0],
      new GetObjectCommand({ Bucket: this.bucket(), Key: key }),
      { expiresIn: expiresInSeconds },
    );
  }

  /** Size + type of a stored object, or null when it doesn't exist. */
  async headObject(key: string): Promise<{ size: number; contentType: string | undefined } | null> {
    const client = this.requireR2();
    try {
      const head = await client.send(new HeadObjectCommand({ Bucket: this.bucket(), Key: key }));
      return { size: Number(head.ContentLength ?? 0), contentType: head.ContentType };
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404 || (error as { name?: string }).name === "NotFound") return null;
      throw error;
    }
  }

  /** The first `length` bytes of an object (for file-type detection). */
  async readObjectHead(key: string, length = 4096): Promise<Buffer> {
    const client = this.requireR2();
    const res = await client.send(
      new GetObjectCommand({ Bucket: this.bucket(), Key: key, Range: `bytes=0-${length - 1}` }),
    );
    const bytes = await res.Body?.transformToByteArray();
    return Buffer.from(bytes ?? []);
  }

  /** Server-side copy inside the bucket — no bytes come through this API. */
  async copyObject(fromKey: string, toKey: string): Promise<void> {
    const client = this.requireR2();
    await client.send(
      new CopyObjectCommand({
        Bucket: this.bucket(),
        Key: toKey,
        CopySource: `${this.bucket()}/${fromKey.split("/").map(encodeURIComponent).join("/")}`,
        MetadataDirective: "COPY",
      }),
    );
  }

  async deleteObject(key: string): Promise<void> {
    const client = this.requireR2();
    await client.send(new DeleteObjectCommand({ Bucket: this.bucket(), Key: key }));
  }

  publicUrlFor(key: string): string {
    return buildR2UploadResponse(this.config.get("S3_PUBLIC_BASE_URL", { infer: true }), key, key).url;
  }

  private async uploadToR2(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    if (!this.s3Client) {
      throw new InternalServerErrorException("Object storage is not configured");
    }

    try {
      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: this.config.get("S3_BUCKET", { infer: true }),
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
    } catch (error) {
      throw new InternalServerErrorException("Failed to upload file to object storage", {
        cause: error,
      });
    }
  }

  private saveToLocalDisk(
    folder: string,
    filename: string,
    file: UploadedFilePayload,
  ): StoredUploadResult {
    const dir = ensureUploadDir(folder);
    writeFileSync(join(dir, filename), file.buffer);

    const path = `/uploads/${folder}/${filename}`;
    return {
      url: path,
      path,
      name: file.originalname,
    };
  }
}

export function buildR2UploadResponse(
  publicBaseUrl: string,
  key: string,
  originalname: string,
): StoredUploadResult {
  const url = `${publicBaseUrl.replace(/\/$/, "")}/${key}`;
  return {
    url,
    path: url,
    name: originalname,
  };
}
