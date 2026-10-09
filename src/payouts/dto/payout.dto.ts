import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  Validate,
} from "class-validator";

const BANK_ACCOUNT_PATTERN = /^\d{6,20}$/;
const UPI_ID_PATTERN = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z0-9]{2,64}$/;

/** A bank account number is digits only; a UPI ID must look like name@bank.
 * Both used to be accepted as any 4+ character string. */
@ValidatorConstraint({ name: "payoutAccountForType", async: false })
class PayoutAccountForTypeConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    if (typeof value !== "string") return false;
    const type = (args.object as { type?: string }).type;
    const account = value.trim();
    if (type === "upi") return UPI_ID_PATTERN.test(account);
    if (type === "bank") return BANK_ACCOUNT_PATTERN.test(account);
    return true; // unknown type is rejected by the service
  }

  defaultMessage(args: ValidationArguments): string {
    const type = (args.object as { type?: string }).type;
    return type === "upi"
      ? "account must be a valid UPI ID (e.g. name@bank)"
      : "account must be a bank account number (6–20 digits)";
  }
}

export class CreatePayoutMethodDto {
  @ApiProperty({ enum: ["bank", "upi"] })
  @IsString()
  type!: string;

  @ApiProperty({ example: "HDFC Bank" })
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  label!: string;

  @ApiProperty({ example: "Ravi Kumar", description: "Name on the bank account or UPI-linked account" })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  accountHolderName!: string;

  @ApiProperty({ description: "Full account number or UPI id — stored server-side, shown masked to the creator" })
  @IsString()
  @MinLength(4)
  @MaxLength(64)
  @Validate(PayoutAccountForTypeConstraint)
  account!: string;

  @ApiPropertyOptional({ example: "HDFC0001234", description: "Required for bank accounts, ignored for UPI" })
  @ValidateIf((dto: CreatePayoutMethodDto) => dto.type === "bank")
  @IsString()
  @Matches(/^[A-Z]{4}0[A-Z0-9]{6}$/, {
    message: "ifscCode must be a valid IFSC code (e.g. HDFC0001234)",
  })
  ifscCode?: string;

  @ApiPropertyOptional({ example: "HDFC Bank" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  bankName?: string;

  @ApiProperty({ example: "ABCPV1234D", description: "Required for bank accounts — used for TDS/tax reporting on payouts" })
  @ValidateIf((dto: CreatePayoutMethodDto) => dto.type === "bank")
  @IsString()
  @Matches(/^[A-Z]{5}[0-9]{4}[A-Z]$/, {
    message: "panNumber must be a valid PAN (e.g. ABCPV1234D)",
  })
  panNumber?: string;
}

export class UpdatePayoutMethodDto {
  @ApiPropertyOptional({ example: "Ravi Kumar" })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  accountHolderName?: string;

  @ApiPropertyOptional({ example: "HDFC0001234" })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{4}0[A-Z0-9]{6}$/, {
    message: "ifscCode must be a valid IFSC code (e.g. HDFC0001234)",
  })
  ifscCode?: string;

  @ApiPropertyOptional({ example: "HDFC Bank" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  bankName?: string;

  @ApiPropertyOptional({ example: "HDFC Bank" })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  label?: string;

  @ApiPropertyOptional({ example: "ABCPV1234D" })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{5}[0-9]{4}[A-Z]$/, {
    message: "panNumber must be a valid PAN (e.g. ABCPV1234D)",
  })
  panNumber?: string;
}

export class CreateWithdrawalDto {
  @ApiProperty({
    description:
      "Amount in paise — must be one of the fixed denominations returned by GET /wallet (withdrawal.denominationsPaise)",
  })
  @IsInt()
  @Min(100)
  amountPaise!: number;

  @ApiProperty()
  @IsString()
  payoutMethodId!: string;

  @ApiPropertyOptional({ description: "Idempotency key to prevent duplicate withdrawals" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  idempotencyKey?: string;
}

export class PayoutMethodDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  type!: string;

  @ApiProperty()
  label!: string;

  @ApiProperty()
  accountHolderName!: string;

  @ApiProperty()
  accountMasked!: string;

  @ApiPropertyOptional()
  ifscCode?: string | null;

  @ApiPropertyOptional()
  bankName?: string | null;

  @ApiPropertyOptional()
  panNumber?: string | null;

  @ApiProperty()
  isDefault!: boolean;
}

export class RevealPayoutMethodDto {
  @ApiProperty({ description: "Full, decrypted account number or UPI id" })
  accountNumber!: string;
}

export class WithdrawalDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  amountPaise!: number;

  @ApiProperty()
  feePaise!: number;

  @ApiProperty()
  netPaise!: number;

  @ApiProperty({ enum: ["pending", "processing", "completed", "failed"] })
  status!: string;

  @ApiProperty()
  createdAt!: string;

  @ApiProperty({ nullable: true })
  processedAt!: string | null;

  @ApiProperty({ nullable: true, description: "Bank reference, once paid" })
  utr!: string | null;

  @ApiProperty({ nullable: true, description: "Why a failed withdrawal wasn't paid" })
  failureReason!: string | null;

  @ApiProperty({ nullable: true })
  payoutLabel!: string | null;

  @ApiProperty({ nullable: true })
  payoutMasked!: string | null;
}
