import { DomainInvariantError } from '../../../modules/wagering/domain/errors';
import type { FailureCode } from '../../../modules/wagering/domain/errors';
import { Money } from '../../../modules/wagering/domain/money';
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from '../../../modules/wagering/domain/wager-transaction';
import { WagerTransactionEntity } from '../entities/wager-transaction.entity';

export class WagerTransactionMapper {
  static toPersistence(transaction: WagerTransaction): WagerTransactionEntity {
    const hasResultBalance = transaction.resultBalance !== undefined;
    const hasResultVersion = transaction.resultWalletVersion !== undefined;
    if (hasResultBalance !== hasResultVersion) {
      throw new DomainInvariantError('Transaction result snapshot is incomplete.');
    }

    const entity = new WagerTransactionEntity();
    entity.id = transaction.id;
    entity.providerId = transaction.providerId;
    entity.externalTransactionId = transaction.externalTransactionId;
    entity.idempotencyKey = transaction.idempotencyKey;
    entity.payloadHash = transaction.payloadHash;
    entity.walletId = transaction.walletId;
    entity.playerId = transaction.playerId;
    entity.roundId = transaction.roundId;
    entity.gameId = transaction.gameId;
    entity.kind = transaction.kind;
    entity.status = transaction.status;
    entity.amountMinor = transaction.money.toMinorUnits().toString();
    entity.currency = transaction.money.currency;
    entity.referenceExternalTransactionId = transaction.referenceExternalTransactionId ?? null;
    entity.referenceTransactionId = transaction.referenceTransactionId ?? null;
    entity.createdAt = new Date(transaction.createdAt.getTime());
    entity.failureCode = transaction.failureCode ?? null;
    entity.processedAt = transaction.processedAt ?? null;
    entity.resultBalanceMinor = transaction.resultBalance?.toMinorUnits().toString() ?? null;
    entity.resultWalletVersion = transaction.resultWalletVersion ?? null;
    entity.nextReferenceAttemptAt = transaction.nextReferenceAttemptAt ?? null;
    return entity;
  }

  static toDomain(entity: WagerTransactionEntity): WagerTransaction {
    const hasResultBalance = entity.resultBalanceMinor !== null;
    const hasResultVersion = entity.resultWalletVersion !== null;
    if (hasResultBalance !== hasResultVersion) {
      throw new DomainInvariantError('Transaction result snapshot is incomplete.');
    }

    const resultBalance = hasResultBalance
      ? Money.rehydrate({
          minorUnits: BigInt(entity.resultBalanceMinor as string),
          currency: entity.currency,
        })
      : undefined;

    return WagerTransaction.rehydrate({
      id: entity.id,
      providerId: entity.providerId,
      externalTransactionId: entity.externalTransactionId,
      idempotencyKey: entity.idempotencyKey,
      payloadHash: entity.payloadHash,
      walletId: entity.walletId,
      playerId: entity.playerId,
      roundId: entity.roundId,
      gameId: entity.gameId,
      kind: entity.kind as WagerTransactionKind,
      money: Money.rehydrate({
        minorUnits: BigInt(entity.amountMinor),
        currency: entity.currency,
      }),
      referenceExternalTransactionId: entity.referenceExternalTransactionId ?? undefined,
      createdAt: new Date(entity.createdAt.getTime()),
      status: entity.status as WagerTransactionStatus,
      referenceTransactionId: entity.referenceTransactionId ?? undefined,
      failureCode: (entity.failureCode as FailureCode | null) ?? undefined,
      processedAt: entity.processedAt === null ? undefined : new Date(entity.processedAt.getTime()),
      resultBalance,
      resultWalletVersion: entity.resultWalletVersion ?? undefined,
      nextReferenceAttemptAt:
        entity.nextReferenceAttemptAt === null
          ? undefined
          : new Date(entity.nextReferenceAttemptAt.getTime()),
    });
  }
}
