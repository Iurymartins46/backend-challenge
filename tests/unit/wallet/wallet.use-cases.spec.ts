import { describe, expect, test } from 'bun:test';

import type {
  FinancialUnitOfWorkPort,
  InboxMessageRepositoryPort,
  OutboxMessageRepositoryPort,
  WalletLedgerRepositoryPort,
  WalletRepositoryPort,
  WagerTransactionRepositoryPort,
} from '../../../src/modules/wagering/application/ports';
import type { Clock, IdGenerator } from '../../../src/modules/wagering/domain';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
  WalletAlreadyExistsError,
  type Wallet,
  type WalletLedgerEntry,
  type WagerTransaction,
} from '../../../src/modules/wagering/domain';
import { CreateWalletUseCase } from '../../../src/modules/wallet/application';

const now = new Date('2026-09-01T12:00:00.000Z');
const playerId = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';

class FixedClock implements Clock {
  now(): Date {
    return new Date(now.getTime());
  }
}

class FixedIdGenerator implements IdGenerator {
  private index = 0;

  constructor(private readonly ids: string[]) {}

  next(): string {
    const id = this.ids[this.index];
    if (id === undefined) {
      throw new Error('No test id available.');
    }

    this.index += 1;
    return id;
  }
}

class InMemoryFinancialUnitOfWork implements FinancialUnitOfWorkPort {
  readonly storedWallets: Wallet[] = [];
  readonly storedTransactions: WagerTransaction[] = [];
  readonly storedLedgerEntries: WalletLedgerEntry[] = [];
  readonly storedOutboxMessages: Array<{
    eventType: string;
    payload: Readonly<Record<string, unknown>>;
  }> = [];

  readonly wallets: WalletRepositoryPort = {
    findById: (id) => resolved(this.storedWallets.find((wallet) => wallet.id === id) ?? null),
    findByIdForUpdate: (id) =>
      resolved(this.storedWallets.find((wallet) => wallet.id === id) ?? null),
    findByPlayerAndCurrency: (candidatePlayerId, currency) =>
      resolved(
        this.storedWallets.find(
          (wallet) => wallet.playerId === candidatePlayerId && wallet.currency === currency,
        ) ?? null,
      ),
    insert: (wallet) => {
      if (
        this.storedWallets.some(
          (candidate) =>
            candidate.playerId === wallet.playerId && candidate.currency === wallet.currency,
        )
      ) {
        throw new WalletAlreadyExistsError();
      }

      this.storedWallets.push(wallet);
      return resolved(wallet);
    },
    save: (wallet) => resolved(wallet),
  };

  readonly transactions: WagerTransactionRepositoryPort = {
    findById: (id) =>
      resolved(this.storedTransactions.find((transaction) => transaction.id === id) ?? null),
    findByProviderAndExternalTransactionId: () => resolved(null),
    findByProviderAndIdempotencyKey: () => resolved(null),
    findProcessedReversal: () => resolved(null),
    insert: (transaction) => {
      this.storedTransactions.push(transaction);
      return resolved(transaction);
    },
    save: (transaction) => resolved(transaction),
  };

  readonly ledger: WalletLedgerRepositoryPort = {
    findById: (id) => resolved(this.storedLedgerEntries.find((entry) => entry.id === id) ?? null),
    findByTransactionId: (id) =>
      resolved(this.storedLedgerEntries.find((entry) => entry.transactionId === id) ?? null),
    findByWalletId: (id) =>
      resolved(this.storedLedgerEntries.filter((entry) => entry.walletId === id)),
    findByWalletIdPage: (id) =>
      resolved({
        entries: this.storedLedgerEntries.filter((entry) => entry.walletId === id),
        hasMore: false,
      }),
    insert: (entry) => {
      this.storedLedgerEntries.push(entry);
      return resolved(entry);
    },
    save: (entry) => resolved(entry),
  };

