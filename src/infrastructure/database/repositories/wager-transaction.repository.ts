import { type EntityManager, type Repository } from 'typeorm';

import type {
  PendingReferenceClaim,
  PendingReferenceClaimInput,
  PendingReferenceLeaseMutationInput,
  PendingReferenceMetrics,
  PendingReferenceRetryInput,
  WagerTransactionRepositoryPort,
} from '../../../modules/wagering/application/ports';
import {
  WagerTransactionStatus,
  type WagerTransactionKind,
  type WagerTransaction,
} from '../../../modules/wagering/domain/wager-transaction';
import { DomainInvariantError } from '../../../modules/wagering/domain/errors';
import { WagerTransactionEntity } from '../entities/wager-transaction.entity';
import { WagerTransactionMapper } from '../mappers/wager-transaction.mapper';

export class TypeOrmWagerTransactionRepository implements WagerTransactionRepositoryPort {
  private readonly repository: Repository<WagerTransactionEntity>;

  constructor(private readonly manager: EntityManager) {
    this.repository = manager.getRepository(WagerTransactionEntity);
  }

  async findById(id: string): Promise<WagerTransaction | null> {
    const entity = await this.repository.findOne({ where: { id } });
    return entity === null ? null : WagerTransactionMapper.toDomain(entity);
  }

  async findByProviderAndExternalTransactionId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    const entity = await this.repository.findOne({
      where: { providerId, externalTransactionId },
    });
    return entity === null ? null : WagerTransactionMapper.toDomain(entity);
  }

  async findByProviderAndIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
  ): Promise<WagerTransaction | null> {
    const entity = await this.repository.findOne({ where: { providerId, idempotencyKey } });
    return entity === null ? null : WagerTransactionMapper.toDomain(entity);
  }

  async findProcessedReversal(
    referenceTransactionId: string,
    kind: WagerTransactionKind.Refund | WagerTransactionKind.Rollback,
  ): Promise<WagerTransaction | null> {
    const entity = await this.repository.findOne({
      where: {
        referenceTransactionId,
        kind,
        status: WagerTransactionStatus.Processed,
      },
    });
    return entity === null ? null : WagerTransactionMapper.toDomain(entity);
  }

  async insert(transaction: WagerTransaction): Promise<WagerTransaction> {
    await this.repository.insert(WagerTransactionMapper.toPersistence(transaction));
    return transaction;
  }

  async insertIfAbsent(transaction: WagerTransaction): Promise<boolean> {
    const result = await this.repository
      .createQueryBuilder()
      .insert()
      .values(WagerTransactionMapper.toPersistence(transaction))
      .orIgnore()
      .returning(['id'])
      .execute();

    return result.identifiers.length > 0;
  }

  async save(transaction: WagerTransaction): Promise<WagerTransaction> {
    const entity = await this.repository.save(WagerTransactionMapper.toPersistence(transaction));
    return WagerTransactionMapper.toDomain(entity);
  }

  async claimPendingReferenceDue(
    input: PendingReferenceClaimInput,
  ): Promise<readonly PendingReferenceClaim[]> {
    assertPendingReferenceClaimInput(input);

    const result = await this.manager.query<unknown>(
      `WITH claimable AS (
         SELECT id
         FROM wager_transactions
         WHERE status = 'PENDING_REFERENCE'
           AND next_reference_attempt_at <= $1
           AND (reference_locked_until IS NULL OR reference_locked_until <= $1)
         ORDER BY next_reference_attempt_at, created_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT $2
       )
       UPDATE wager_transactions AS transaction
       SET reference_attempts = transaction.reference_attempts + 1,
           reference_locked_by = $3,
           reference_locked_until = $4
       FROM claimable
       WHERE transaction.id = claimable.id
       RETURNING transaction.id, transaction.reference_attempts AS "attempts"`,
      [input.now, input.limit, input.owner, input.leaseUntil],
    );

    return Promise.all(
      returningRows<PendingReferenceClaimRow>(result).map(async (row) => {
        const transaction = await this.findById(row.id);
        if (transaction === null) {
          throw new DomainInvariantError('A claimed pending reference could not be reloaded.');
        }

        return { transaction, attempts: row.attempts };
      }),
    );
  }

  async schedulePendingReferenceRetryIfOwned(input: PendingReferenceRetryInput): Promise<boolean> {
    const nextAttemptAt = input.transaction.nextReferenceAttemptAt;
    if (nextAttemptAt === undefined) {
      throw new DomainInvariantError('A pending-reference retry requires a next attempt date.');
    }
    assertPendingReferenceLeaseMutation(input.transaction.id, input.owner, input.now);

    const result = await this.manager.query<unknown>(
      `UPDATE wager_transactions
       SET next_reference_attempt_at = $2,
           reference_locked_by = NULL,
           reference_locked_until = NULL
       WHERE id = $1
         AND status = 'PENDING_REFERENCE'
         AND reference_locked_by = $3
         AND reference_locked_until > $4
       RETURNING id`,
      [input.transaction.id, nextAttemptAt, input.owner, input.now],
    );

    return returningRows<{ id: string }>(result).length === 1;
  }

  async releasePendingReferenceClaimIfOwned(
    input: PendingReferenceLeaseMutationInput,
  ): Promise<boolean> {
    assertPendingReferenceLeaseMutation(input.transactionId, input.owner, input.now);
    const result = await this.manager.query<unknown>(
      `UPDATE wager_transactions
       SET reference_locked_by = NULL,
           reference_locked_until = NULL
       WHERE id = $1
         AND reference_locked_by = $2
         AND reference_locked_until > $3
       RETURNING id`,
      [input.transactionId, input.owner, input.now],
    );
    return returningRows<{ id: string }>(result).length === 1;
  }

  async measurePendingReferences(now: Date): Promise<PendingReferenceMetrics> {
    assertValidDate(now, 'Pending-reference metrics date');
    const rows = await this.manager.query<Array<PendingReferenceMetricRow>>(
      `SELECT
         COUNT(*)::text AS "pendingCount",
         COALESCE(SUM(reference_attempts), 0)::text AS attempts
       FROM wager_transactions
       WHERE status = 'PENDING_REFERENCE'`,
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error('Pending-reference metrics query returned no row.');
    }

    return { pendingCount: Number(row.pendingCount), attempts: Number(row.attempts) };
  }
}

