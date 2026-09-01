import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { z } from 'zod';

import { ErrorItemDto } from '../../../common/http/error.dto';
import { MoneyDto } from '../../../common/http/money.dto';
import { WagerTransactionKind, WagerTransactionStatus } from '../domain/wager-transaction';

const wagerKinds = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
] as const;

export class CreateWagerTransactionDto {
  @ApiProperty({ example: 'provider-a', maxLength: 255 })
  providerId!: string;

  @ApiProperty({ example: 'transaction-123', maxLength: 255 })
  externalTransactionId!: string;

  @ApiProperty({ format: 'uuid', example: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1' })
  playerId!: string;

  @ApiProperty({ format: 'uuid', example: '0192f291-27dd-7d3f-8071-5f8685deef37' })
  walletId!: string;

  @ApiProperty({ example: 'round-987', maxLength: 255 })
  roundId!: string;

  @ApiProperty({ example: 'fortune-chimp', maxLength: 255 })
  gameId!: string;

  @ApiProperty({ enum: wagerKinds, example: WagerTransactionKind.Bet })
  kind!: (typeof wagerKinds)[number];

  @ApiProperty({ type: () => MoneyDto, example: { amount: '25.00', currency: 'BRL' } })
  money!: MoneyDto;

  @ApiPropertyOptional({
    example: 'bet-transaction-123',
    description: 'Provider external id of the transaction being referenced or reversed.',
    maxLength: 255,
  })
  referenceExternalTransactionId?: string;
}

export class WagerTransactionSubmissionDto {
  @ApiProperty({ format: 'uuid' })
  transactionId!: string;

  @ApiProperty({ enum: WagerTransactionStatus, example: WagerTransactionStatus.Processed })
  status!: WagerTransactionStatus;

  @ApiPropertyOptional({ type: () => MoneyDto })
  balance?: MoneyDto;

  @ApiPropertyOptional({ minimum: 1, example: 2 })
  walletVersion?: number;

  @ApiProperty({ example: false })
  idempotentReplay!: boolean;
}

export class WagerTransactionRejectedResponseDto {
  @ApiProperty({ example: 422 })
  status!: number;

  @ApiProperty({ example: 'Transaction rejected' })
  title!: string;

  @ApiProperty({ example: 'The transaction could not be processed.' })
  detail!: string;

  @ApiProperty({ example: '4bf92f3577b34da6a3ce929d0e0e4736' })
  traceId!: string;

  @ApiProperty({ type: () => [ErrorItemDto], minItems: 1 })
  errors!: ErrorItemDto[];

  @ApiProperty({ format: 'uuid' })
  transactionId!: string;

  @ApiProperty({ example: false })
  idempotentReplay!: boolean;
}

export class WagerTransactionDetailsDto {
  @ApiProperty({ format: 'uuid' })
  transactionId!: string;

  @ApiProperty({ example: 'provider-a' })
  providerId!: string;

  @ApiProperty({ example: 'transaction-123' })
  externalTransactionId!: string;

  @ApiProperty({ example: 'provider-a:transaction-123' })
  idempotencyKey!: string;

  @ApiProperty({ format: 'uuid' })
  playerId!: string;

  @ApiProperty({ format: 'uuid' })
  walletId!: string;

  @ApiProperty({ example: 'round-987' })
  roundId!: string;

  @ApiProperty({ example: 'fortune-chimp' })
  gameId!: string;

  @ApiProperty({ enum: WagerTransactionKind })
  kind!: WagerTransactionKind;

  @ApiProperty({ enum: WagerTransactionStatus })
  status!: WagerTransactionStatus;

  @ApiProperty({ type: () => MoneyDto })
  money!: MoneyDto;

  @ApiPropertyOptional()
  referenceExternalTransactionId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  referenceTransactionId?: string;

  @ApiPropertyOptional({ example: 'error.wager.insufficient_funds' })
  failureCode?: string;

  @ApiPropertyOptional({ type: () => MoneyDto })
  balance?: MoneyDto;

  @ApiPropertyOptional({ minimum: 1 })
  walletVersion?: number;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiPropertyOptional({ format: 'date-time' })
  processedAt?: string;
}

export class WagerTransactionIdParamsDto {
  transactionId!: string;
}

export class ProviderTransactionParamsDto {
  providerId!: string;
  externalTransactionId!: string;
}

export const createWagerTransactionSchema = z.strictObject({
  providerId: z.string().min(1).max(255),
  externalTransactionId: z.string().min(1).max(255),
  playerId: z.string().uuid(),
  walletId: z.string().uuid(),
  roundId: z.string().min(1).max(255),
  gameId: z.string().min(1).max(255),
  kind: z.enum(wagerKinds),
  money: z.strictObject({
    amount: z.string(),
    currency: z.string(),
  }),
  referenceExternalTransactionId: z.string().min(1).max(255).optional(),
});

export const wagerTransactionIdParamsSchema = z.strictObject({
  transactionId: z.string().uuid(),
});

export const providerTransactionParamsSchema = z.strictObject({
  providerId: z.string().min(1).max(255),
  externalTransactionId: z.string().min(1).max(255),
});
