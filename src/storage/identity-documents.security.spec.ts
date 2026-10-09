import { describe, expect, it, vi } from "vitest";

const sent: { name: string; input: Record<string, unknown> }[] = [];
vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-s3")>();
  return {
    ...actual,
    S3Client: class {
      async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
        sent.push({ name: command.constructor.name, input: command.input });
        return {};
      }
    },
  };
});
vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn(async (_c: unknown, command: { input: { Bucket: string; Key: string } }, opts: { expiresIn: number }) =>
    `https://signed.example/${command.input.Bucket}/${command.input.Key}?exp=${opts.expiresIn}`,
  ),
}));

import { isPrivateDocumentRef, ObjectStorageService } from "./object-storage.service";

function storage(privateBucket?: string) {
  const values: Record<string, string | undefined> = {
    S3_ENDPOINT: "https://r2.example",
    S3_BUCKET: "public-bucket",
    S3_PRIVATE_BUCKET: privateBucket,
    S3_ACCESS_KEY_ID: "id",
    S3_SECRET_ACCESS_KEY: "secret",
    S3_PUBLIC_BASE_URL: "https://cdn.example",
    S3_REGION: "auto",
  };
  return new ObjectStorageService({ get: (k: string) => values[k] } as never);
}

const FILE = { buffer: Buffer.from("png-bytes"), originalname: "pan.png", mimetype: "image/png" };

describe("identity documents (KYC / PAN / Aadhaar)", () => {
  it("go to the PRIVATE bucket and are stored as a reference, never a link anyone can open", async () => {
    sent.length = 0;
    const out = await storage("private-bucket").saveIdentityDocument("pan-documents", FILE);
    expect(isPrivateDocumentRef(out.url)).toBe(true);
    expect(out.url).toMatch(/^private:pan-documents\/[A-Za-z0-9._-]+$/);
    expect(out.url).not.toContain("http");
    const put = sent.find((s) => s.name === "PutObjectCommand")!;
    expect(put.input.Bucket).toBe("private-bucket");
    expect(put.input.CacheControl).toBe("private, no-store");
  });

  it("never touch the public bucket when a private one is configured", async () => {
    sent.length = 0;
    await storage("private-bucket").saveIdentityDocument("kyc-documents", FILE);
    expect(sent.every((s) => s.input.Bucket !== "public-bucket")).toBe(true);
  });

  it("refuse any folder that isn't an identity-document folder", async () => {
    await expect(storage("private-bucket").saveIdentityDocument("avatars", FILE)).rejects.toThrow();
  });

  it("are opened through a signed link that expires in minutes", async () => {
    const url = await storage("private-bucket").resolveDocumentUrl("private:pan-documents/abc-123.png");
    expect(url).toContain("/private-bucket/pan-documents/abc-123.png");
    expect(url).toMatch(/exp=600$/);
  });

  it("refuse to sign a key outside the identity folders (no reading arbitrary private objects)", async () => {
    const s = storage("private-bucket");
    expect(await s.resolveDocumentUrl("private:../secrets/key")).toBeNull();
    expect(await s.resolveDocumentUrl("private:avatars/a.png")).toBeNull();
    expect(await s.resolveDocumentUrl("private:pan-documents/a/b.png")).toBeNull();
  });

  it("older public links pass through unchanged, and null stays null", async () => {
    const s = storage("private-bucket");
    expect(await s.resolveDocumentUrl("https://cdn.example/pan-documents/old.png")).toBe("https://cdn.example/pan-documents/old.png");
    expect(await s.resolveDocumentUrl(null)).toBeNull();
  });

  it("are deleted from the private bucket when the account is deleted", async () => {
    sent.length = 0;
    expect(await storage("private-bucket").deleteIdentityFile("private:kyc-documents/x.png")).toBe(true);
    const del = sent.find((s) => s.name === "DeleteObjectCommand")!;
    expect(del.input).toMatchObject({ Bucket: "private-bucket", Key: "kyc-documents/x.png" });
  });

  it("without a private bucket (local development) fall back to normal storage", async () => {
    sent.length = 0;
    const out = await storage(undefined).saveIdentityDocument("pan-documents", FILE);
    expect(isPrivateDocumentRef(out.url)).toBe(false);
    expect(sent.find((s) => s.name === "PutObjectCommand")!.input.Bucket).toBe("public-bucket");
  });
});
