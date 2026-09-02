import { type EntityManager, type QueryDeepPartialEntity, type Repository } from 'typeorm';

import type {
  OutboxClaimInput,
  OutboxLeaseMutationInput,
  OutboxMessageRepositoryPort,
  OutboxPendingMetrics,
  OutboxRetryMutationInput,
} from '../../../modules/wagering/application/ports';
import { DomainInvariantError } from '../../../modules/wagering/domain/errors';
import { OutboxMessage } from '../../../modules/wagering/domain/outbox';
import { OutboxMessageEntity } from '../entities/outbox-message.entity';
import { OutboxMessageMapper } from '../mappers/outbox-message.mapper';

interface OutboxMessageRow {
  readonly id: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly envelope: Record<string, unknown>;
  readonly occurredAt: Date | string;
  readonly attempts: number;
  readonly nextAttemptAt: Date | string | null;
  readonly publishedAt: Date | string | null;
  readonly lockedBy: string | null;
  readonly lockedUntil: Date | string | null;
}

interface OutboxMetricRow {
  readonly pendingCount: string;
  readonly lagMs: string;
}

export class TypeOrmOutboxMessageRepository implements OutboxMessageRepositoryPort {
  private readonly repository: Repository<OutboxMessageEntity>;

  constructor(private readonly manager: EntityManager) {
    this.repository = manager.getRepository(OutboxMessageEntity);
  }

  async findById(id: string): Promise<OutboxMessage | null> {
    const entity = await this.repository.findOne({ where: { id } });
    return entity === null ? null : OutboxMessageMapper.toDomain(entity);
  }

  async insert(message: OutboxMessage): Promise<OutboxMessage> {
    const entity = OutboxMessageMapper.toPersistence(message);
    await this.repository.insert(entity as unknown as QueryDeepPartialEntity<OutboxMessageEntity>);
    return message;
  }

  async save(message: OutboxMessage): Promise<OutboxMessage> {
    const entity = await this.repository.save(OutboxMessageMapper.toPersistence(message));
    return OutboxMessageMapper.toDomain(entity);
  }

  async claimDue(input: OutboxClaimInput): Promise<readonly OutboxMessage[]> {
    assertClaimInput(input);

    const result = await this.manager.query<unknown>(
      `WITH claimable AS (
         SELECT id
         FROM outbox_messages
         WHERE published_at IS NULL
           AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
           AND (locked_until IS NULL OR locked_until <= $1)
         ORDER BY COALESCE(next_attempt_at, occurred_at), occurred_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT $2
       )
       UPDATE outbox_messages AS outbox
       SET locked_by = $3,
           locked_until = $4
       FROM claimable
       WHERE outbox.id = claimable.id
       RETURNING
         outbox.id,
         outbox.aggregate_id AS "aggregateId",
         outbox.event_type AS "eventType",
         outbox.envelope,
         outbox.occurred_at AS "occurredAt",
         outbox.attempts,
         outbox.next_attempt_at AS "nextAttemptAt",
         outbox.published_at AS "publishedAt",
         outbox.locked_by AS "lockedBy",
         outbox.locked_until AS "lockedUntil"`,
      [input.now, input.limit, input.owner, input.leaseUntil],
    );

    return returningRows<OutboxMessageRow>(result).map(toDomain);
  }

  async markPublishedIfOwned(input: OutboxLeaseMutationInput): Promise<boolean> {
    assertLeaseMutationInput(input);

    const result = await this.manager.query<unknown>(
      `UPDATE outbox_messages
       SET published_at = $3,
           next_attempt_at = NULL,
           locked_by = NULL,
           locked_until = NULL
       WHERE id = $1
         AND published_at IS NULL
         AND locked_by = $2
         AND locked_until > $3
       RETURNING id`,
      [input.id, input.owner, input.now],
    );

    return returningRows<{ id: string }>(result).length === 1;
  }

  async saveRetryIfOwned(input: OutboxRetryMutationInput): Promise<boolean> {
    assertLeaseMutationInput({ id: input.message.id, owner: input.owner, now: input.now });
    const nextAttemptAt = input.message.nextAttemptAt;
    if (nextAttemptAt === undefined) {
      throw new DomainInvariantError('An outbox retry must have a next attempt date.');
    }

    const result = await this.manager.query<unknown>(
      `UPDATE outbox_messages
       SET attempts = $2,
           next_attempt_at = $3,
           locked_by = NULL,
           locked_until = NULL
       WHERE id = $1
         AND published_at IS NULL
         AND locked_by = $4
         AND locked_until > $5
       RETURNING id`,
      [input.message.id, input.message.attempts, nextAttemptAt, input.owner, input.now],
    );

    return returningRows<{ id: string }>(result).length === 1;
  }

  async measurePending(now: Date): Promise<OutboxPendingMetrics> {
    assertValidDate(now, 'Outbox metrics date');
    const rows = await this.manager.query<OutboxMetricRow[]>(
      `SELECT
         COUNT(*)::text AS "pendingCount",
         GREATEST(
           COALESCE(EXTRACT(EPOCH FROM ($1::timestamptz - MIN(occurred_at))) * 1000, 0),
           0
         )::text AS "lagMs"
       FROM outbox_messages
       WHERE published_at IS NULL`,
      [now],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error('Outbox metrics query returned no row.');
    }

    return {
      pendingCount: Number(row.pendingCount),
      lagMs: Number(row.lagMs),
    };
  }
}

function toDomain(row: OutboxMessageRow): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: row.id,
    aggregateId: row.aggregateId,
    eventType: row.eventType,
    payload: row.envelope,
    occurredAt: new Date(row.occurredAt),
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt === null ? undefined : new Date(row.nextAttemptAt),
    publishedAt: row.publishedAt === null ? undefined : new Date(row.publishedAt),
    lockedBy: row.lockedBy ?? undefined,
    lockedUntil: row.lockedUntil === null ? undefined : new Date(row.lockedUntil),
  });
}

function returningRows<T>(result: unknown): T[] {
  if (!Array.isArray(result)) {
    throw new Error('Outbox mutation query returned an invalid result.');
  }

  // TypeORM exposes PostgreSQL UPDATE ... RETURNING as [rows, rowCount].
  if (result.length === 2 && Array.isArray(result[0]) && typeof result[1] === 'number') {
    return result[0] as T[];
  }

  return result as T[];
}

function assertClaimInput(input: OutboxClaimInput): void {
  assertValidDate(input.now, 'Outbox claim date');
  assertValidDate(input.leaseUntil, 'Outbox lease date');
  if (input.leaseUntil.getTime() <= input.now.getTime()) {
    throw new DomainInvariantError('Outbox lease must expire after the claim date.');
  }
  if (!Number.isInteger(input.limit) || input.limit < 1) {
    throw new DomainInvariantError('Outbox claim limit must be a positive integer.');
  }
  assertOwner(input.owner);
}

function assertLeaseMutationInput(input: OutboxLeaseMutationInput): void {
  assertValidDate(input.now, 'Outbox lease mutation date');
  assertOwner(input.owner);
  if (input.id.trim().length === 0) {
    throw new DomainInvariantError('Outbox message id must not be empty.');
  }
}

function assertOwner(owner: string): void {
  if (owner.trim().length === 0) {
    throw new DomainInvariantError('Outbox lease owner must not be empty.');
  }
}

function assertValidDate(value: Date, field: string): void {
  if (Number.isNaN(value.getTime())) {
    throw new DomainInvariantError(`${field} must be valid.`);
  }
}
