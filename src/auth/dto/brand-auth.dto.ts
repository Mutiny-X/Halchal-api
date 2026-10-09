import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  Equals,
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from "class-validator";

import { IsAcceptablePassword, PASSWORD_MIN_LENGTH } from "../password-policy";

export class BrandRegisterDto {
  @ApiProperty({ example: "brand@company.in" })
  @IsEmail()
  email!: string;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;

  @ApiProperty({ example: "boAt Lifestyle" })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  companyName!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  displayName?: string;

  @ApiProperty({ example: true })
  @IsBoolean()
  @Equals(true, { message: "You must accept the Terms of Service" })
  acceptTerms!: boolean;
}

export class BrandLoginDto {
  @ApiProperty()
  @IsEmail()
  email!: string;

  @ApiProperty()
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;
}

export class BrandForgotPasswordDto {
  @ApiProperty()
  @IsEmail()
  email!: string;
}

export class BrandResetPasswordDto {
  @ApiProperty()
  @IsString()
  @MinLength(32)
  @MaxLength(128)
  token!: string;

  @ApiProperty({ minLength: PASSWORD_MIN_LENGTH })
  @IsString()
  @IsAcceptablePassword()
  password!: string;
}

export class RefreshTokenDto {
  @ApiProperty()
  @IsString()
  @MaxLength(256)
  refreshToken!: string;
}
