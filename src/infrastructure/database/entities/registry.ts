import { InboxMessageEntity } from './inbox-message.entity';
import { OutboxMessageEntity } from './outbox-message.entity';
import { WalletLedgerEntryEntity } from './wallet-ledger-entry.entity';
import { WalletEntity } from './wallet.entity';
import { WagerTransactionEntity } from './wager-transaction.entity';

export const entities = [
  InboxMessageEntity,
  OutboxMessageEntity,
  WalletEntity,
  WalletLedgerEntryEntity,
  WagerTransactionEntity,
];
