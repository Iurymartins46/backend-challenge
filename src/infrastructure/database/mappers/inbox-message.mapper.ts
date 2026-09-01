import { InboxMessage } from '../../../modules/wagering/domain/inbox';
import { InboxMessageEntity } from '../entities/inbox-message.entity';

export class InboxMessageMapper {
  static toPersistence(message: InboxMessage): InboxMessageEntity {
    const entity = new InboxMessageEntity();
    entity.consumerName = message.consumerName;
    entity.messageId = message.messageId;
    entity.payloadHash = message.payloadHash;
    entity.receivedAt = new Date(message.receivedAt.getTime());
    entity.processedAt = message.processedAt ?? null;
    return entity;
  }

  static toDomain(entity: InboxMessageEntity): InboxMessage {
    return InboxMessage.rehydrate({
      messageId: entity.messageId,
      consumerName: entity.consumerName,
      payloadHash: entity.payloadHash,
      receivedAt: new Date(entity.receivedAt.getTime()),
      processedAt: entity.processedAt === null ? undefined : new Date(entity.processedAt.getTime()),
    });
  }
}
