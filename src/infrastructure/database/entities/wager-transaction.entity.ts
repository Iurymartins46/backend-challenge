import { Check, Column, Entity, Index, PrimaryColumn, Unique } from 'typeorm';

@Entity({ name: 'wager_transactions' })
@Unique('uq_wager_transactions_provider_external', ['providerId', 'externalTransactionId'])
@Unique('uq_wager_transactions_provider_idempotency', ['providerId', 'idempotencyKey'])
@Unique('uq_wager_transactions_id_wallet_currency', ['id', 'walletId', 'currency'])
@Index('idx_wager_transactions_reference_lookup', ['providerId', 'externalTransactionId'])
@Index('idx_wager_transactions_pending_reference', ['nextReferenceAttemptAt'], {
  where: '"status" = \'PENDING_REFERENCE\'',
})
@Check(
  'ck_wager_transactions_kind',
  "\"kind\" IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')",
)
@Check(
  'ck_wager_transactions_status',
  "\"status\" IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')",
)
@Check('ck_wager_transactions_amount_positive', '"amount_minor" > 0')
@Check('ck_wager_transactions_currency_format', '"currency" ~ \'^[A-Z]{3}$\'')
@Check(
  'ck_wager_transactions_reference_kind',
  "((\"kind\" IN ('REFUND', 'ROLLBACK') AND \"reference_external_transaction_id\" IS NOT NULL) OR (\"kind\" IN ('BET', 'LOSS', 'OPENING') AND \"reference_external_transaction_id\" IS NULL) OR \"kind\" = 'WIN')",
)
@Check(
  'ck_wager_transactions_processed_fields',
  '(("status" = \'PROCESSED\' AND "processed_at" IS NOT NULL AND "result_balance_minor" IS NOT NULL AND "result_wallet_version" IS NOT NULL) OR ("status" <> \'PROCESSED\' AND "processed_at" IS NULL AND "result_balance_minor" IS NULL AND "result_wallet_version" IS NULL))',
)
@Check(
  'ck_wager_transactions_result_balance_non_negative',
  '"result_balance_minor" IS NULL OR "result_balance_minor" >= 0',
)
@Check(
  'ck_wager_transactions_result_version_positive',
  '"result_wallet_version" IS NULL OR "result_wallet_version" >= 1',
)
export class WagerTransactionEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'varchar', name: 'provider_id', length: 255 })
  providerId!: string;

  @Column({ type: 'varchar', name: 'external_transaction_id', length: 255 })
  externalTransactionId!: string;

  @Column({ type: 'varchar', name: 'idempotency_key', length: 255 })
  idempotencyKey!: string;

  @Column({ type: 'char', name: 'payload_hash', length: 64 })
  payloadHash!: string;

  @Column({ type: 'uuid', name: 'wallet_id' })
  walletId!: string;

  @Column({ type: 'uuid', name: 'player_id' })
  playerId!: string;

  @Column({ type: 'varchar', name: 'round_id', length: 255 })
  roundId!: string;

  @Column({ type: 'varchar', name: 'game_id', length: 255 })
  gameId!: string;

  @Column({ type: 'varchar', length: 16 })
  kind!: string;

  @Column({ type: 'varchar', length: 24 })
  status!: string;

  /** PostgreSQL BIGINT is deliberately kept as a string at the ORM boundary. */
  @Column({ type: 'bigint', name: 'amount_minor' })
  amountMinor!: string;

  @Column({ type: 'char', length: 3 })
  currency!: string;

  @Column({
    type: 'varchar',
    name: 'reference_external_transaction_id',
    length: 255,
    nullable: true,
  })
  referenceExternalTransactionId!: string | null;

  @Column({ type: 'uuid', name: 'reference_transaction_id', nullable: true })
  referenceTransactionId!: string | null;

  @Column({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @Column({ type: 'varchar', name: 'failure_code', length: 100, nullable: true })
  failureCode!: string | null;

  @Column({ type: 'timestamptz', name: 'processed_at', nullable: true })
  processedAt!: Date | null;

  /** Snapshot columns are nullable until a terminal result is persisted. */
  @Column({ type: 'bigint', name: 'result_balance_minor', nullable: true })
  resultBalanceMinor!: string | null;

  @Column({ type: 'integer', name: 'result_wallet_version', nullable: true })
  resultWalletVersion!: number | null;

  @Column({ type: 'timestamptz', name: 'next_reference_attempt_at', nullable: true })
  nextReferenceAttemptAt!: Date | null;
}