  readonly inbox: InboxMessageRepositoryPort = {
    findById: () => resolved(null),
    insert: (message) => resolved(message),
    save: (message) => resolved(message),
  };

  readonly outbox: OutboxMessageRepositoryPort = {
    findById: () => resolved(null),
    insert: (message) => {
      this.storedOutboxMessages.push({ eventType: message.eventType, payload: message.payload });
      return resolved(message);
    },
    save: (message) => resolved(message),
  };

  async transaction<T>(callback: (unitOfWork: FinancialUnitOfWorkPort) => Promise<T>): Promise<T> {
    return callback(this);
  }
}

function resolved<T>(value: T): Promise<T> {
  return Promise.resolve(value);
}

function createUseCase(unitOfWork: InMemoryFinancialUnitOfWork): CreateWalletUseCase {
  return new CreateWalletUseCase(
    unitOfWork,
    new FixedIdGenerator([
      '0192f291-27dd-7d3f-8071-5f8685deef37',
      '0192f298-345e-7e38-af88-e43f851a819d',
      '0192f299-345e-7e38-af88-e43f851a819d',
    ]),
    new FixedClock(),
  );
}

describe('wallet vertical use case', () => {
  test('opens a zero wallet without an opening transaction, ledger or outbox', async () => {
    const unitOfWork = new InMemoryFinancialUnitOfWork();
    const response = await createUseCase(unitOfWork).execute({
      playerId,
      initialBalance: { amount: '0.00', currency: 'BRL' },
    });

    expect(response).toEqual({
      id: '0192f291-27dd-7d3f-8071-5f8685deef37',
      playerId,
      balance: { amount: '0.00', currency: 'BRL' },
      version: 1,
    });
    expect(unitOfWork.storedTransactions).toHaveLength(0);
    expect(unitOfWork.storedLedgerEntries).toHaveLength(0);
    expect(unitOfWork.storedOutboxMessages).toHaveLength(0);
  });

  test('opens a positive wallet atomically with one opening, ledger and balance event', async () => {
    const unitOfWork = new InMemoryFinancialUnitOfWork();
    const response = await createUseCase(unitOfWork).execute({
      playerId,
      initialBalance: { amount: '1000.00', currency: 'BRL' },
      correlationId: 'correlation-wallet-1',
    });

    expect(response.balance).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(response.version).toBe(1);
    expect(unitOfWork.storedTransactions).toHaveLength(1);
    expect(unitOfWork.storedTransactions[0]?.kind).toBe(WagerTransactionKind.Opening);
    expect(unitOfWork.storedTransactions[0]?.status).toBe(WagerTransactionStatus.Processed);
    expect(unitOfWork.storedLedgerEntries).toHaveLength(1);
    expect(unitOfWork.storedLedgerEntries[0]?.isBalanced()).toBe(true);
    expect(unitOfWork.storedOutboxMessages).toHaveLength(1);
    expect(unitOfWork.storedOutboxMessages[0]?.eventType).toBe('WalletBalanceChanged');
  });

  test('rejects a duplicate player and currency before creating another wallet', async () => {
    const unitOfWork = new InMemoryFinancialUnitOfWork();
    const useCase = createUseCase(unitOfWork);

    await useCase.execute({
      playerId,
      initialBalance: { amount: '1.00', currency: 'BRL' },
    });

    await expectRejected(
      useCase.execute({
        playerId,
        initialBalance: { amount: '2.00', currency: 'BRL' },
      }),
      WalletAlreadyExistsError,
    );
    expect(unitOfWork.storedWallets).toHaveLength(1);
    expect(unitOfWork.storedTransactions).toHaveLength(1);
  });
});

async function expectRejected(
  promise: Promise<unknown>,
  errorType: new (...args: never[]) => Error,
): Promise<void> {
  let rejection: unknown;
  try {
    await promise;
  } catch (error: unknown) {
    rejection = error;
  }

  expect(rejection).toBeInstanceOf(errorType);
}
