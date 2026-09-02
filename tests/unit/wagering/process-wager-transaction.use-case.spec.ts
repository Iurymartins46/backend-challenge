import { describe, expect, test } from 'bun:test';

import type {
  FinancialUnitOfWorkPort,
  InboxMessageRepositoryPort,
  OutboxMessageRepositoryPort,
  WalletLedgerRepositoryPort,
  WalletRepositoryPort,
  WagerTransactionRepositoryPort,
} from '../../../src/modules/wagering/application/ports';
import {
  ProcessWagerTransactionUseCase,
  type ProcessWagerTransactionInput,
} from '../../../src/modules/wagering/application';
import type { Clock, IdGenerator } from '../../../src/modules/wagering/domain';
import {
  LedgerDirection,
  Money,
  WagerTransactionKind,
  WagerTransactionStatus,
  Wallet,
  DependencyUnavailableError,
  ExponentialRetryPolicy,
  ExternalTransactionConflictError,
  IdempotencyPayloadConflictError,
  InboxPayloadConflictError,
  WagerWalletContextMismatchError,
  WalletNotFoundError,
  type InboxMessage,
  type OutboxMessage,
  type WalletLedgerEntry,
  type WagerTransaction,
} from '../../../src/modules/wagering/domain';

const now = new Date('2026-09-01T12:00:00.000Z');

class FixedClock implements Clock {
  now(): Date {
    return new Date(now.getTime());
  }
}

class IncrementingIdGenerator implements IdGenerator {
  private index = 0;

  next(): string {
    this.index += 1;
    return `generated-${this.index}`;
  }
}

class InMemoryFinancialUnitOfWork implements FinancialUnitOfWorkPort {
  readonly storedWallets: Wallet[] = [];
  readonly storedTransactions: WagerTransaction[] = [];
  readonly storedLedgerEntries: WalletLedgerEntry[] = [];
  readonly storedInboxMessages: InboxMessage[] = [];
  readonly storedOutboxMessages: OutboxMessage[] = [];
  readonly transactionFailures: Error[] = [];

  readonly wallets: WalletRepositoryPort = {
    findById: (id) =>
      Promise.resolve(this.storedWallets.find((wallet) => wallet.id === id) ?? null),
    findByIdForUpdate: (id) =>
      Promise.resolve(this.storedWallets.find((wallet) => wallet.id === id) ?? null),
    findByPlayerAndCurrency: (playerId, currency) =>
      Promise.resolve(
        this.storedWallets.find(
          (wallet) => wallet.playerId === playerId && wallet.currency === currency,
        ) ?? null,
      ),
    insert: (wallet) => {
      this.storedWallets.push(wallet);
      return Promise.resolve(wallet);
    },
    save: (wallet) => Promise.resolve(wallet),
  };

  readonly transactions: WagerTransactionRepositoryPort = {
    findById: (id) =>
      Promise.resolve(this.storedTransactions.find((transaction) => transaction.id === id) ?? null),
    findByProviderAndExternalTransactionId: (providerId, externalTransactionId) =>
      Promise.resolve(
        this.storedTransactions.find(
          (transaction) =>
            transaction.providerId === providerId &&
            transaction.externalTransactionId === externalTransactionId,
        ) ?? null,
      ),
    findByProviderAndIdempotencyKey: (providerId, idempotencyKey) =>
      Promise.resolve(
        this.storedTransactions.find(
          (transaction) =>
            transaction.providerId === providerId && transaction.idempotencyKey === idempotencyKey,
        ) ?? null,
      ),
    findProcessedReversal: (referenceTransactionId, kind) =>
      Promise.resolve(
        this.storedTransactions.find(
          (transaction) =>
            transaction.referenceTransactionId === referenceTransactionId &&
            transaction.kind === kind &&
            transaction.status === WagerTransactionStatus.Processed,
        ) ?? null,
      ),
    insert: (transaction) => {
      this.storedTransactions.push(transaction);
      return Promise.resolve(transaction);
    },
    insertIfAbsent: (transaction) => {
      const exists = this.storedTransactions.some(
        (candidate) =>
          (candidate.providerId === transaction.providerId &&
            candidate.idempotencyKey === transaction.idempotencyKey) ||
          (candidate.providerId === transaction.providerId &&
            candidate.externalTransactionId === transaction.externalTransactionId),
      );
      if (!exists) {
        this.storedTransactions.push(transaction);
      }

      return Promise.resolve(!exists);
    },
    save: (transaction) => Promise.resolve(transaction),
  };

