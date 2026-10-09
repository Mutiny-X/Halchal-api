import { NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { UsersService } from "./users.service";

function makePrisma() {
  return {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    refreshToken: { updateMany: vi.fn() },
    deviceToken: { deleteMany: vi.fn() },
    instagramConnection: { deleteMany: vi.fn() },
    youtubeConnection: { deleteMany: vi.fn() },
    instagramOAuthTransaction: { deleteMany: vi.fn() },
    $transaction: vi.fn((ops: unknown[]) => Promise.all(ops)),
  };
}

function makeCashfree() {
  return {
    verifyPanByOcr: vi.fn(),
    verifyAadhaar: vi.fn(),
  };
}

describe("UsersService", () => {
  let prisma: ReturnType<typeof makePrisma>;
  let cashfree: ReturnType<typeof makeCashfree>;
  let service: UsersService;

  beforeEach(() => {
    prisma = makePrisma();
    cashfree = makeCashfree();
    service = new UsersService(prisma as never, {} as never, cashfree as never, { deleteIdentityFile: vi.fn().mockResolvedValue(true) } as never);
  });

  describe("submitPan", () => {
    const buffer = Buffer.from("fake-image");

    it("throws NotFoundException when the user doesn't exist", async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.submitPan("user-1", "https://example.com/pan.jpg", buffer, "image/jpeg"),
      ).rejects.toThrow(NotFoundException);
    });

    it("throws ServiceUnavailableException when Cashfree can't be reached (not a rejection)", async () => {
      prisma.user.findUnique.mockResolvedValue({ id: "user-1", displayName: "Test User" });
      cashfree.verifyPanByOcr.mockResolvedValue(null);

      await expect(
        service.submitPan("user-1", "https://example.com/pan.jpg", buffer, "image/jpeg"),
      ).rejects.toThrow(ServiceUnavailableException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it("marks verified on a real, government-matched PAN", async () => {
      prisma.user.findUnique.mockResolvedValue({ id: "user-1", displayName: "Test User" });
      cashfree.verifyPanByOcr.mockResolvedValue({
        valid: true,
        panNumber: "ABCPV1234D",
        name: "TEST USER",
        dob: "1990-01-01",
        panStatus: "VALID",
      });
      prisma.user.update.mockResolvedValue({
        panVerificationStatus: "verified",
        panFailureReason: null,
      });

      const result = await service.submitPan("user-1", "https://example.com/pan.jpg", buffer, "image/jpeg");

      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            panDocumentUrl: "https://example.com/pan.jpg",
            panNumber: "ABCPV1234D",
            panVerificationStatus: "verified",
            panVerifiedName: "TEST USER",
            panFailureReason: null,
          }),
        }),
      );
      expect(result.panVerificationStatus).toBe("verified");
    });

    it("rejects when Cashfree flags the document itself as invalid/unverifiable", async () => {
      prisma.user.findUnique.mockResolvedValue({ id: "user-1", displayName: "Test User" });
      cashfree.verifyPanByOcr.mockResolvedValue({ valid: false, reason: "Failed fraud checks: is_forged" });
      prisma.user.update.mockResolvedValue({
        panVerificationStatus: "rejected",
        panFailureReason: "Failed fraud checks: is_forged",
      });

      const result = await service.submitPan("user-1", "https://example.com/pan.jpg", buffer, "image/jpeg");

      expect(result.panFailureReason).toContain("fraud");
    });
  });

  describe("submitAadhaar", () => {
    const buffer = Buffer.from("fake-image");

    it("throws NotFoundException when the user doesn't exist", async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.submitAadhaar("user-1", "https://example.com/a.jpg", buffer, "image/jpeg"),
      ).rejects.toThrow(NotFoundException);
    });

    it("throws ServiceUnavailableException when Cashfree can't be reached", async () => {
      prisma.user.findUnique.mockResolvedValue({ id: "user-1" });
      cashfree.verifyAadhaar.mockResolvedValue(null);

      await expect(
        service.submitAadhaar("user-1", "https://example.com/a.jpg", buffer, "image/jpeg"),
      ).rejects.toThrow(ServiceUnavailableException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it("marks verified when the document is valid and the QR cryptographically verified", async () => {
      prisma.user.findUnique.mockResolvedValue({ id: "user-1" });
      cashfree.verifyAadhaar.mockResolvedValue({
        valid: true,
        name: "Test User",
        dob: "1990-01-01",
        gender: "Male",
        maskedNumber: "XXXXXXXX1234",
        qrVerified: true,
      });
      prisma.user.update.mockResolvedValue({
        aadhaarVerificationStatus: "verified",
        aadhaarFailureReason: null,
      });

      const result = await service.submitAadhaar("user-1", "https://example.com/a.jpg", buffer, "image/jpeg");

      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            aadhaarDocumentUrl: "https://example.com/a.jpg",
            aadhaarVerificationStatus: "verified",
            aadhaarVerifiedName: "Test User",
            aadhaarMaskedNumber: "XXXXXXXX1234",
            aadhaarFailureReason: null,
          }),
        }),
      );
      expect(result.aadhaarVerificationStatus).toBe("verified");
    });

    it("rejects a document that's valid but whose QR didn't cryptographically verify — OCR alone isn't enough", async () => {
      prisma.user.findUnique.mockResolvedValue({ id: "user-1" });
      cashfree.verifyAadhaar.mockResolvedValue({
        valid: true,
        name: "Test User",
        dob: null,
        gender: null,
        maskedNumber: "XXXXXXXX1234",
        qrVerified: false,
      });
      prisma.user.update.mockResolvedValue({
        aadhaarVerificationStatus: "rejected",
        aadhaarFailureReason: "Couldn't cryptographically verify this document's QR code — try a clearer, well-lit photo of the front",
      });

      const result = await service.submitAadhaar("user-1", "https://example.com/a.jpg", buffer, "image/jpeg");

      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ aadhaarVerificationStatus: "rejected" }) }),
      );
      expect(result.aadhaarFailureReason).toContain("QR code");
    });

    it("rejects when Cashfree flags the document itself as invalid/fraudulent", async () => {
      prisma.user.findUnique.mockResolvedValue({ id: "user-1" });
      cashfree.verifyAadhaar.mockResolvedValue({
        valid: false,
        reason: "Failed fraud checks: is_photo_of_screen",
      });
      prisma.user.update.mockResolvedValue({
        aadhaarVerificationStatus: "rejected",
        aadhaarFailureReason: "Failed fraud checks: is_photo_of_screen",
      });

      const result = await service.submitAadhaar("user-1", "https://example.com/a.jpg", buffer, "image/jpeg");

      expect(result.aadhaarFailureReason).toContain("fraud");
    });
  });

  describe("deleteMe", () => {
    it("releases this user's Instagram/YouTube connections, not just scrubbing the User row", async () => {
      await service.deleteMe("user-1");

      // A soft delete (the User row survives below with isActive:false)
      // never triggers the schema's onDelete:Cascade — without an explicit
      // cleanup here, a deleted user's platformUserId claim would stay
      // isConnected:true forever and block that same account from ever
      // reconnecting under a new signup.
      expect(prisma.instagramConnection.deleteMany).toHaveBeenCalledWith({ where: { userId: "user-1" } });
      expect(prisma.youtubeConnection.deleteMany).toHaveBeenCalledWith({ where: { userId: "user-1" } });
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "user-1" },
          data: expect.objectContaining({ isActive: false }),
        }),
      );
    });
  });
});
