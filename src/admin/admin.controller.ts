import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { StaffAccessLevel, SupportTicketStatus, UserRole } from "@prisma/client";
import { IsBoolean, IsEmail, IsEnum, IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from "class-validator";
import type { Response } from "express";
import { memoryStorage } from "multer";

import { CampaignInviteService } from "../auth/campaign-invite.service";
import { AdminAuditInterceptor } from "../activity/admin-audit.interceptor";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { Roles } from "../common/decorators/roles.decorator";
import { RolesGuard } from "../common/guards/roles.guard";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import type { AuthJwtPayload } from "../auth/auth.types";
import { ListCampaignsQueryDto } from "../campaigns/dto/list-campaigns-query.dto";
import { BufferedUploadGuard } from "../direct-upload/buffered-upload.guard";
import { CampaignsService } from "../campaigns/campaigns.service";
import { InstagramAccountInsightsService } from "../creator-profiles/instagram-account-insights.service";
import { ObjectStorageService } from "../storage/object-storage.service";
import { AdminSectionRoute } from "../admin-roles/decorators/admin-section.decorator";
import { AdminSectionGuard } from "../admin-roles/guards/admin-section.guard";
import { MoneyAccessGuard } from "../admin-roles/guards/money-access.guard";
import { RequireMoneyAccess } from "../admin-roles/decorators/money-access.decorator";
import { SuperAdminOnlyGuard } from "../admin-roles/guards/super-admin-only.guard";
import {
  AssignAdminRoleDto,
  CreateAdminAccountDto,
  CreateAdminRoleDto,
  SetSectionPermissionsDto,
  UpdateAdminRoleDto,
} from "../admin-roles/dto/admin-role.dto";
import { CreateFaqDto, ReorderFaqsDto, UpdateFaqDto } from "../faqs/dto/faq.dto";
import { SendBulkNotificationDto } from "../notifications/dto/bulk-notification.dto";
import { RespondSupportTicketDto } from "../support/dto/support.dto";
import { AdminService } from "./admin.service";
import { CampaignReportService } from "./campaign-report.service";


class RejectCampaignDto {
  @IsString()
  @MinLength(5, { message: "Tell the brand what to change (at least 5 characters)" })
  @MaxLength(1000)
  reason!: string;
}

class SendCampaignInviteDto {
  @IsEmail()
  email!: string;
}

class SuspendCreatorDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

class ReviewKycDto {
  @IsEnum(["approve", "reject"])
  action!: "approve" | "reject";

  @IsOptional()
  @IsString()
  reason?: string;
}

class ReviewInstagramOnboardingDto {
  @IsEnum(["approve", "reject"])
  action!: "approve" | "reject";

  @IsOptional()
  @IsString()
  reason?: string;
}

class CreateBrandDto {
  @IsString()
  companyName!: string;

  @IsEmail()
  companyEmail!: string;

  @IsOptional()
  @IsString()
  pocName?: string;

  @IsOptional()
  @IsString()
  pocPhone?: string;

  @IsOptional()
  @IsEmail()
  pocEmail?: string;

  @IsOptional()
  @IsString()
  logoUrl?: string;
}

class UpdateBrandDto {
  @IsOptional()
  @IsString()
  companyName?: string;

  @IsOptional()
  @IsEmail()
  companyEmail?: string;

  @IsOptional()
  @IsString()
  pocName?: string;

  @IsOptional()
  @IsString()
  pocPhone?: string;

  @IsOptional()
  @IsEmail()
  pocEmail?: string;

  @IsOptional()
  @IsString()
  logoUrl?: string;
}

class CreateTeamMemberDto {
  @IsString()
  name!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;
}

class AssignBrandDto {
  @IsOptional()
  @IsEnum(StaffAccessLevel)
  accessLevel?: StaffAccessLevel;
}

class SetClipperIntakeDto {
  @IsInt()
  @Min(0)
  extraClipperAllowance!: number;
}

class SetPoolOverflowDto {
  @IsBoolean()
  allowExcessViewsToFillPool!: boolean;
}

@ApiTags("admin")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, AdminSectionGuard, MoneyAccessGuard)
@UseInterceptors(AdminAuditInterceptor)
@Roles(UserRole.admin)
@Controller("admin")
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly campaignInvites: CampaignInviteService,
    private readonly storage: ObjectStorageService,
    private readonly campaigns: CampaignsService,
    private readonly instagramInsights: InstagramAccountInsightsService,
    private readonly campaignReport: CampaignReportService,
  ) {}

  @Get("me/permissions")
  getMyPermissions(@CurrentUser() user: AuthJwtPayload) {
    return this.admin.getMyAdminPermissions(user.sub);
  }

  @Get("roles")
  @UseGuards(SuperAdminOnlyGuard)
  listAdminRoles() {
    return this.admin.listAdminRoles();
  }

  @Post("roles")
  @UseGuards(SuperAdminOnlyGuard)
  createAdminRole(@Body() body: CreateAdminRoleDto) {
    return this.admin.createAdminRole(body);
  }

  @Patch("roles/reset")
  @UseGuards(SuperAdminOnlyGuard)
  resetAdminRoles() {
    return this.admin.resetAdminRolesToDefaults();
  }

  @Patch("roles/:id")
  @UseGuards(SuperAdminOnlyGuard)
  updateAdminRole(@Param("id") id: string, @Body() body: UpdateAdminRoleDto) {
    return this.admin.updateAdminRole(id, body);
  }

  @Delete("roles/:id")
  @UseGuards(SuperAdminOnlyGuard)
  deleteAdminRole(@Param("id") id: string) {
    return this.admin.deleteAdminRole(id);
  }

  @Patch("roles/:id/permissions")
  @UseGuards(SuperAdminOnlyGuard)
  setAdminRolePermissions(@Param("id") id: string, @Body() body: SetSectionPermissionsDto) {
    return this.admin.setAdminRolePermissions(id, body.permissions);
  }

  @Get("admins")
  @UseGuards(SuperAdminOnlyGuard)
  listAdminAccounts() {
    return this.admin.listAdminAccounts();
  }

  @Post("admins")
  @UseGuards(SuperAdminOnlyGuard)
  createAdminAccount(@Body() body: CreateAdminAccountDto) {
    return this.admin.createAdminAccount(body);
  }

  @Patch("admins/:userId/role")
  @UseGuards(SuperAdminOnlyGuard)
  assignAdminRole(@Param("userId") userId: string, @Body() body: AssignAdminRoleDto) {
    return this.admin.assignAdminRole(userId, body.adminRoleId ?? null);
  }

  @Get("dashboard")
  @AdminSectionRoute("dashboard")
  getDashboard() {
    return this.admin.getDashboardStats();
  }

  @Get("brands")
  @AdminSectionRoute("brands")
  listBrands() {
    return this.admin.listBrands();
  }

  @Post("brands")
  @AdminSectionRoute("brands")
  createBrand(@Body() dto: CreateBrandDto) {
    return this.admin.createBrand(dto);
  }

  @Post("brand-logo")
  @UseGuards(BufferedUploadGuard)
  @AdminSectionRoute("brands")
  @UseInterceptors(
    FileInterceptor("file", {
      storage: memoryStorage(),
      limits: { fileSize: 5 * 1024 * 1024 },
    }),
  )
  async uploadBrandLogo(
    @Req() req: import("express").Request,
    @UploadedFile() file: Express.Multer.File,
  ) {
    const result = await this.storage.saveUploadedFile("brand-logos", {
      buffer: file.buffer,
      originalname: file.originalname,
      mimetype: file.mimetype,
    });
    const url = result.url.startsWith("http")
      ? result.url
      : `${req.protocol}://${req.get("host")}${result.url}`;
    return { url };
  }

  @Get("brands/:id")
  @AdminSectionRoute("brands")
  getBrand(@Param("id") id: string) {
    return this.admin.getBrand(id);
  }

  @Patch("brands/:id")
  @AdminSectionRoute("brands")
  updateBrand(@Param("id") id: string, @Body() dto: UpdateBrandDto) {
    return this.admin.updateBrand(id, dto);
  }

  @Delete("brands/:id")
  @AdminSectionRoute("brands")
  deleteBrand(@Param("id") id: string) {
    return this.admin.deleteBrand(id);
  }

  @Get("creators")
  @AdminSectionRoute("clippers")
  listCreators() {
    return this.admin.listCreators();
  }

  @Get("verifications")
  @AdminSectionRoute("clippers")
  listVerifications() {
    return this.admin.listVerifications();
  }

  @Get("creators/:id")
  @AdminSectionRoute("clippers")
  async getCreator(@Param("id") id: string) {
    const detail = await this.admin.getCreatorDetail(id);
    // Identity documents are kept private: show a link that works for ten
    // minutes, not a permanent one.
    return {
      ...detail,
      kycDocumentUrl: await this.storage.resolveDocumentUrl(detail.kycDocumentUrl),
      pan: { ...detail.pan, documentUrl: await this.storage.resolveDocumentUrl(detail.pan.documentUrl) },
      aadhaar: { ...detail.aadhaar, documentUrl: await this.storage.resolveDocumentUrl(detail.aadhaar.documentUrl) },
    };
  }

  @Post("creators/:id/suspend")
  @AdminSectionRoute("clippers")
  suspendCreator(
    @CurrentUser() user: AuthJwtPayload,
    @Param("id") id: string,
    @Body() body: SuspendCreatorDto,
  ) {
    return this.admin.suspendCreator(id, user.sub, body.reason);
  }

  @Post("creators/:id/reinstate")
  @AdminSectionRoute("clippers")
  reinstateCreator(@CurrentUser() user: AuthJwtPayload, @Param("id") id: string) {
    return this.admin.reinstateCreator(id, user.sub);
  }

  /** Everything Instagram's Insights API reports for one of the creator's
   * connected accounts. Cached for 6h; `?refresh=1` re-syncs (at most once
   * every 5 minutes per account). */
  @Get("creators/:id/instagram-insights/:connectionId")
  @AdminSectionRoute("clippers")
  getCreatorInstagramInsights(
    @Param("id") id: string,
    @Param("connectionId") connectionId: string,
    @Query("refresh") refresh?: string,
  ) {
    return this.instagramInsights.getReport(id, connectionId, { refresh: refresh === "1" || refresh === "true" });
  }

  @Post("creators/:id/kyc-review")
  @AdminSectionRoute("clippers")
  reviewKyc(@Param("id") id: string, @Body() body: ReviewKycDto) {
    return this.admin.reviewKyc(id, body.action, body.reason);
  }

  @Post("creators/:id/instagram-review")
  @AdminSectionRoute("clippers")
  reviewInstagramOnboarding(
    @CurrentUser() user: AuthJwtPayload,
    @Param("id") id: string,
    @Body() body: ReviewInstagramOnboardingDto,
  ) {
    return this.admin.reviewInstagramOnboarding(id, body.action, body.reason, user.sub);
  }

  @Get("payout-methods/:id/reveal")
  @AdminSectionRoute("clippers")
  @RequireMoneyAccess()
  revealPayoutMethodAccountNumber(@CurrentUser() user: AuthJwtPayload, @Param("id") id: string) {
    return this.admin.revealPayoutMethodAccountNumber(id, user.sub);
  }

  @Get("support-tickets")
  @AdminSectionRoute("tickets")
  listSupportTickets(@Query("status") status?: SupportTicketStatus) {
    return this.admin.listSupportTickets(status);
  }

  @Get("support-tickets/:id")
  @AdminSectionRoute("tickets")
  getSupportTicket(@Param("id") id: string) {
    return this.admin.getSupportTicket(id);
  }

  @Post("support-tickets/:id/respond")
  @AdminSectionRoute("tickets")
  respondToSupportTicket(@Param("id") id: string, @Body() body: RespondSupportTicketDto) {
    return this.admin.respondToSupportTicket(id, body.action, body.note);
  }

  @Get("bulk-notifications/channel-status")
  @AdminSectionRoute("notifications")
  bulkNotificationChannelStatus() {
    return this.admin.bulkNotificationChannelStatus();
  }

  @Post("bulk-notifications")
  @AdminSectionRoute("notifications")
  sendBulkNotification(
    @CurrentUser() user: AuthJwtPayload,
    @Body() body: SendBulkNotificationDto,
  ) {
    return this.admin.sendBulkNotification(user.sub, body);
  }

  @Get("bulk-notifications")
  @AdminSectionRoute("notifications")
  listBulkNotificationHistory(@Query("page") page?: string, @Query("limit") limit?: string) {
    return this.admin.listBulkNotificationHistory(
      page ? Number(page) : undefined,
      limit ? Number(limit) : undefined,
    );
  }

  @Get("faqs")
  @AdminSectionRoute("faqs")
  listFaqs() {
    return this.admin.listAllFaqs();
  }

  @Post("faqs")
  @AdminSectionRoute("faqs")
  createFaq(@Body() body: CreateFaqDto) {
    return this.admin.createFaq(body);
  }

  @Patch("faqs/reorder")
  @AdminSectionRoute("faqs")
  reorderFaqs(@Body() body: ReorderFaqsDto) {
    return this.admin.reorderFaqs(body.orderedIds);
  }

  @Patch("faqs/:id")
  @AdminSectionRoute("faqs")
  updateFaq(@Param("id") id: string, @Body() body: UpdateFaqDto) {
    return this.admin.updateFaq(id, body);
  }

  @Delete("faqs/:id")
  @AdminSectionRoute("faqs")
  deleteFaq(@Param("id") id: string) {
    return this.admin.deleteFaq(id);
  }

  @Get("campaigns")
  @AdminSectionRoute("campaigns")
  listCampaigns(@Query() query: ListCampaignsQueryDto) {
    return this.admin.listCampaigns(query);
  }

  /** Approve a brand/staff campaign that's waiting: it goes live now. */
  @Post("campaigns/:id/approve")
  @AdminSectionRoute("campaigns")
  approveCampaign(@CurrentUser() user: AuthJwtPayload, @Param("id") campaignId: string) {
    return this.campaigns.approve(user.sub, campaignId);
  }

  /** Send a waiting campaign back to the brand (as a draft) with a reason. */
  @Post("campaigns/:id/reject")
  @AdminSectionRoute("campaigns")
  rejectCampaign(
    @CurrentUser() user: AuthJwtPayload,
    @Param("id") campaignId: string,
    @Body() dto: RejectCampaignDto,
  ) {
    return this.campaigns.reject(user.sub, campaignId, dto.reason);
  }

  @Get("campaigns/:id/invites")
  @AdminSectionRoute("campaigns")
  listInvites(@Param("id") campaignId: string) {
    return this.campaignInvites.listInvites(campaignId);
  }

  @Post("campaigns/:id/invites")
  @AdminSectionRoute("campaigns")
  sendInvite(
    @CurrentUser() user: AuthJwtPayload,
    @Param("id") campaignId: string,
    @Body() dto: SendCampaignInviteDto,
  ) {
    return this.campaignInvites.sendInvite(user.sub, campaignId, dto.email);
  }

  @Delete("campaigns/:campaignId/invites/:inviteId")
  @AdminSectionRoute("campaigns")
  revokeInvite(
    @Param("campaignId") campaignId: string,
    @Param("inviteId") inviteId: string,
  ) {
    return this.campaignInvites.revokeInvite(campaignId, inviteId);
  }

  @Get("team-members")
  @AdminSectionRoute("team")
  listTeamMembers() {
    return this.admin.listTeamMembers();
  }

  @Post("team-members")
  @AdminSectionRoute("team")
  createTeamMember(@Body() dto: CreateTeamMemberDto) {
    return this.admin.createTeamMember(dto);
  }

  @Post("team-members/:staffId/brands/:brandId")
  @AdminSectionRoute("team")
  assignBrand(
    @Param("staffId") staffId: string,
    @Param("brandId") brandId: string,
    @Body() dto: AssignBrandDto,
  ) {
    return this.admin.assignBrandToStaff(staffId, brandId, dto.accessLevel);
  }

  @Delete("team-members/:staffId/brands/:brandId")
  @AdminSectionRoute("team")
  removeBrand(
    @Param("staffId") staffId: string,
    @Param("brandId") brandId: string,
  ) {
    return this.admin.removeBrandFromStaff(staffId, brandId);
  }

  @Post("team-members/:staffId/deactivate")
  @AdminSectionRoute("team")
  deactivateStaff(@Param("staffId") staffId: string) {
    return this.admin.deactivateStaff(staffId);
  }

  @Post("team-members/:staffId/reactivate")
  @AdminSectionRoute("team")
  reactivateStaff(@Param("staffId") staffId: string) {
    return this.admin.reactivateStaff(staffId);
  }

  @Delete("team-members/:staffId")
  @AdminSectionRoute("team")
  deleteStaff(@Param("staffId") staffId: string) {
    return this.admin.deleteStaff(staffId);
  }

  @Get("team-members/:staffId/activity")
  @AdminSectionRoute("team")
  getStaffActivity(@Param("staffId") staffId: string) {
    return this.admin.getStaffActivity(staffId);
  }

  @Get("campaigns/:id/payouts")
  @AdminSectionRoute("campaigns")
  getCampaignPayouts(@Param("id") campaignId: string) {
    return this.admin.getCampaignPayouts(campaignId);
  }

  @Post("campaigns/:id/payouts/all")
  @AdminSectionRoute("campaigns")
  @RequireMoneyAccess()
  payoutAllCreators(@Param("id") campaignId: string) {
    return this.admin.payoutCampaign(campaignId);
  }

  @Post("campaigns/:id/payouts/creator/:creatorId")
  @AdminSectionRoute("campaigns")
  @RequireMoneyAccess()
  payoutOneCreator(
    @Param("id") campaignId: string,
    @Param("creatorId") creatorId: string,
    @Query("creatorProfileId") creatorProfileId?: string,
  ) {
    return this.admin.payoutCampaign(campaignId, creatorId, creatorProfileId || undefined);
  }

  @Post("marketplace/listings/:id/delist")
  @AdminSectionRoute("campaigns")
  delistMarketplaceListing(@Param("id") deliverableId: string) {
    return this.admin.delistMarketplaceListing(deliverableId);
  }

  @Patch("campaigns/:id/clipper-intake")
  @AdminSectionRoute("campaigns")
  setClipperIntake(
    @Param("id") campaignId: string,
    @Body() dto: SetClipperIntakeDto,
  ) {
    return this.admin.setCampaignClipperIntake(campaignId, dto.extraClipperAllowance);
  }

  @Get("campaigns/:id/report")
  @AdminSectionRoute("campaigns")
  async generateCampaignReport(
    @CurrentUser() user: AuthJwtPayload,
    @Param("id") campaignId: string,
    @Res() res: Response,
  ) {
    const generatedByName = await this.admin.actorLabel(user.sub);
    const pdf = await this.campaignReport.generatePdf(campaignId, generatedByName);
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="campaign-report-${campaignId}.pdf"`,
    });
    res.send(pdf);
  }

  @Get("campaigns/:id/report/ledger")
  @AdminSectionRoute("campaigns")
  async generateCampaignLedger(
    @CurrentUser() user: AuthJwtPayload,
    @Param("id") campaignId: string,
    @Res() res: Response,
  ) {
    const generatedByName = await this.admin.actorLabel(user.sub);
    const csv = await this.campaignReport.generateLedgerCsv(campaignId, generatedByName);
    res.set({
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="campaign-ledger-${campaignId}.csv"`,
    });
    res.send(csv);
  }

  @Patch("campaigns/:id/pool-overflow")
  @AdminSectionRoute("campaigns")
  setPoolOverflow(
    @Param("id") campaignId: string,
    @Body() dto: SetPoolOverflowDto,
  ) {
    return this.admin.setCampaignPoolOverflow(campaignId, dto.allowExcessViewsToFillPool);
  }
}
