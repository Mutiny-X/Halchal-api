import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, MinLength } from "class-validator";

export class CampaignInviteAcceptDto {
  @ApiProperty()
  @IsString()
  @MinLength(10)
  token!: string;

  @ApiPropertyOptional({ description: "Required when creating a new brand account, and to confirm ownership when the invited email already has one" })
  @IsOptional()
  @IsString()
  @MinLength(8)
  password?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  displayName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  companyName?: string;
}
