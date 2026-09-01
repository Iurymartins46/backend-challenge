import { type EntityManager, type QueryDeepPartialEntity, type Repository } from 'typeorm';

import type { OutboxMessageRepositoryPort } from '../../../modules/wagering/application/ports';
import type { OutboxMessage } from '../../../modules/wagering/domain/outbox';
import { OutboxMessageEntity } from '../entities/outbox-message.entity';
import { OutboxMessageMapper } from '../mappers/outbox-message.mapper';

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
}
