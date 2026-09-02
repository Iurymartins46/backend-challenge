import type { EntityManager } from 'typeorm';

import { withTelemetrySpan } from '../telemetry';

import type {
  FinancialTransactionCallback,
  FinancialUnitOfWorkPort,
} from '../../modules/wagering/application/ports';
import {
  TypeOrmInboxMessageRepository,
  TypeOrmOutboxMessageRepository,
  TypeOrmWalletLedgerRepository,
  TypeOrmWalletRepository,
  TypeOrmWagerTransactionRepository,
} from './repositories';

/**
 * Repository set scoped to one EntityManager.
 *
 * The instance created by TypeORM's transaction callback is the only instance
 * that may be used for financial writes in that transaction. Repositories do
 * not resolve the global data-source manager themselves.
 */
export class FinancialUnitOfWork implements FinancialUnitOfWorkPort {
  readonly wallets: TypeOrmWalletRepository;
  readonly transactions: TypeOrmWagerTransactionRepository;
  readonly ledger: TypeOrmWalletLedgerRepository;
  readonly inbox: TypeOrmInboxMessageRepository;
  readonly outbox: TypeOrmOutboxMessageRepository;

  constructor(readonly manager: EntityManager) {
    this.wallets = new TypeOrmWalletRepository(manager);
    this.transactions = new TypeOrmWagerTransactionRepository(manager);
    this.ledger = new TypeOrmWalletLedgerRepository(manager);
    this.inbox = new TypeOrmInboxMessageRepository(manager);
    this.outbox = new TypeOrmOutboxMessageRepository(manager);
  }

  static fromEntityManager(manager: EntityManager): FinancialUnitOfWork {
    return new FinancialUnitOfWork(manager);
  }

  /** Starts a transaction and gives the callback a new, transaction-bound UoW. */
  async transaction<T>(callback: FinancialTransactionCallback<T>): Promise<T> {
    return withTelemetrySpan(
      'database.transaction',
      { 'db.system': 'postgresql', 'db.transaction.mode': 'read-write' },
      () =>
        this.manager.transaction(async (transactionManager) =>
          callback(FinancialUnitOfWork.fromEntityManager(transactionManager)),
        ),
    );
  }

  async repeatableRead<T>(callback: FinancialTransactionCallback<T>): Promise<T> {
    return withTelemetrySpan(
      'database.transaction',
      {
        'db.system': 'postgresql',
        'db.transaction.mode': 'repeatable-read',
      },
      () =>
        this.manager.transaction('REPEATABLE READ', async (transactionManager) =>
          callback(FinancialUnitOfWork.fromEntityManager(transactionManager)),
        ),
    );
  }

  get walletRepository(): TypeOrmWalletRepository {
    return this.wallets;
  }

  get wagerTransactionRepository(): TypeOrmWagerTransactionRepository {
    return this.transactions;
  }

  get walletLedgerRepository(): TypeOrmWalletLedgerRepository {
    return this.ledger;
  }

  get inboxMessageRepository(): TypeOrmInboxMessageRepository {
    return this.inbox;
  }

  get outboxMessageRepository(): TypeOrmOutboxMessageRepository {
    return this.outbox;
  }
}