  readonly ledger: WalletLedgerRepositoryPort = {
    findById: (id) =>
      Promise.resolve(this.storedLedgerEntries.find((entry) => entry.id === id) ?? null),
    findByTransactionId: (transactionId) =>
      Promise.resolve(
        this.storedLedgerEntries.find((entry) => entry.transactionId === transactionId) ?? null,
      ),
    findByWalletId: (walletId) =>
      Promise.resolve(this.storedLedgerEntries.filter((entry) => entry.walletId === walletId)),
    findByWalletIdPage: (walletId) =>
      Promise.resolve({
        entries: this.storedLedgerEntries.filter((entry) => entry.walletId === walletId),
        hasMore: false,
      }),
    summarizeWalletBalance: (walletId) =>
      Promise.resolve({
        calculatedBalanceMinor: this.storedLedgerEntries
          .filter((entry) => entry.walletId === walletId)
          .reduce(
            (balance, entry) =>
              entry.direction === LedgerDirection.Credit
                ? balance + entry.money.toMinorUnits()
                : balance - entry.money.toMinorUnits(),
            0n,
          ),
        checkedEntries: this.storedLedgerEntries.filter((entry) => entry.walletId === walletId)
          .length,
      }),
    insert: (entry) => {
      this.storedLedgerEntries.push(entry);
      return Promise.resolve(entry);
    },
    save: (entry) => Promise.resolve(entry),
  };

  readonly inbox: InboxMessageRepositoryPort = {
    findById: (consumerName, messageId) =>
      Promise.resolve(
        this.storedInboxMessages.find(
          (message) => message.consumerName === consumerName && message.messageId === messageId,
        ) ?? null,
      ),
    insert: (message) => {
      this.storedInboxMessages.push(message);
      return Promise.resolve(message);
    },
    insertIfAbsent: (message) => {
      const exists = this.storedInboxMessages.some(
        (candidate) =>
          candidate.consumerName === message.consumerName &&
          candidate.messageId === message.messageId,
      );
      if (!exists) {
        this.storedInboxMessages.push(message);
      }

      return Promise.resolve(!exists);
    },
    save: (message) => Promise.resolve(message),
  };

  readonly outbox: OutboxMessageRepositoryPort = {
    findById: (id) =>
      Promise.resolve(this.storedOutboxMessages.find((message) => message.id === id) ?? null),
    insert: (message) => {
      this.storedOutboxMessages.push(message);
      return Promise.resolve(message);
    },
    save: (message) => Promise.resolve(message),
  };

  async transaction<T>(callback: (unitOfWork: FinancialUnitOfWorkPort) => Promise<T>): Promise<T> {
    const failure = this.transactionFailures.shift();
    if (failure !== undefined) {
      throw failure;
    }

    return callback(this);
  }

  async repeatableRead<T>(
    callback: (unitOfWork: FinancialUnitOfWorkPort) => Promise<T>,
  ): Promise<T> {
    return callback(this);
  }
}

function createUseCase(unitOfWork: InMemoryFinancialUnitOfWork): ProcessWagerTransactionUseCase {
  return new ProcessWagerTransactionUseCase(
    unitOfWork,
    new IncrementingIdGenerator(),
    new FixedClock(),
  );
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }

  throw new Error('Expected the promise to reject.');
}

function input(
  overrides: Partial<ProcessWagerTransactionInput> = {},
): ProcessWagerTransactionInput {
  return {
    providerId: 'provider-a',
    externalTransactionId: 'external-default',
    idempotencyKey: 'key-default',
    playerId: 'player-1',
    walletId: 'wallet-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: { amount: '10.00', currency: 'BRL' },
    ...overrides,
  };
}

function addWallet(unitOfWork: InMemoryFinancialUnitOfWork, balance: string): void {
  unitOfWork.storedWallets.push(
    Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.from({ amount: balance, currency: 'BRL' }),
      createdAt: now,
    }),
  );
}

