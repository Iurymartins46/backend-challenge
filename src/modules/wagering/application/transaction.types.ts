import { DomainInvariantError } from '../domain/errors';
import type { FailureCode } from '../domain/errors';
import type { MoneyProps } from '../domain/money';
import type {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wager-transaction';

export type HttpWagerTransactionKind =
  | WagerTransactionKind.Bet
  | WagerTransactionKind.Win
  | WagerTransactionKind.Loss
  | WagerTransactionKind.Refund
  | WagerTransactionKind.Rollback;

export interface ProcessWagerTransactionInput {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: HttpWagerTransactionKind;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId?: string;
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly inbox?: WagerInboxContext;
  /** Internal worker signal: reject atomically if the reference is still absent. */
  readonly expirePendingReference?: boolean;
}

export interface WagerInboxContext {
  readonly consumerName: string;
  /** Application message id from the envelope, never the SQS transport MessageId. */
  readonly messageId: string;
  /** Hash of the accepted command data, including the idempotency key. */
  readonly payloadHash?: string;
  readonly receivedAt: Date;
}

export interface WagerTransactionSubmissionView {
  readonly transactionId: string;
  readonly status: WagerTransactionStatus;
  readonly balance?: MoneyProps;
  readonly walletVersion?: number;
  readonly failureCode?: FailureCode;
  readonly idempotentReplay: boolean;
}

export interface WagerTransactionView {
  readonly transactionId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly status: WagerTransactionStatus;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId?: string;
  readonly referenceTransactionId?: string;
  readonly failureCode?: FailureCode;
  readonly balance?: MoneyProps;
  readonly walletVersion?: number;
  readonly createdAt: string;
  readonly processedAt?: string;
}

export function toWagerTransactionSubmissionView(
  transaction: WagerTransaction,
  idempotentReplay: boolean,
): WagerTransactionSubmissionView {
  const hasBalance = transaction.resultBalance !== undefined;
  const hasVersion = transaction.resultWalletVersion !== undefined;
  if (hasBalance !== hasVersion) {
    throw new DomainInvariantError('Transaction result snapshot is incomplete.');
  }

  return {
    transactionId: transaction.id,
    status: transaction.status,
    ...(hasBalance && hasVersion
      ? {
          balance: transaction.resultBalance?.toJSON(),
          walletVersion: transaction.resultWalletVersion,
        }
      : {}),
    ...(transaction.failureCode === undefined ? {} : { failureCode: transaction.failureCode }),
    idempotentReplay,
  };
}

export function toWagerTransactionView(transaction: WagerTransaction): WagerTransactionView {
  const submission = toWagerTransactionSubmissionView(transaction, false);
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    idempotencyKey: transaction.idempotencyKey,
    playerId: transaction.playerId,
    walletId: transaction.walletId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    status: transaction.status,
    money: transaction.money.toJSON(),
    ...(transaction.referenceExternalTransactionId === undefined
      ? {}
      : { referenceExternalTransactionId: transaction.referenceExternalTransactionId }),
    ...(transaction.referenceTransactionId === undefined
      ? {}
      : { referenceTransactionId: transaction.referenceTransactionId }),
    ...(transaction.failureCode === undefined ? {} : { failureCode: transaction.failureCode }),
    ...(submission.balance === undefined ? {} : { balance: submission.balance }),
    ...(submission.walletVersion === undefined ? {} : { walletVersion: submission.walletVersion }),
    createdAt: transaction.createdAt.toISOString(),
    ...(transaction.processedAt === undefined
      ? {}
      : { processedAt: transaction.processedAt.toISOString() }),
  };
}
