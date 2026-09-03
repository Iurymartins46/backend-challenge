import type { InboxMessage } from '../../domain/inbox';
import type { WalletLedgerEntry } from '../../domain/ledger';
import type { OutboxMessage } from '../../domain/outbox';
import type { Wallet } from '../../domain/wallet';
import type { WagerTransaction, WagerTransactionKind } from '../../domain/wager-transaction';

export interface WalletRepositoryPort {
  findById(id: string): Promise<Wallet | null>;
  findByIdForUpdate(id: string): Promise<Wallet | null>;
  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null>;
  insert(wallet: Wallet): Promise<Wallet>;
  save(wallet: Wallet): Promise<Wallet>;
}

export interface WagerTransactionRepositoryPort {
  findById(id: string): Promise<WagerTransaction | null>;
  findByIdAndProviderId(id: string, providerId: string): Promise<WagerTransaction | null>;
  findByProviderAndExternalTransactionId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null>;
  findByProviderAndIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
  ): Promise<WagerTransaction | null>;
  findProcessedReversal(
    referenceTransactionId: string,
    kind: WagerTransactionKind.Refund | WagerTransactionKind.Rollback,
  ): Promise<WagerTransaction | null>;
  insert(transaction: WagerTransaction): Promise<WagerTransaction>;
  /** Inserts atomically and returns false when a unique business key already exists. */
  insertIfAbsent?(transaction: WagerTransaction): Promise<boolean>;
  save(transaction: WagerTransaction): Promise<WagerTransaction>;
  claimPendingReferenceDue?(
    input: PendingReferenceClaimInput,
  ): Promise<readonly PendingReferenceClaim[]>;
  schedulePendingReferenceRetryIfOwned?(input: PendingReferenceRetryInput): Promise<boolean>;
  releasePendingReferenceClaimIfOwned?(input: PendingReferenceLeaseMutationInput): Promise<boolean>;
  measurePendingReferences?(now: Date): Promise<PendingReferenceMetrics>;
}

export interface PendingReferenceClaimInput {
  readonly now: Date;
  readonly limit: number;
  readonly owner: string;
  readonly leaseUntil: Date;
}

export interface PendingReferenceClaim {
  readonly transaction: WagerTransaction;
  /** Number of worker attempts, persisted atomically when the lease is claimed. */
  readonly attempts: number;
}

export interface PendingReferenceRetryInput {
  readonly transaction: WagerTransaction;
  readonly owner: string;
  readonly now: Date;
}

export interface PendingReferenceLeaseMutationInput {
  readonly transactionId: string;
  readonly owner: string;
  readonly now: Date;
}

export interface PendingReferenceMetrics {
  readonly pendingCount: number;
  readonly attempts: number;
}

export interface WalletLedgerRepositoryPort {
  findById(id: string): Promise<WalletLedgerEntry | null>;
  findByTransactionId(transactionId: string): Promise<WalletLedgerEntry | null>;
  findByWalletId(walletId: string): Promise<readonly WalletLedgerEntry[]>;
  findByWalletIdPage(walletId: string, query: WalletLedgerPageQuery): Promise<WalletLedgerPage>;
  summarizeWalletBalance(walletId: string): Promise<WalletLedgerBalanceSummary>;
  insert(entry: WalletLedgerEntry): Promise<WalletLedgerEntry>;
  save(entry: WalletLedgerEntry): Promise<WalletLedgerEntry>;
}

export interface WalletLedgerCursorPosition {
  readonly createdAt: Date;
  readonly id: string;
}

export interface WalletLedgerPageQuery {
  readonly after?: WalletLedgerCursorPosition;
  readonly limit: number;
}

export interface WalletLedgerPage {
  readonly entries: readonly WalletLedgerEntry[];
  readonly hasMore: boolean;
}

/** Signed sum reconstructed from immutable ledger entries for one wallet. */
export interface WalletLedgerBalanceSummary {
  readonly calculatedBalanceMinor: bigint;
  readonly checkedEntries: number;
}

export interface InboxMessageRepositoryPort {
  findById(consumerName: string, messageId: string): Promise<InboxMessage | null>;
  insert(message: InboxMessage): Promise<InboxMessage>;
  /** Inserts atomically and returns false when this consumer already saw the message. */
  insertIfAbsent?(message: InboxMessage): Promise<boolean>;
  save(message: InboxMessage): Promise<InboxMessage>;
}

export interface OutboxMessageRepositoryPort {
  findById(id: string): Promise<OutboxMessage | null>;
  insert(message: OutboxMessage): Promise<OutboxMessage>;
  save(message: OutboxMessage): Promise<OutboxMessage>;
  claimDue?(input: OutboxClaimInput): Promise<readonly OutboxMessage[]>;
  markPublishedIfOwned?(input: OutboxLeaseMutationInput): Promise<boolean>;
  saveRetryIfOwned?(input: OutboxRetryMutationInput): Promise<boolean>;
  measurePending?(now: Date): Promise<OutboxPendingMetrics>;
}

export interface OutboxClaimInput {
  readonly now: Date;
  readonly limit: number;
  readonly owner: string;
  readonly leaseUntil: Date;
}

export interface OutboxLeaseMutationInput {
  readonly id: string;
  readonly owner: string;
  readonly now: Date;
}

export interface OutboxRetryMutationInput {
  readonly message: OutboxMessage;
  readonly owner: string;
  readonly now: Date;
}

export interface OutboxPendingMetrics {
  readonly pendingCount: number;
  readonly lagMs: number;
}
