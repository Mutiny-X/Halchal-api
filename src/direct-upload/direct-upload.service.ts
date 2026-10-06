import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { UserRole } from "@prisma/client";
import { randomBytes } from "node:crypto";

import { CampaignAccessService } from "../access/campaign-access.service";
import { AdminRolesService } from "../admin-roles/admin-roles.service";
import {
  assertRemoteVideoIsPlayable,
  UnsupportedVideoFormatError,
  VideoProbeUnavailableError,
} from "../campaigns/video-compatibility";
import { detectFileType } from "../common/file-signature";
import { UserRateLimiter } from "../common/user-rate-limit";
import type { Env } from "../config/env";
import { ParticipationService } from "../participation/participation.service";
import { PrismaService } from "../prisma/prisma.service";
import { ObjectStorageService } from "../storage/object-storage.service";
import {
  CONTENT_TYPE_EXTENSION,
  DIRECT_UPLOAD_RULES,
  type DirectUploadPurpose,
  type DirectUploadRule,
} from "./direct-upload.purposes";
import { signTicket, verifyTicket, type UploadTicket } from "./upload-ticket";

/** How long the browser has to finish the PUT and call complete. */
const PUT_URL_TTL_SECONDS = 60 * 60;
const TICKET_TTL_MS = 2 * 60 * 60 * 1000;
const SNIFF_BYTES = 4096;

const presignLimiter = new UserRateLimiter(60, 60_000);
const completeLimiter = new UserRateLimiter(60, 60_000);

function invalid(message: string): BadRequestException {
  return new BadRequestException({ code: "VALIDATION_ERROR", message });
}

export type CompletedUpload = {
  url: string;
  path: string;
  name: string;
  type: "image" | "video";
  contentType: string;
};

@Injectable()
export class DirectUploadService {
  private readonly logger = new Logger(DirectUploadService.name);

  constructor(
    private readonly storage: ObjectStorageService,
    private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly campaignAccess: CampaignAccessService,
    private readonly adminRoles: AdminRolesService,
    private readonly participation: ParticipationService,
  ) {}

  private secret(): string {
    return this.config.get("JWT_SECRET", { infer: true });
  }

  /** Who may upload for this purpose — checked at presign AND at complete,
   * since access can change in between (e.g. staff unassigned). */
  private async authorize(
    rule: DirectUploadRule,
    userId: string,
    role: UserRole,
    deliverableId: string | undefined,
  ): Promise<void> {
    if (!rule.roles.includes(role)) {
      throw new ForbiddenException({ code: "FORBIDDEN", message: "You can't upload this kind of file" });
    }
    if (rule.adminSection) {
      const perms = await this.adminRoles.getEffectivePermissions(userId);
      if (!perms.isSuperAdmin && perms.sections[rule.adminSection] !== "manage") {
        throw new ForbiddenException({
          code: "FORBIDDEN",
          message: `Your role does not have manage access to ${rule.adminSection}`,
        });
      }
    }
    if (rule.needsDeliverable) {
      if (!deliverableId) throw invalid("deliverableId is required for this upload");
      const deliverable = await this.prisma.formatDeliverable.findUnique({
        where: { id: deliverableId },
        include: { participation: { include: { campaign: true } } },
      });
      if (!deliverable) {
        throw new NotFoundException({ code: "NOT_FOUND", message: "Deliverable not found" });
      }
      await this.campaignAccess.assertCanAccessCampaign(userId, role, deliverable.participation.campaign, {
        requireWrite: true,
      });
    }
  }

  async presign(
    userId: string,
    role: UserRole,
    input: {
      purpose: DirectUploadPurpose;
      contentType: string;
      size: number;
      fileName?: string;
      deliverableId?: string;
    },
  ) {
    presignLimiter.consume(userId);
    if (!this.storage.isR2Configured()) {
      // The website falls back to its local-dev upload route on this code.
      throw new ServiceUnavailableException({
        code: "DIRECT_UPLOAD_UNAVAILABLE",
        message: "Direct uploads aren't available on this server (object storage isn't configured)",
      });
    }
    const rule = DIRECT_UPLOAD_RULES[input.purpose];
    if (!rule.contentTypes.includes(input.contentType)) {
      throw invalid(`This file type isn't allowed here. Allowed: ${rule.contentTypes.join(", ")}`);
    }
    if (!Number.isInteger(input.size) || input.size < 1) throw invalid("File is empty");
    if (input.size > rule.maxBytes) {
      throw invalid(`File is too large — max is ${Math.round(rule.maxBytes / (1024 * 1024))} MB`);
    }
    await this.authorize(rule, userId, role, input.deliverableId);

    // The object name is chosen here, never from the browser's file name.
    const name = `${Date.now()}-${randomBytes(8).toString("hex")}${CONTENT_TYPE_EXTENSION[input.contentType]}`;
    const ticket: UploadTicket = {
      v: 1,
      pendingKey: `pending/${rule.folder}/${name}`,
      finalKey: `${rule.folder}/${name}`,
      purpose: input.purpose,
      userId,
      contentType: input.contentType,
      size: input.size,
      name: (input.fileName ?? "upload").slice(0, 200),
      deliverableId: input.deliverableId,
      expiresAt: Date.now() + TICKET_TTL_MS,
    };
    const uploadUrl = await this.storage.presignExactPut(
      ticket.pendingKey,
      ticket.contentType,
      ticket.size,
      PUT_URL_TTL_SECONDS,
    );
    return {
      uploadId: signTicket(ticket, this.secret()),
      uploadUrl,
      method: "PUT" as const,
      // Both are part of the signature: the PUT must send exactly these.
      headers: { "Content-Type": ticket.contentType },
      expiresAt: new Date(Date.now() + PUT_URL_TTL_SECONDS * 1000).toISOString(),
    };
  }

