import { Check, Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity({ name: 'outbox_messages' })
@Index('idx_outbox_messages_pending_due', ['nextAttemptAt', 'occurredAt', 'id'], {
  where: '"published_at" IS NULL',
})
@Check('ck_outbox_messages_attempts_non_negative', '"attempts" >= 0')
@Check(
  'ck_outbox_messages_published_lease',
  '("published_at" IS NOT NULL AND "locked_by" IS NULL AND "locked_until" IS NULL) OR ("published_at" IS NULL)',
)
export class OutboxMessageEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'uuid', name: 'aggregate_id' })
  aggregateId!: string;

  @Column({ type: 'varchar', name: 'event_type', length: 100 })
  eventType!: string;

  @Column({ type: 'jsonb' })
  envelope!: Record<string, unknown>;

  @Column({ type: 'timestamptz', name: 'occurred_at' })
  occurredAt!: Date;

  @Column({ type: 'integer', default: 0 })
  attempts!: number;

  @Column({ type: 'timestamptz', name: 'next_attempt_at', nullable: true })
  nextAttemptAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'published_at', nullable: true })
  publishedAt!: Date | null;

  @Column({ type: 'varchar', name: 'locked_by', length: 255, nullable: true })
  lockedBy!: string | null;

  @Column({ type: 'timestamptz', name: 'locked_until', nullable: true })
  lockedUntil!: Date | null;
}
