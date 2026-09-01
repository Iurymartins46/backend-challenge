import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateFinancialSchema1770000000000 implements MigrationInterface {
  name = 'CreateFinancialSchema1770000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE wallets (
        id UUID NOT NULL,
        player_id UUID NOT NULL,
        currency CHAR(3) NOT NULL,
        balance_minor BIGINT NOT NULL,
        version INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT pk_wallets PRIMARY KEY (id),
        CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency),
        CONSTRAINT uq_wallets_id_currency UNIQUE (id, currency),
        CONSTRAINT uq_wallets_id_player_currency UNIQUE (id, player_id, currency),
        CONSTRAINT ck_wallets_balance_non_negative CHECK (balance_minor >= 0),
        CONSTRAINT ck_wallets_version_positive CHECK (version >= 1),
        CONSTRAINT ck_wallets_currency_format CHECK (currency ~ '^[A-Z]{3}$')
      )
    `);

    await queryRunner.query(`
      CREATE INDEX idx_wallets_player_id ON wallets (player_id)
    `);

    await queryRunner.query(`
      CREATE TABLE wager_transactions (
        id UUID NOT NULL,
        provider_id VARCHAR(255) NOT NULL,
        external_transaction_id VARCHAR(255) NOT NULL,
        idempotency_key VARCHAR(255) NOT NULL,
        payload_hash CHAR(64) NOT NULL,
        wallet_id UUID NOT NULL,
        player_id UUID NOT NULL,
        round_id VARCHAR(255) NOT NULL,
        game_id VARCHAR(255) NOT NULL,
        kind VARCHAR(16) NOT NULL,
        status VARCHAR(24) NOT NULL,
        amount_minor BIGINT NOT NULL,
        currency CHAR(3) NOT NULL,
        reference_external_transaction_id VARCHAR(255),
        reference_transaction_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        failure_code VARCHAR(100),
        processed_at TIMESTAMPTZ,
        result_balance_minor BIGINT,
        result_wallet_version INTEGER,
        next_reference_attempt_at TIMESTAMPTZ,
        CONSTRAINT pk_wager_transactions PRIMARY KEY (id),
        CONSTRAINT uq_wager_transactions_provider_external UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT uq_wager_transactions_provider_idempotency UNIQUE (provider_id, idempotency_key),
        CONSTRAINT uq_wager_transactions_id_wallet_currency UNIQUE (id, wallet_id, currency),
        CONSTRAINT uq_wager_transactions_id_wallet_player_currency UNIQUE (id, wallet_id, player_id, currency),
        CONSTRAINT fk_wager_transactions_wallet FOREIGN KEY (wallet_id, player_id, currency)
          REFERENCES wallets (id, player_id, currency),
        CONSTRAINT fk_wager_transactions_reference FOREIGN KEY (reference_transaction_id, wallet_id, player_id, currency)
          REFERENCES wager_transactions (id, wallet_id, player_id, currency),
        CONSTRAINT ck_wager_transactions_kind CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        CONSTRAINT ck_wager_transactions_status CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        CONSTRAINT ck_wager_transactions_amount_positive CHECK (amount_minor > 0),
        CONSTRAINT ck_wager_transactions_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT ck_wager_transactions_reference_kind CHECK (
          (kind IN ('REFUND', 'ROLLBACK') AND reference_external_transaction_id IS NOT NULL)
          OR (kind IN ('BET', 'LOSS', 'OPENING') AND reference_external_transaction_id IS NULL)
          OR kind = 'WIN'
        ),
        CONSTRAINT ck_wager_transactions_processed_fields CHECK (
          (status = 'PROCESSED' AND processed_at IS NOT NULL AND result_balance_minor IS NOT NULL AND result_wallet_version IS NOT NULL)
          OR (status <> 'PROCESSED' AND processed_at IS NULL AND result_balance_minor IS NULL AND result_wallet_version IS NULL)
        ),
        CONSTRAINT ck_wager_transactions_result_balance_non_negative CHECK (result_balance_minor IS NULL OR result_balance_minor >= 0),
        CONSTRAINT ck_wager_transactions_result_version_positive CHECK (result_wallet_version IS NULL OR result_wallet_version >= 1)
      )
    `);

    await queryRunner.query(`
      CREATE INDEX idx_wager_transactions_pending_reference
        ON wager_transactions (next_reference_attempt_at, created_at, id)
        WHERE status = 'PENDING_REFERENCE'
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_wager_transactions_processed_reversal
        ON wager_transactions (reference_transaction_id, kind)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK')
    `);

    await queryRunner.query(`
      CREATE TABLE wallet_ledger_entries (
        id UUID NOT NULL,
        wallet_id UUID NOT NULL,
        transaction_id UUID NOT NULL,
        direction VARCHAR(6) NOT NULL,
        amount_minor BIGINT NOT NULL,
        currency CHAR(3) NOT NULL,
        balance_before_minor BIGINT NOT NULL,
        balance_after_minor BIGINT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT pk_wallet_ledger_entries PRIMARY KEY (id),
        CONSTRAINT uq_wallet_ledger_entries_wallet_transaction UNIQUE (wallet_id, transaction_id),
        CONSTRAINT fk_wallet_ledger_entries_wallet FOREIGN KEY (wallet_id, currency)
          REFERENCES wallets (id, currency),
        CONSTRAINT fk_wallet_ledger_entries_transaction FOREIGN KEY (transaction_id, wallet_id, currency)
          REFERENCES wager_transactions (id, wallet_id, currency),
        CONSTRAINT ck_wallet_ledger_entries_direction CHECK (direction IN ('DEBIT', 'CREDIT')),
        CONSTRAINT ck_wallet_ledger_entries_amount_positive CHECK (amount_minor > 0),
        CONSTRAINT ck_wallet_ledger_entries_balances_non_negative CHECK (balance_before_minor >= 0 AND balance_after_minor >= 0),
        CONSTRAINT ck_wallet_ledger_entries_arithmetic CHECK (
          (direction = 'DEBIT' AND balance_after_minor = balance_before_minor - amount_minor)
          OR (direction = 'CREDIT' AND balance_after_minor = balance_before_minor + amount_minor)
        ),
        CONSTRAINT ck_wallet_ledger_entries_currency_format CHECK (currency ~ '^[A-Z]{3}$')
      )
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION prevent_wallet_ledger_mutation()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only'
          USING ERRCODE = '55000';
      END;
      $$
    `);

    await queryRunner.query(`
      CREATE TRIGGER wallet_ledger_entries_append_only
      BEFORE UPDATE OR DELETE ON wallet_ledger_entries
      FOR EACH ROW EXECUTE FUNCTION prevent_wallet_ledger_mutation()
    `);

    await queryRunner.query(`
      CREATE TABLE inbox_messages (
        consumer_name VARCHAR(100) NOT NULL,
        message_id VARCHAR(255) NOT NULL,
        payload_hash CHAR(64) NOT NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        processed_at TIMESTAMPTZ,
        CONSTRAINT pk_inbox_messages PRIMARY KEY (consumer_name, message_id)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE outbox_messages (
        id UUID NOT NULL,
        aggregate_id UUID NOT NULL,
        event_type VARCHAR(100) NOT NULL,
        envelope JSONB NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ,
        published_at TIMESTAMPTZ,
        locked_by VARCHAR(255),
        locked_until TIMESTAMPTZ,
        CONSTRAINT pk_outbox_messages PRIMARY KEY (id),
        CONSTRAINT ck_outbox_messages_attempts_non_negative CHECK (attempts >= 0),
        CONSTRAINT ck_outbox_messages_published_lease CHECK (
          (published_at IS NOT NULL AND locked_by IS NULL AND locked_until IS NULL)
          OR published_at IS NULL
        ),
        CONSTRAINT ck_outbox_messages_lease_pair CHECK (
          (locked_by IS NULL AND locked_until IS NULL)
          OR (locked_by IS NOT NULL AND locked_until IS NOT NULL)
        )
      )
    `);

    await queryRunner.query(`
      CREATE INDEX idx_outbox_messages_pending_due
        ON outbox_messages (next_attempt_at, occurred_at, id)
        WHERE published_at IS NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE outbox_messages');
    await queryRunner.query('DROP TABLE inbox_messages');
    await queryRunner.query(
      'DROP TRIGGER wallet_ledger_entries_append_only ON wallet_ledger_entries',
    );
    await queryRunner.query('DROP TABLE wallet_ledger_entries');
    await queryRunner.query('DROP TABLE wager_transactions');
    await queryRunner.query('DROP INDEX idx_wallets_player_id');
    await queryRunner.query('DROP TABLE wallets');
    await queryRunner.query('DROP FUNCTION prevent_wallet_ledger_mutation()');
  }
}