  async complete(userId: string, role: UserRole, uploadId: string) {
    completeLimiter.consume(userId);
    const ticket = verifyTicket(uploadId, this.secret());
    if (!ticket || ticket.userId !== userId) {
      throw invalid("This upload has expired or isn't yours — please upload the file again");
    }
    const rule = DIRECT_UPLOAD_RULES[ticket.purpose];
    if (!rule) throw invalid("Unknown upload");
    await this.authorize(rule, userId, role, ticket.deliverableId);

    const file = await this.verifyAndFinalize(ticket, rule);

    if (ticket.purpose === "avatar") {
      await this.prisma.user.update({ where: { id: userId }, data: { avatarUrl: file.url } });
    }
    if (ticket.purpose === "admin-draft-copy") {
      const result = await this.participation.setAdminDraftCopy(userId, role, ticket.deliverableId!, file.url);
      return { ...file, ...result };
    }
    return file;
  }

  /** Check the uploaded bytes really are what was declared, then move them
   * out of the pending area. Only verified files ever get a public URL. */
  private async verifyAndFinalize(ticket: UploadTicket, rule: DirectUploadRule): Promise<CompletedUpload> {
    const result = (): CompletedUpload => {
      const url = this.storage.publicUrlFor(ticket.finalKey);
      return {
        url,
        path: url,
        name: ticket.name,
        type: ticket.contentType.startsWith("video/") ? "video" : "image",
        contentType: ticket.contentType,
      };
    };

    const pending = await this.storage.headObject(ticket.pendingKey);
    if (!pending) {
      // Completing twice (retry after a dropped response) is fine.
      if (await this.storage.headObject(ticket.finalKey)) return result();
      throw invalid("The file hasn't finished uploading — please try again");
    }

    const reject = async (message: string): Promise<never> => {
      await this.storage.deleteObject(ticket.pendingKey).catch(() => undefined);
      throw invalid(message);
    };

    if (pending.size !== ticket.size) {
      await reject("Uploaded file size doesn't match — please upload the file again");
    }
    if ((pending.contentType ?? "").split(";")[0].trim() !== ticket.contentType) {
      await reject("Uploaded file type doesn't match — please upload the file again");
    }

    // The declared type is signed into the URL, but the bytes are whatever
    // the browser sent — read the first few KB and check what it really is.
    const head = await this.storage.readObjectHead(ticket.pendingKey, SNIFF_BYTES);
    const detected = detectFileType(head);
    const declaredKind = ticket.contentType.startsWith("video/") ? "video" : "image";
    if (!detected || detected.kind !== declaredKind) {
      await reject(`This file isn't a valid ${declaredKind === "video" ? "MP4, MOV or WebM video" : "image"}`);
    }
    if (declaredKind === "image" && !rule.contentTypes.includes(detected!.mimeType)) {
      await reject("This image format isn't allowed here");
    }

    if (declaredKind === "video" && rule.checkVideoPlayable) {
      try {
        await assertRemoteVideoIsPlayable(await this.storage.presignGet(ticket.pendingKey));
      } catch (error) {
        if (error instanceof UnsupportedVideoFormatError) await reject(error.message);
        if (error instanceof VideoProbeUnavailableError) {
          // A quality check, not a security one — don't block uploads when
          // ffprobe can't run in this environment; just say so in the logs.
          this.logger.warn(`Skipped playability check for ${ticket.pendingKey}: ${error.message}`);
        } else {
          throw error;
        }
      }
    }

    await this.storage.copyObject(ticket.pendingKey, ticket.finalKey);
    await this.storage.deleteObject(ticket.pendingKey).catch((error) =>
      this.logger.warn(`Couldn't delete ${ticket.pendingKey} after finalizing: ${error}`),
    );
    return result();
  }
}
