import type { Clock, IdGenerator } from '../domain';
import {
  DependencyUnavailableError,
  DomainError,
  DomainInvariantError,
  ExternalTransactionConflictError,
  IdempotencyPayloadConflictError,
  isBusinessFailureCode,
  Money,
  OutboxMessage,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WagerWalletContextMismatchError,
  WalletBalanceChanged,
  WalletLedgerEntry,
  WalletNotFoundError,
} from '../domain';
import { WagerRuleError } from '../domain/errors';
import type { FailureCode } from '../domain/errors';
import type { WalletBalanceChange } from '../domain/wallet';
import type { FinancialUnitOfWorkPort } from './ports';
import { hashWagerPayload } from './payload-hash';
import {
  toWagerTransactionSubmissionView,
  type HttpWagerTransactionKind,
  type ProcessWagerTransactionInput,
  type WagerTransactionSubmissionView,
} from './transaction.types';
import { ExponentialRetryPolicy } from '../domain/retry-policy';
import type { RetryPolicy } from '../domain/retry-policy';

export type Sleep = (delayMs: number) => Promise<void>;

const HTTP_WAGER_KINDS: readonly HttpWagerTransactionKind[] = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
];

export class ProcessWagerTransactionUseCase {
  constructor(
    private readonly unitOfWork: FinancialUnitOfWorkPort,
    private readonly idGenerator: IdGenerator,
    private readonly clock: Clock,
    private readonly retryPolicy: RetryPolicy = new ExponentialRetryPolicy({
      baseDelayMs: 25,
      maxDelayMs: 250,
      maxAttempts: 3,
    }),
    private readonly sleep: Sleep = delaySleep,
  ) {}

  async execute(input: ProcessWagerTransactionInput): Promise<WagerTransactionSubmissionView> {
    const payloadHash = hashWagerPayload(input);
    let attempt = 0;

    while (true) {
      try {
        return await this.executeAttempt(input, payloadHash);
      } catch (error: unknown) {
        if (!isTransientFinancialError(error)) {
          throw error;
        }

        attempt += 1;
        if (!this.retryPolicy.canRetry(attempt)) {
          throw new DependencyUnavailableError();
        }

        const now = this.clock.now();
        const nextAttemptAt = this.retryPolicy.nextAttemptAt(now, attempt);
        await this.sleep(nextAttemptAt.getTime() - now.getTime());
      }
    }
  }

