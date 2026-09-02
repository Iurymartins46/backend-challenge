import type { Clock, IdGenerator } from '../domain';
import {
  DependencyUnavailableError,
  DomainError,
  DomainInvariantError,
  ExternalTransactionConflictError,
  InboxMessage,
  InboxPayloadConflictError,
  IdempotencyPayloadConflictError,
  isBusinessFailureCode,
  LedgerDirection,
  Money,
  OutboxMessage,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WagerTransactionStatus,
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
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
];

const REFERENCE_INITIAL_DELAY_MS = 2_000;

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
      throw new DomainInvariantError(
        'Only BET, WIN, LOSS, REFUND and ROLLBACK can be submitted through this API.',
      );
    }

    const money = Money.from(input.money);
    const correlationId = input.correlationId?.trim() || undefined;

    return this.unitOfWork.transaction(async (unitOfWork) => {
      const inboxMessage = await this.receiveInboxMessage(unitOfWork, input, payloadHash);
      let pendingTransaction: WagerTransaction | undefined;
      let idempotentReplay = false;

      const existingByKey = await unitOfWork.transactions.findByProviderAndIdempotencyKey(
        input.providerId,
        input.idempotencyKey,
      );
      if (existingByKey !== null) {
        if (!existingByKey.matchesPayload(payloadHash)) {
          throw new IdempotencyPayloadConflictError();
        }

        if (existingByKey.status !== WagerTransactionStatus.PendingReference) {
          return this.completeInbox(
            unitOfWork,
            inboxMessage,
            toWagerTransactionSubmissionView(existingByKey, true),
          );
        }

        pendingTransaction = existingByKey;
        idempotentReplay = true;
      }

      const existingByExternal =
        await unitOfWork.transactions.findByProviderAndExternalTransactionId(
          input.providerId,
          input.externalTransactionId,
        );
      if (existingByExternal !== null) {
        if (existingByExternal.idempotencyKey !== input.idempotencyKey) {
          throw new ExternalTransactionConflictError();
        }

        if (!existingByExternal.matchesPayload(payloadHash)) {
          throw new IdempotencyPayloadConflictError();
        }

        if (existingByExternal.status !== WagerTransactionStatus.PendingReference) {
          return this.completeInbox(
            unitOfWork,
            inboxMessage,
            toWagerTransactionSubmissionView(existingByExternal, true),
          );
        }

        pendingTransaction = existingByExternal;
        idempotentReplay = true;
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
        if (!lockedExistingByKey.matchesPayload(payloadHash)) {
          throw new IdempotencyPayloadConflictError();
        }

        if (lockedExistingByKey.status !== WagerTransactionStatus.PendingReference) {
          return this.completeInbox(
            unitOfWork,
            inboxMessage,
            toWagerTransactionSubmissionView(lockedExistingByKey, true),
          );
        }

        pendingTransaction = lockedExistingByKey;
        idempotentReplay = true;
      }

      const lockedExistingByExternal =
        await unitOfWork.transactions.findByProviderAndExternalTransactionId(
          input.providerId,
          input.externalTransactionId,
        );
      if (lockedExistingByExternal !== null) {
        if (lockedExistingByExternal.idempotencyKey !== input.idempotencyKey) {
          throw new ExternalTransactionConflictError();
        }

        if (!lockedExistingByExternal.matchesPayload(payloadHash)) {
          throw new IdempotencyPayloadConflictError();
        }

        if (lockedExistingByExternal.status !== WagerTransactionStatus.PendingReference) {
          return this.completeInbox(
            unitOfWork,
            inboxMessage,
            toWagerTransactionSubmissionView(lockedExistingByExternal, true),
          );
        }

        pendingTransaction = lockedExistingByExternal;
        idempotentReplay = true;
      }

      let transaction = pendingTransaction;
      if (transaction === undefined) {
        transaction = WagerTransaction.create({
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
          referenceExternalTransactionId: input.referenceExternalTransactionId,
          createdAt: this.clock.now(),
        });

        const inserted = await this.insertIfAbsent(unitOfWork, transaction);
        if (!inserted) {
          const concurrentByKey = await unitOfWork.transactions.findByProviderAndIdempotencyKey(
            input.providerId,
            input.idempotencyKey,
          );
          if (concurrentByKey !== null) {
            return this.completeInbox(
              unitOfWork,
              inboxMessage,
              this.replayOrConflict(concurrentByKey, payloadHash),
            );
          }

          const concurrentByExternal =
            await unitOfWork.transactions.findByProviderAndExternalTransactionId(
              input.providerId,
              input.externalTransactionId,
            );
          if (concurrentByExternal !== null) {
            return this.completeInbox(
              unitOfWork,
              inboxMessage,
              this.replayByExternalIdOrConflict(
                concurrentByExternal,
                input.idempotencyKey,
                payloadHash,
              ),
            );
          }

          throw new DomainInvariantError('A wager transaction conflict was not recoverable.');
        }
      }

      try {
        let reference: WagerTransaction | undefined;
        if (transaction.canWaitForReference()) {
          const referenceExternalTransactionId = transaction.referenceExternalTransactionId;
          if (referenceExternalTransactionId === undefined) {
            throw new DomainInvariantError('A reference-dependent transaction lacks a reference.');
          }

          reference =
            (await unitOfWork.transactions.findByProviderAndExternalTransactionId(
              transaction.providerId,
              referenceExternalTransactionId,
            )) ?? undefined;

          if (reference === undefined) {
            if (transaction.status !== WagerTransactionStatus.PendingReference) {
              transaction.markPendingReference(
                new Date(transaction.createdAt.getTime() + REFERENCE_INITIAL_DELAY_MS),
              );
              await unitOfWork.transactions.save(transaction);
              await unitOfWork.outbox.insert(
                OutboxMessage.enqueue(
                  WagerTransactionPendingReference.from(transaction, {
                    correlationId: correlationId ?? transaction.id,
                    causationId: input.causationId,
                    eventId: this.idGenerator.next(),
                    occurredAt: transaction.createdAt,
                  }),
                ),
              );
            }

            return this.completeInbox(
              unitOfWork,
              inboxMessage,
              toWagerTransactionSubmissionView(transaction, idempotentReplay),
            );
          }

          transaction.assertReferenceCompatible(reference);
          if (isReversalKind(transaction.kind)) {
            const existingReversal = await unitOfWork.transactions.findProcessedReversal(
              reference.id,
              transaction.kind,
            );
            if (existingReversal !== null) {
              transaction.assertNoProcessedReversal([existingReversal]);
            }
          }
        }

        let balanceChange: WalletBalanceChange | undefined;
        if (transaction.kind === WagerTransactionKind.Bet) {
          balanceChange = wallet.debit(transaction.money, transaction.createdAt);
        } else if (transaction.kind === WagerTransactionKind.Win) {
          balanceChange = wallet.credit(transaction.money, transaction.createdAt);
        } else if (transaction.kind === WagerTransactionKind.Refund) {
          balanceChange = wallet.credit(transaction.money, transaction.createdAt);
        } else if (transaction.kind === WagerTransactionKind.Rollback) {
          const direction = transaction.ledgerDirectionFor(reference);
          balanceChange =
            direction === LedgerDirection.Debit
              ? wallet.debitForReversal(transaction.money, transaction.createdAt)
              : wallet.credit(transaction.money, transaction.createdAt);
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

          transaction.markProcessed(reference?.id, balanceChange.occurredAt);
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
          transaction.markProcessed(reference?.id, transaction.createdAt);
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
      } catch (error: unknown) {
        if (
          !(error instanceof WagerRuleError) ||
          !isBusinessFailureCode(error.code as FailureCode)
        ) {
          throw error;
        }

        const rejected = await this.persistRejected(
          unitOfWork,
          transaction,
          error.code as FailureCode,
          correlationId,
          input.causationId,
          idempotentReplay,
        );
        return this.completeInbox(unitOfWork, inboxMessage, rejected);
      }

      return this.completeInbox(
        unitOfWork,
        inboxMessage,
        toWagerTransactionSubmissionView(transaction, idempotentReplay),
      );
    });
  }

  private async receiveInboxMessage(
    unitOfWork: FinancialUnitOfWorkPort,
    input: ProcessWagerTransactionInput,
    payloadHash: string,
  ): Promise<InboxMessage | undefined> {
    const context = input.inbox;
    if (context === undefined) {
      return undefined;
    }

    const inboxPayloadHash = context.payloadHash ?? payloadHash;
    const existing = await unitOfWork.inbox.findById(context.consumerName, context.messageId);
    if (existing !== null) {
      this.assertInboxPayload(existing, inboxPayloadHash);
      return existing;
    }

    const message = InboxMessage.receive({
      messageId: context.messageId,
      consumerName: context.consumerName,
      payloadHash: inboxPayloadHash,
      receivedAt: context.receivedAt,
    });
    const inserted = await this.insertInboxIfAbsent(unitOfWork, message);
    if (inserted) {
      return message;
    }

    const concurrentMessage = await unitOfWork.inbox.findById(
      context.consumerName,
      context.messageId,
    );
    if (concurrentMessage === null) {
      throw new DomainInvariantError('An inbox conflict was not recoverable.');
    }

    this.assertInboxPayload(concurrentMessage, inboxPayloadHash);
    return concurrentMessage;
  }

  private async completeInbox(
    unitOfWork: FinancialUnitOfWorkPort,
    message: InboxMessage | undefined,
    result: WagerTransactionSubmissionView,
  ): Promise<WagerTransactionSubmissionView> {
    if (message !== undefined && !message.isProcessed()) {
      message.markProcessed(this.clock.now());
      await unitOfWork.inbox.save(message);
    }

    return result;
  }

  private async insertInboxIfAbsent(
    unitOfWork: FinancialUnitOfWorkPort,
    message: InboxMessage,
  ): Promise<boolean> {
    if (unitOfWork.inbox.insertIfAbsent !== undefined) {
      return unitOfWork.inbox.insertIfAbsent(message);
    }

    await unitOfWork.inbox.insert(message);
    return true;
  }

  private assertInboxPayload(message: InboxMessage, payloadHash: string): void {
    if (message.payloadHash !== payloadHash) {
      throw new InboxPayloadConflictError();
    }
  }

  private async persistRejected(
    unitOfWork: FinancialUnitOfWorkPort,
    transaction: WagerTransaction,
    failureCode: FailureCode,
    correlationId: string | undefined,
    causationId: string | undefined,
    idempotentReplay: boolean,
  ): Promise<WagerTransactionSubmissionView> {
    transaction.reject(failureCode);
    await unitOfWork.transactions.save(transaction);
    await unitOfWork.outbox.insert(
      OutboxMessage.enqueue(
        WagerTransactionRejected.from(transaction, {
          correlationId: correlationId ?? transaction.id,
          causationId,
          occurredAt: transaction.createdAt,
        }),
      ),
    );

    return toWagerTransactionSubmissionView(transaction, idempotentReplay);
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

  private replayByExternalIdOrConflict(
    transaction: WagerTransaction,
    idempotencyKey: string,
    payloadHash: string,
  ): WagerTransactionSubmissionView {
    if (transaction.idempotencyKey === idempotencyKey) {
      return this.replayOrConflict(transaction, payloadHash);
    }

    throw new ExternalTransactionConflictError();
  }
}

function isReversalKind(
  kind: WagerTransactionKind,
): kind is WagerTransactionKind.Refund | WagerTransactionKind.Rollback {
  return kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback;
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
