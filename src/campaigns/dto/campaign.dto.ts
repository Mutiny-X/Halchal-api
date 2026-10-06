import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { CampaignStatus, CampaignWizardStep, SourceAssetRequirement } from "@prisma/client";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";

import { CAMPAIGN_PLATFORM_IDS } from "../campaign-platforms";
import { CAMPAIGN_LOCATION_TYPES, INDIA_STATES } from "../india-states";

/** ₹2 crore in paise — keeps money fields well inside the Postgres Int
 * column (max 2,147,483,647) so an oversized value is a clean 400, not a 500. */
export const MAX_MONEY_PAISE = 2_000_000_000;

export class SourceAssetDto {
  @ApiProperty({ enum: ["drive", "youtube", "upload"] })
  @IsString()
  @IsIn(["drive", "youtube", "upload"])
  type!: "drive" | "youtube" | "upload";

  @ApiProperty({ description: "Google Drive/YouTube URL, or a public URL from a device upload" })
  @IsString()
  @MinLength(1)
  @MaxLength(2048)
  url!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;
}

export class ReferenceAssetDto {
  @ApiProperty({ enum: ["image", "video"] })
  @IsString()
  @IsIn(["image", "video"])
  type!: "image" | "video";

  @ApiProperty({ description: "Public URL or /uploads/... path from API upload" })
  @IsString()
  @MinLength(1)
  @MaxLength(2048)
  url!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;
}

export class CheckSourceAssetUrlDto {
  @ApiProperty({ description: "Google Drive/YouTube URL, or a public URL, to test for auto-review fetchability" })
  @IsString()
  @IsUrl()
  @MaxLength(2048)
  url!: string;
}

export class PresignUploadDto {
  @ApiProperty({ description: "Original filename, used to derive the stored file's extension" })
  @IsString()
  @MaxLength(255)
  fileName!: string;

  @ApiProperty({ description: "Declared MIME type — must be image/* or video/*" })
  @IsString()
  @MaxLength(100)
  contentType!: string;
}

