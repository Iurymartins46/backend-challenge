import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { z } from 'zod';

import { MoneyDto } from '../../../common/http/money.dto';

export class CreateWalletDto {
  @ApiProperty({ format: 'uuid', example: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1' })
  playerId!: string;

  @ApiProperty({ type: () => MoneyDto, example: { amount: '1000.00', currency: 'BRL' } })
  initialBalance!: MoneyDto;
}

export class WalletResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  playerId!: string;

  @ApiProperty({ type: () => MoneyDto })
  balance!: MoneyDto;

  @ApiProperty({ example: 1, minimum: 1 })
  version!: number;
}

export class WalletLedgerEntryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  transactionId!: string;

  @ApiProperty({ enum: ['DEBIT', 'CREDIT'], example: 'CREDIT' })
  direction!: string;

  @ApiProperty({ type: () => MoneyDto })
  money!: MoneyDto;

  @ApiProperty({ type: () => MoneyDto })
  balanceBefore!: MoneyDto;

  @ApiProperty({ type: () => MoneyDto })
  balanceAfter!: MoneyDto;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class WalletLedgerResponseDto {
  @ApiProperty({ format: 'uuid' })
  walletId!: string;

  @ApiProperty({ type: () => [WalletLedgerEntryDto] })
  entries!: WalletLedgerEntryDto[];

  @ApiPropertyOptional({ nullable: true, example: null })
  nextCursor!: string | null;
}

export class WalletIdParamsDto {
  walletId!: string;
}

export class WalletLedgerQueryDto {
  @ApiPropertyOptional({ description: 'Opaque versioned Base64URL cursor.' })
  cursor?: string;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 100, type: 'integer' })
  limit?: number;
}

export const createWalletSchema = z.strictObject({
  playerId: z.string().uuid(),
  initialBalance: z.strictObject({
    amount: z.string(),
    currency: z.string(),
  }),
});

export const walletIdParamsSchema = z.strictObject({
  walletId: z.string().uuid(),
});

export const walletLedgerQuerySchema = z.strictObject({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
