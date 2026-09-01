import { Check, Column, Entity, PrimaryColumn, Unique } from 'typeorm';

@Entity({ name: 'wallet_ledger_entries' })
@Unique('uq_wallet_ledger_entries_wallet_transaction', ['walletId', 'transactionId'])
@Check('ck_wallet_ledger_entries_direction', "\"direction\" IN ('DEBIT', 'CREDIT')")
@Check('ck_wallet_ledger_entries_amount_positive', '"amount_minor" > 0')
@Check(
  'ck_wallet_ledger_entries_balances_non_negative',
  '"balance_before_minor" >= 0 AND "balance_after_minor" >= 0',
)
@Check(
  'ck_wallet_ledger_entries_arithmetic',
  '(("direction" = \'DEBIT\' AND "balance_after_minor" = "balance_before_minor" - "amount_minor") OR ("direction" = \'CREDIT\' AND "balance_after_minor" = "balance_before_minor" + "amount_minor"))',
)
@Check('ck_wallet_ledger_entries_currency_format', '"currency" ~ \'^[A-Z]{3}$\'')
export class WalletLedgerEntryEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'uuid', name: 'wallet_id' })
  walletId!: string;

  @Column({ type: 'uuid', name: 'transaction_id' })
  transactionId!: string;

  @Column({ type: 'varchar', length: 6 })
  direction!: string;

  /** PostgreSQL BIGINT is deliberately kept as a string at the ORM boundary. */
  @Column({ type: 'bigint', name: 'amount_minor' })
  amountMinor!: string;

  @Column({ type: 'char', length: 3 })
  currency!: string;

  @Column({ type: 'bigint', name: 'balance_before_minor' })
  balanceBeforeMinor!: string;

  @Column({ type: 'bigint', name: 'balance_after_minor' })
  balanceAfterMinor!: string;

  @Column({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
