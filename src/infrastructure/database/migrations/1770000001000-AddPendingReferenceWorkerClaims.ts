import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPendingReferenceWorkerClaims1770000001000 implements MigrationInterface {
  name = 'AddPendingReferenceWorkerClaims1770000001000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE wager_transactions
        ADD COLUMN reference_attempts INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN reference_locked_by VARCHAR(255),
        ADD COLUMN reference_locked_until TIMESTAMPTZ,
        ADD CONSTRAINT ck_wager_transactions_reference_attempts_non_negative
          CHECK (reference_attempts >= 0)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE wager_transactions
        DROP CONSTRAINT ck_wager_transactions_reference_attempts_non_negative,
        DROP COLUMN reference_locked_until,
        DROP COLUMN reference_locked_by,
        DROP COLUMN reference_attempts
    `);
  }
}
