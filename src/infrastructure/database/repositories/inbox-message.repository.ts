import { type EntityManager, type Repository } from 'typeorm';

import type { InboxMessageRepositoryPort } from '../../../modules/wagering/application/ports';
import type { InboxMessage } from '../../../modules/wagering/domain/inbox';
import { InboxMessageEntity } from '../entities/inbox-message.entity';
import { InboxMessageMapper } from '../mappers/inbox-message.mapper';

export class TypeOrmInboxMessageRepository implements InboxMessageRepositoryPort {
  private readonly repository: Repository<InboxMessageEntity>;

  constructor(private readonly manager: EntityManager) {
    this.repository = manager.getRepository(InboxMessageEntity);
  }

  async findById(consumerName: string, messageId: string): Promise<InboxMessage | null> {
    const entity = await this.repository.findOne({ where: { consumerName, messageId } });
    return entity === null ? null : InboxMessageMapper.toDomain(entity);
  }

  async insert(message: InboxMessage): Promise<InboxMessage> {
    await this.repository.insert(InboxMessageMapper.toPersistence(message));
    return message;
  }

  async save(message: InboxMessage): Promise<InboxMessage> {
    const entity = await this.repository.save(InboxMessageMapper.toPersistence(message));
    return InboxMessageMapper.toDomain(entity);
  }
}
