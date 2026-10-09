import { ApiProperty } from "@nestjs/swagger";

export class WithdrawalRulesDto {
  @ApiProperty({ description: "Lifetime earnings have reached the unlock threshold" })
  unlocked!: boolean;

  @ApiProperty({ description: "Lifetime earnings needed to unlock withdrawals, in paise" })
  lifetimeGatePaise!: number;

  @ApiProperty({ description: "How much more the creator must earn to unlock, in paise (0 when unlocked)" })
  remainingToUnlockPaise!: number;

  @ApiProperty({ type: [Number], description: "The only amounts that can be withdrawn, in paise" })
  denominationsPaise!: number[];

  @ApiProperty({ description: "Withdrawal fee in basis points" })
  feeBps!: number;

  @ApiProperty({ description: "A previous withdrawal is still pending or being paid" })
  hasOpenWithdrawal!: boolean;

  @ApiProperty({ description: "A withdrawal was already requested today (IST)" })
  requestedToday!: boolean;

  @ApiProperty({ nullable: true, description: "When the daily limit resets (ISO), if it applies" })
  nextRequestAt!: string | null;

  @ApiProperty({ description: "Days a creator is told payment can take" })
  expectedDays!: number;
}

export class WalletDto {
  @ApiProperty({ description: "Available balance in paise" })
  availablePaise!: number;

  @ApiProperty()
  pendingPaise!: number;

  @ApiProperty()
  lifetimePaise!: number;

  @ApiProperty()
  clipsUnderReview!: number;

  @ApiProperty({ type: WithdrawalRulesDto })
  withdrawal!: WithdrawalRulesDto;
}

export class TransactionDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  type!: string;

  @ApiProperty()
  amountPaise!: number;

  @ApiProperty({ nullable: true })
  note!: string | null;

  @ApiProperty()
  createdAt!: string;
}