describe('wager transaction reference processing', () => {
  test('applies BET, REFUND and ROLLBACK in all three ledger directions', async () => {
    const unitOfWork = new InMemoryFinancialUnitOfWork();
    addWallet(unitOfWork, '100.00');
    const useCase = createUseCase(unitOfWork);

    const bet = await useCase.execute(
      input({ externalTransactionId: 'bet', idempotencyKey: 'key-bet' }),
    );
    const rollbackBet = await useCase.execute(
      input({
        externalTransactionId: 'rollback-bet',
        idempotencyKey: 'key-rollback-bet',
        kind: WagerTransactionKind.Rollback,
        referenceExternalTransactionId: 'bet',
      }),
    );
    const win = await useCase.execute(
      input({
        externalTransactionId: 'win',
        idempotencyKey: 'key-win',
        kind: WagerTransactionKind.Win,
        money: { amount: '20.00', currency: 'BRL' },
      }),
    );
    const rollbackWin = await useCase.execute(
      input({
        externalTransactionId: 'rollback-win',
        idempotencyKey: 'key-rollback-win',
        kind: WagerTransactionKind.Rollback,
        money: { amount: '20.00', currency: 'BRL' },
        referenceExternalTransactionId: 'win',
      }),
    );
    const refund = await useCase.execute(
      input({
        externalTransactionId: 'refund',
        idempotencyKey: 'key-refund',
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'bet',
      }),
    );
    const rollbackRefund = await useCase.execute(
      input({
        externalTransactionId: 'rollback-refund',
        idempotencyKey: 'key-rollback-refund',
        kind: WagerTransactionKind.Rollback,
        referenceExternalTransactionId: 'refund',
      }),
    );

    expect(
      [bet, rollbackBet, win, rollbackWin, refund, rollbackRefund].every(
        (result) => result.status === WagerTransactionStatus.Processed,
      ),
    ).toBe(true);
    expect(unitOfWork.storedWallets[0]?.balance.toJSON()).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });
    expect(unitOfWork.storedLedgerEntries.map((entry) => entry.direction)).toEqual([
      LedgerDirection.Debit,
      LedgerDirection.Credit,
      LedgerDirection.Credit,
      LedgerDirection.Debit,
      LedgerDirection.Credit,
      LedgerDirection.Debit,
    ]);
  });

  test('persists a missing reference as pending and retries it as an idempotent request', async () => {
    const unitOfWork = new InMemoryFinancialUnitOfWork();
    addWallet(unitOfWork, '100.00');
    const useCase = createUseCase(unitOfWork);
    const refundInput = input({
      externalTransactionId: 'refund',
      idempotencyKey: 'key-refund',
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'bet-not-yet-seen',
    });

    const pending = await useCase.execute(refundInput);
    expect(pending).toMatchObject({
      status: WagerTransactionStatus.PendingReference,
      idempotentReplay: false,
    });
    expect(unitOfWork.storedTransactions[0]?.nextReferenceAttemptAt?.getTime()).toBe(
      now.getTime() + 2_000,
    );
    expect(unitOfWork.storedOutboxMessages.map((message) => message.eventType)).toEqual([
      'WagerTransactionPendingReference',
    ]);

    const stillPending = await useCase.execute(refundInput);
    expect(stillPending).toMatchObject({
      status: WagerTransactionStatus.PendingReference,
      idempotentReplay: true,
    });
    expect(unitOfWork.storedOutboxMessages).toHaveLength(1);

    await useCase.execute(
      input({ externalTransactionId: 'bet-not-yet-seen', idempotencyKey: 'key-bet' }),
    );
    const processed = await useCase.execute(refundInput);

    expect(processed).toMatchObject({
      status: WagerTransactionStatus.Processed,
      idempotentReplay: true,
      balance: { amount: '100.00', currency: 'BRL' },
    });
    expect(unitOfWork.storedTransactions).toHaveLength(2);
    expect(unitOfWork.storedLedgerEntries).toHaveLength(2);
  });

  test('rejects an invalid reversal without changing the wallet and distinguishes underflow', async () => {
    const unitOfWork = new InMemoryFinancialUnitOfWork();
    addWallet(unitOfWork, '0.00');
    const useCase = createUseCase(unitOfWork);

    await useCase.execute(
      input({
        externalTransactionId: 'win',
        idempotencyKey: 'key-win',
        kind: WagerTransactionKind.Win,
        money: { amount: '10.00', currency: 'BRL' },
      }),
    );
    await useCase.execute(
      input({
        externalTransactionId: 'bet',
        idempotencyKey: 'key-bet',
        money: { amount: '10.00', currency: 'BRL' },
      }),
    );

    const rollbackWin = await useCase.execute(
      input({
        externalTransactionId: 'rollback-win',
        idempotencyKey: 'key-rollback-win',
        kind: WagerTransactionKind.Rollback,
        money: { amount: '10.00', currency: 'BRL' },
        referenceExternalTransactionId: 'win',
      }),
    );
    expect(rollbackWin).toMatchObject({
      status: WagerTransactionStatus.Rejected,
      failureCode: 'error.wager.reversal_negative_balance',
    });
    expect(unitOfWork.storedWallets[0]?.balance.toJSON()).toEqual({
      amount: '0.00',
      currency: 'BRL',
    });
    expect(unitOfWork.storedLedgerEntries).toHaveLength(2);
  });

  test('keeps LOSS auditably processed without a ledger entry or wallet version change', async () => {
    const unitOfWork = new InMemoryFinancialUnitOfWork();
    addWallet(unitOfWork, '100.00');

    const result = await createUseCase(unitOfWork).execute(
      input({
        externalTransactionId: 'loss',
        idempotencyKey: 'key-loss',
        kind: WagerTransactionKind.Loss,
      }),
    );

    expect(result).toEqual({
      transactionId: 'generated-1',
      status: WagerTransactionStatus.Processed,
      balance: { amount: '100.00', currency: 'BRL' },
      walletVersion: 1,
      idempotentReplay: false,
    });
    expect(unitOfWork.storedWallets[0]?.version).toBe(1);
    expect(unitOfWork.storedLedgerEntries).toHaveLength(0);
    expect(unitOfWork.storedOutboxMessages.map((message) => message.eventType)).toEqual([
      'WagerTransactionProcessed',
    ]);
  });

  test('persists an insufficient BET rejection once without a ledger or wallet mutation', async () => {
    const unitOfWork = new InMemoryFinancialUnitOfWork();
    addWallet(unitOfWork, '5.00');
    const useCase = createUseCase(unitOfWork);
    const insufficientBet = input({
      externalTransactionId: 'insufficient-bet',
      idempotencyKey: 'key-insufficient-bet',
      money: { amount: '10.00', currency: 'BRL' },
    });

    const first = await useCase.execute(insufficientBet);
    const replay = await useCase.execute(insufficientBet);

    expect(first).toMatchObject({
      status: WagerTransactionStatus.Rejected,
      failureCode: 'error.wager.insufficient_funds',
      idempotentReplay: false,
    });
    expect(replay).toEqual({ ...first, idempotentReplay: true });
    expect(unitOfWork.storedWallets[0]?.balance.toString()).toBe('5.00');
    expect(unitOfWork.storedWallets[0]?.version).toBe(1);
    expect(unitOfWork.storedLedgerEntries).toHaveLength(0);
    expect(unitOfWork.storedTransactions).toHaveLength(1);
    expect(unitOfWork.storedOutboxMessages.map((message) => message.eventType)).toEqual([
      'WagerTransactionRejected',
    ]);
  });

  test('rejects conflicting idempotency and external transaction keys without a second effect', async () => {
    const unitOfWork = new InMemoryFinancialUnitOfWork();
    addWallet(unitOfWork, '100.00');
    const useCase = createUseCase(unitOfWork);
    const original = input({ externalTransactionId: 'original', idempotencyKey: 'key-original' });

    await useCase.execute(original);

    expect(
      await rejectionOf(
        useCase.execute({ ...original, money: { amount: '11.00', currency: 'BRL' } }),
      ),
    ).toBeInstanceOf(IdempotencyPayloadConflictError);
    expect(
      await rejectionOf(useCase.execute({ ...original, idempotencyKey: 'key-other' })),
    ).toBeInstanceOf(ExternalTransactionConflictError);

    expect(unitOfWork.storedWallets[0]?.balance.toString()).toBe('90.00');
    expect(unitOfWork.storedTransactions).toHaveLength(1);
    expect(unitOfWork.storedLedgerEntries).toHaveLength(1);
    expect(unitOfWork.storedOutboxMessages).toHaveLength(2);
  });

  test('rejects missing wallets and mismatched wallet context before transaction persistence', async () => {
    const missingWalletUnitOfWork = new InMemoryFinancialUnitOfWork();
    expect(
      await rejectionOf(createUseCase(missingWalletUnitOfWork).execute(input())),
    ).toBeInstanceOf(WalletNotFoundError);
    expect(missingWalletUnitOfWork.storedTransactions).toHaveLength(0);

    const mismatchedWalletUnitOfWork = new InMemoryFinancialUnitOfWork();
    addWallet(mismatchedWalletUnitOfWork, '100.00');
    expect(
      await rejectionOf(
        createUseCase(mismatchedWalletUnitOfWork).execute(input({ playerId: 'another-player' })),
      ),
    ).toBeInstanceOf(WagerWalletContextMismatchError);
    expect(mismatchedWalletUnitOfWork.storedTransactions).toHaveLength(0);
  });

  test('uses the persistent inbox for SQS redelivery and refuses a divergent application message', async () => {
    const unitOfWork = new InMemoryFinancialUnitOfWork();
    addWallet(unitOfWork, '100.00');
    const useCase = createUseCase(unitOfWork);
    const firstInput = input({
      externalTransactionId: 'sqs-bet',
      idempotencyKey: 'key-sqs-bet',
      inbox: {
        consumerName: 'wager-consumer',
        messageId: 'application-message-1',
        payloadHash: 'command-hash-1',
        receivedAt: now,
      },
    });

    await useCase.execute(firstInput);
    const replay = await useCase.execute(firstInput);

    expect(replay.idempotentReplay).toBe(true);
    expect(unitOfWork.storedInboxMessages).toHaveLength(1);
    expect(unitOfWork.storedInboxMessages[0]?.isProcessed()).toBe(true);
    expect(unitOfWork.storedWallets[0]?.balance.toString()).toBe('90.00');
    expect(unitOfWork.storedLedgerEntries).toHaveLength(1);

    expect(
      await rejectionOf(
        useCase.execute({
          ...firstInput,
          inbox: { ...firstInput.inbox!, payloadHash: 'different-command-hash' },
        }),
      ),
    ).toBeInstanceOf(InboxPayloadConflictError);
    expect(unitOfWork.storedTransactions).toHaveLength(1);
    expect(unitOfWork.storedLedgerEntries).toHaveLength(1);
  });

  test('retries transient transaction failures with the configured delay and normalizes exhaustion', async () => {
    const retryingUnitOfWork = new InMemoryFinancialUnitOfWork();
    addWallet(retryingUnitOfWork, '100.00');
    retryingUnitOfWork.transactionFailures.push(
      Object.assign(new Error('serialization failure'), { code: '40001' }),
    );
    const delays: number[] = [];
    const retryingUseCase = new ProcessWagerTransactionUseCase(
      retryingUnitOfWork,
      new IncrementingIdGenerator(),
      new FixedClock(),
      new ExponentialRetryPolicy({ baseDelayMs: 7, maxDelayMs: 7, maxAttempts: 1 }),
      (delayMs) => {
        delays.push(delayMs);
        return Promise.resolve();
      },
    );

    const result = await retryingUseCase.execute(
      input({ externalTransactionId: 'retried-bet', idempotencyKey: 'key-retried-bet' }),
    );
    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(delays).toEqual([7]);

    const exhaustedUnitOfWork = new InMemoryFinancialUnitOfWork();
    exhaustedUnitOfWork.transactionFailures.push(
      Object.assign(new Error('lock timeout'), { code: '55P03' }),
      Object.assign(new Error('lock timeout'), { code: '55P03' }),
    );
    const exhaustedUseCase = new ProcessWagerTransactionUseCase(
      exhaustedUnitOfWork,
      new IncrementingIdGenerator(),
      new FixedClock(),
      new ExponentialRetryPolicy({ baseDelayMs: 1, maxDelayMs: 1, maxAttempts: 1 }),
      () => Promise.resolve(),
    );

    expect(await rejectionOf(exhaustedUseCase.execute(input()))).toBeInstanceOf(
      DependencyUnavailableError,
    );
  });
});
