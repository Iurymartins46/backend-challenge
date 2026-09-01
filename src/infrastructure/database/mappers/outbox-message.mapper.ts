import { OutboxMessage } from '../../../modules/wagering/domain/outbox';
import { OutboxMessageEntity } from '../entities/outbox-message.entity';

export class OutboxMessageMapper {
  static toPersistence(message: OutboxMessage): OutboxMessageEntity {
    const entity = new OutboxMessageEntity();
    entity.id = message.id;
    entity.aggregateId = message.aggregateId;
    entity.eventType = message.eventType;
    entity.envelope = { ...message.payload };
    entity.occurredAt = new Date(message.occurredAt.getTime());
    entity.attempts = message.attempts;
    entity.nextAttemptAt = message.nextAttemptAt ?? null;
    entity.publishedAt = message.publishedAt ?? null;
    entity.lockedBy = message.lockedBy ?? null;
    entity.lockedUntil = message.lockedUntil ?? null;
    return entity;
  }

  static toDomain(entity: OutboxMessageEntity): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: entity.id,
      aggregateId: entity.aggregateId,
      eventType: entity.eventType,
      payload: { ...entity.envelope },
      occurredAt: new Date(entity.occurredAt.getTime()),
      attempts: entity.attempts,
      nextAttemptAt:
        entity.nextAttemptAt === null ? undefined : new Date(entity.nextAttemptAt.getTime()),
      publishedAt: entity.publishedAt === null ? undefined : new Date(entity.publishedAt.getTime()),
      lockedBy: entity.lockedBy ?? undefined,
      lockedUntil: entity.lockedUntil === null ? undefined : new Date(entity.lockedUntil.getTime()),
    });
  }
}
