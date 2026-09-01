import type {
  InboxMessageRepositoryPort,
  OutboxMessageRepositoryPort,
  WalletLedgerRepositoryPort,
  WalletRepositoryPort,
  WagerTransactionRepositoryPort,
} from './financial-repositories';

export interface FinancialUnitOfWorkPort {
  readonly wallets: WalletRepositoryPort;
  readonly transactions: WagerTransactionRepositoryPort;
  readonly ledger: WalletLedgerRepositoryPort;
  readonly inbox: InboxMessageRepositoryPort;
  readonly outbox: OutboxMessageRepositoryPort;
  transaction<T>(callback: FinancialTransactionCallback<T>): Promise<T>;
}

export type FinancialTransactionCallback<T> = (unitOfWork: FinancialUnitOfWorkPort) => Promise<T>;