  private async executeAttempt(
    input: ProcessWagerTransactionInput,
    payloadHash: string,
  ): Promise<WagerTransactionSubmissionView> {
    if (!HTTP_WAGER_KINDS.includes(input.kind)) {
      throw new DomainInvariantError('Only BET, WIN and LOSS can be submitted through this API.');
    }

    const money = Money.from(input.money);
    const correlationId = input.correlationId?.trim() || undefined;

    return this.unitOfWork.transaction(async (unitOfWork) => {
      const existingByKey = await unitOfWork.transactions.findByProviderAndIdempotencyKey(
        input.providerId,
        input.idempotencyKey,
      );
      if (existingByKey !== null) {
        return this.replayOrConflict(existingByKey, payloadHash);
      }

      const existingByExternal =
        await unitOfWork.transactions.findByProviderAndExternalTransactionId(
          input.providerId,
          input.externalTransactionId,
        );
      if (existingByExternal !== null) {
        throw new ExternalTransactionConflictError();
      }

      const wallet = await unitOfWork.wallets.findByIdForUpdate(input.walletId);
      if (wallet === null) {
        throw new WalletNotFoundError();
      }

      if (wallet.playerId !== input.playerId || wallet.currency !== money.currency) {
        throw new WagerWalletContextMismatchError();
      }

      // A request that raced while waiting for this wallet lock must arbitrate
      // against the committed row once more before changing the balance.
      const lockedExistingByKey = await unitOfWork.transactions.findByProviderAndIdempotencyKey(
        input.providerId,
        input.idempotencyKey,
      );
      if (lockedExistingByKey !== null) {
        return this.replayOrConflict(lockedExistingByKey, payloadHash);
      }

      const lockedExistingByExternal =
        await unitOfWork.transactions.findByProviderAndExternalTransactionId(
          input.providerId,
          input.externalTransactionId,
        );
      if (lockedExistingByExternal !== null) {
        throw new ExternalTransactionConflictError();
      }

      const transaction = WagerTransaction.create({
        id: this.idGenerator.next(),
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
        idempotencyKey: input.idempotencyKey,
        payloadHash,
        walletId: input.walletId,
        playerId: input.playerId,
        roundId: input.roundId,
        gameId: input.gameId,
        kind: input.kind,
        money,
        createdAt: this.clock.now(),
      });

      const inserted = await this.insertIfAbsent(unitOfWork, transaction);
      if (!inserted) {
        const concurrentByKey = await unitOfWork.transactions.findByProviderAndIdempotencyKey(
          input.providerId,
          input.idempotencyKey,
        );
        if (concurrentByKey !== null) {
          return this.replayOrConflict(concurrentByKey, payloadHash);
        }

        const concurrentByExternal =
          await unitOfWork.transactions.findByProviderAndExternalTransactionId(
            input.providerId,
            input.externalTransactionId,
          );
        if (concurrentByExternal !== null) {
          throw new ExternalTransactionConflictError();
        }

        throw new DomainInvariantError('A wager transaction conflict was not recoverable.');
      }

      let balanceChange: WalletBalanceChange | undefined;
      try {
        if (input.kind === WagerTransactionKind.Bet) {
          balanceChange = wallet.debit(money, transaction.createdAt);
        } else if (input.kind === WagerTransactionKind.Win) {
          balanceChange = wallet.credit(money, transaction.createdAt);
        }
      } catch (error: unknown) {
        if (
          !(error instanceof WagerRuleError) ||
          !isBusinessFailureCode(error.code as FailureCode)
        ) {
          throw error;
        }

        const failureCode = error.code as FailureCode;
        transaction.reject(failureCode);
        await unitOfWork.transactions.save(transaction);
        await unitOfWork.outbox.insert(
          OutboxMessage.enqueue(
            WagerTransactionRejected.from(transaction, {
              correlationId: correlationId ?? transaction.id,
              causationId: input.causationId,
              occurredAt: transaction.createdAt,
            }),
          ),
        );

        return toWagerTransactionSubmissionView(transaction, false);
      }

      if (balanceChange !== undefined) {
        await unitOfWork.wallets.save(wallet);

        const ledgerEntry = WalletLedgerEntry.create({
          id: this.idGenerator.next(),
          walletId: wallet.id,
          transactionId: transaction.id,
          direction: balanceChange.direction,
          money: balanceChange.money,
          balanceBefore: balanceChange.balanceBefore,
          balanceAfter: balanceChange.balanceAfter,
          createdAt: balanceChange.occurredAt,
        });
        await unitOfWork.ledger.insert(ledgerEntry);

        transaction.markProcessed(undefined, balanceChange.occurredAt);
        transaction.recordResultSnapshot(wallet.balance, wallet.version);
        await unitOfWork.transactions.save(transaction);
        await unitOfWork.outbox.insert(
          OutboxMessage.enqueue(
            WagerTransactionProcessed.from(transaction, {
              correlationId: correlationId ?? transaction.id,
              causationId: input.causationId,
              occurredAt: balanceChange.occurredAt,
            }),
          ),
        );
        await unitOfWork.outbox.insert(
          OutboxMessage.enqueue(
            WalletBalanceChanged.from(wallet, ledgerEntry, {
              correlationId: correlationId ?? transaction.id,
              causationId: transaction.id,
              occurredAt: balanceChange.occurredAt,
            }),
          ),
        );
      } else {
        transaction.markProcessed(undefined, transaction.createdAt);
        transaction.recordResultSnapshot(wallet.balance, wallet.version);
        await unitOfWork.transactions.save(transaction);
        await unitOfWork.outbox.insert(
          OutboxMessage.enqueue(
            WagerTransactionProcessed.from(transaction, {
              correlationId: correlationId ?? transaction.id,
              causationId: input.causationId,
              occurredAt: transaction.createdAt,
            }),
          ),
        );
      }

      return toWagerTransactionSubmissionView(transaction, false);
    });
  }

  private async insertIfAbsent(
    unitOfWork: FinancialUnitOfWorkPort,
    transaction: WagerTransaction,
  ): Promise<boolean> {
    if (unitOfWork.transactions.insertIfAbsent !== undefined) {
      return unitOfWork.transactions.insertIfAbsent(transaction);
    }

    await unitOfWork.transactions.insert(transaction);
    return true;
  }

  private replayOrConflict(
    transaction: WagerTransaction,
    payloadHash: string,
  ): WagerTransactionSubmissionView {
    if (!transaction.matchesPayload(payloadHash)) {
      throw new IdempotencyPayloadConflictError();
    }

    return toWagerTransactionSubmissionView(transaction, true);
  }
}

function delaySleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

export function isTransientFinancialError(error: unknown): boolean {
  if (error instanceof DomainError || typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as {
    code?: unknown;
    errno?: unknown;
    driverError?: { code?: unknown; errno?: unknown };
  };
  const codes = [
    candidate.code,
    candidate.errno,
    candidate.driverError?.code,
    candidate.driverError?.errno,
  ]
    .filter((code): code is string | number => typeof code === 'string' || typeof code === 'number')
    .map(String);
  const transientCodes = new Set([
    '40001',
    '40P01',
    '55P03',
    '57014',
    '57P01',
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
  ]);

  return codes.some((code) => transientCodes.has(code));
}