export class CreateCampaignDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  brandProfileId?: string;

  @ApiPropertyOptional({ enum: CampaignWizardStep })
  @IsOptional()
  @IsEnum(CampaignWizardStep)
  wizardStep?: CampaignWizardStep;

  @ApiPropertyOptional({ enum: CampaignStatus, default: CampaignStatus.draft })
  @IsOptional()
  @IsEnum(CampaignStatus)
  status?: CampaignStatus;

  // Empty allowed here on purpose — the wizard creates this row the moment
  // "Create campaign" is clicked, before the admin has typed a real name.
  // No MinLength(1): forcing a placeholder like "New Campaign" in to satisfy
  // this validator is exactly what let untouched campaigns keep that name
  // forever. The Basics step's own Next-button gate (not this DTO) is what
  // actually requires a real title before the wizard can proceed.
  @ApiProperty()
  @IsString()
  @MaxLength(120)
  title!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  category?: string;

  @ApiPropertyOptional({ default: "instagram_reel" })
  @IsOptional()
  @IsString()
  @IsIn([...CAMPAIGN_PLATFORM_IDS, "instagram_reels"])
  platform?: string;

  @ApiPropertyOptional({ type: [String], maxItems: 1, description: "Exactly one target platform" })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1)
  @IsString({ each: true })
  @IsIn([...CAMPAIGN_PLATFORM_IDS, "instagram_reels"], { each: true })
  platforms?: string[];

  @ApiPropertyOptional({ enum: CAMPAIGN_LOCATION_TYPES, default: "pan_india" })
  @IsOptional()
  @IsIn(CAMPAIGN_LOCATION_TYPES)
  locationType?: "pan_india" | "states";

  @ApiPropertyOptional({ type: [String], enum: INDIA_STATES, description: "Indian states/UTs to target when locationType is 'states'" })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(INDIA_STATES.length)
  @IsString({ each: true })
  @IsIn(INDIA_STATES, { each: true })
  targetStates?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  briefHook?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  doRules?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  avoidRules?: string;

  @ApiPropertyOptional({ type: [SourceAssetDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => SourceAssetDto)
  sourceAssets?: SourceAssetDto[];

  @ApiPropertyOptional({ enum: SourceAssetRequirement, default: SourceAssetRequirement.mandatory, description: "Whether clippers must reuse the source footage" })
  @IsOptional()
  @IsEnum(SourceAssetRequirement)
  sourceVideoRequirement?: SourceAssetRequirement;

  @ApiPropertyOptional({ enum: SourceAssetRequirement, default: SourceAssetRequirement.not_required, description: "Whether clippers must use the source audio/song" })
  @IsOptional()
  @IsEnum(SourceAssetRequirement)
  sourceAudioRequirement?: SourceAssetRequirement;

  @ApiPropertyOptional({ default: true, description: "Whether the automated review pipeline runs for this campaign's submissions" })
  @IsOptional()
  @IsBoolean()
  autoReviewEnabled?: boolean;

  @ApiPropertyOptional({ type: [ReferenceAssetDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ReferenceAssetDto)
  referenceAssets?: ReferenceAssetDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(10000)
  brief?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl()
  productUrl?: string;

  @ApiPropertyOptional({ description: "Cover image URL from POST /campaigns/cover/upload" })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  coverImageUrl?: string;

  @ApiPropertyOptional({ description: "₹ per 1K views in paise (5000 = ₹50)" })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_MONEY_PAISE, { message: "Amount is too large (max ₹2 crore)" })
  ratePer1kPaise?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(MAX_MONEY_PAISE, { message: "Amount is too large (max ₹2 crore)" })
  maxPayoutPaise?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(MAX_MONEY_PAISE, { message: "Amount is too large (max ₹2 crore)" })
  budgetPaise?: number;
}

export class UpdateCampaignDto {
  @ApiPropertyOptional({ description: "Admin-only: assign or reassign the owning brand" })
  @IsOptional()
  @IsString()
  brandProfileId?: string;

  @ApiPropertyOptional({ enum: CampaignWizardStep })
  @IsOptional()
  @IsEnum(CampaignWizardStep)
  wizardStep?: CampaignWizardStep;

  @ApiPropertyOptional({ enum: CampaignStatus })
  @IsOptional()
  @IsEnum(CampaignStatus)
  status?: CampaignStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  brief?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  briefHook?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  doRules?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  avoidRules?: string;

  @ApiPropertyOptional({ type: [SourceAssetDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => SourceAssetDto)
  sourceAssets?: SourceAssetDto[];

  @ApiPropertyOptional({ enum: SourceAssetRequirement, description: "Whether clippers must reuse the source footage" })
  @IsOptional()
  @IsEnum(SourceAssetRequirement)
  sourceVideoRequirement?: SourceAssetRequirement;

  @ApiPropertyOptional({ enum: SourceAssetRequirement, description: "Whether clippers must use the source audio/song" })
  @IsOptional()
  @IsEnum(SourceAssetRequirement)
  sourceAudioRequirement?: SourceAssetRequirement;

  @ApiPropertyOptional({ description: "Whether the automated review pipeline runs for this campaign's submissions" })
  @IsOptional()
  @IsBoolean()
  autoReviewEnabled?: boolean;

  @ApiPropertyOptional({ type: [ReferenceAssetDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ReferenceAssetDto)
  referenceAssets?: ReferenceAssetDto[];

  @ApiPropertyOptional({ type: [String], maxItems: 1, description: "Exactly one target platform" })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1)
  @IsString({ each: true })
  @IsIn([...CAMPAIGN_PLATFORM_IDS, "instagram_reels"], { each: true })
  platforms?: string[];

  @ApiPropertyOptional({ enum: CAMPAIGN_LOCATION_TYPES })
  @IsOptional()
  @IsIn(CAMPAIGN_LOCATION_TYPES)
  locationType?: "pan_india" | "states";

  @ApiPropertyOptional({ type: [String], enum: INDIA_STATES, description: "Indian states/UTs to target when locationType is 'states'" })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(INDIA_STATES.length)
  @IsString({ each: true })
  @IsIn(INDIA_STATES, { each: true })
  targetStates?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  category?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl()
  productUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  coverImageUrl?: string;

  @ApiPropertyOptional({ description: "₹ per 1K views in paise" })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_MONEY_PAISE, { message: "Amount is too large (max ₹2 crore)" })
  ratePer1kPaise?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(MAX_MONEY_PAISE, { message: "Amount is too large (max ₹2 crore)" })
  maxPayoutPaise?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(MAX_MONEY_PAISE, { message: "Amount is too large (max ₹2 crore)" })
  budgetPaise?: number;
}

/** Lightweight wizard step save — wizardStep required, other fields optional. */
export class UpdateCampaignStepDto extends UpdateCampaignDto {
  @ApiProperty({ enum: CampaignWizardStep })
  @IsEnum(CampaignWizardStep)
  declare wizardStep: CampaignWizardStep;
}
