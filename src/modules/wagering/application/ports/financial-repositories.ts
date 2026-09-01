import type { InboxMessage } from '../../domain/inbox';
import type { WalletLedgerEntry } from '../../domain/ledger';
import type { OutboxMessage } from '../../domain/outbox';
import type { Wallet } from '../../domain/wallet';
import type { WagerTransaction } from '../../domain/wager-transaction';

export interface WalletRepositoryPort {
  findById(id: string): Promise<Wallet | null>;
  findByIdForUpdate(id: string): Promise<Wallet | null>;
  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null>;
  insert(wallet: Wallet): Promise<Wallet>;
  save(wallet: Wallet): Promise<Wallet>;
}

export interface WagerTransactionRepositoryPort {
  findById(id: string): Promise<WagerTransaction | null>;
  findByProviderAndExternalTransactionId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null>;
  findByProviderAndIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
  ): Promise<WagerTransaction | null>;
  insert(transaction: WagerTransaction): Promise<WagerTransaction>;
  save(transaction: WagerTransaction): Promise<WagerTransaction>;
}

export interface WalletLedgerRepositoryPort {
  findById(id: string): Promise<WalletLedgerEntry | null>;
  findByTransactionId(transactionId: string): Promise<WalletLedgerEntry | null>;
  findByWalletId(walletId: string): Promise<readonly WalletLedgerEntry[]>;
  insert(entry: WalletLedgerEntry): Promise<WalletLedgerEntry>;
  save(entry: WalletLedgerEntry): Promise<WalletLedgerEntry>;
}

export interface InboxMessageRepositoryPort {
  findById(consumerName: string, messageId: string): Promise<InboxMessage | null>;
  insert(message: InboxMessage): Promise<InboxMessage>;
  save(message: InboxMessage): Promise<InboxMessage>;
}

export interface OutboxMessageRepositoryPort {
  findById(id: string): Promise<OutboxMessage | null>;
  insert(message: OutboxMessage): Promise<OutboxMessage>;
  save(message: OutboxMessage): Promise<OutboxMessage>;
}