interface PendingReferenceClaimRow {
  readonly id: string;
  readonly attempts: number;
}

interface PendingReferenceMetricRow {
  readonly pendingCount: string;
  readonly attempts: string;
}

function returningRows<T>(result: unknown): T[] {
  if (!Array.isArray(result)) {
    throw new Error('Pending-reference mutation query returned an invalid result.');
  }

  if (result.length === 2 && Array.isArray(result[0]) && typeof result[1] === 'number') {
    return result[0] as T[];
  }

  return result as T[];
}

function assertPendingReferenceClaimInput(input: PendingReferenceClaimInput): void {
  assertValidDate(input.now, 'Pending-reference claim date');
  assertValidDate(input.leaseUntil, 'Pending-reference lease date');
  if (input.leaseUntil.getTime() <= input.now.getTime()) {
    throw new DomainInvariantError('Pending-reference lease must expire after the claim date.');
  }
  if (!Number.isInteger(input.limit) || input.limit < 1) {
    throw new DomainInvariantError('Pending-reference claim limit must be a positive integer.');
  }
  assertPendingReferenceLeaseMutation('pending-reference-claim', input.owner, input.now);
}

function assertPendingReferenceLeaseMutation(id: string, owner: string, now: Date): void {
  assertValidDate(now, 'Pending-reference lease mutation date');
  if (id.trim().length === 0) {
    throw new DomainInvariantError('Pending-reference transaction id must not be empty.');
  }
  if (owner.trim().length === 0) {
    throw new DomainInvariantError('Pending-reference lease owner must not be empty.');
  }
}

function assertValidDate(value: Date, field: string): void {
  if (Number.isNaN(value.getTime())) {
    throw new DomainInvariantError(`${field} must be valid.`);
  }
}
