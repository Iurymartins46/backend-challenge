import { type EntityManager, type Repository } from 'typeorm';

import type { WagerTransactionRepositoryPort } from '../../../modules/wagering/application/ports';
import type { WagerTransaction } from '../../../modules/wagering/domain/wager-transaction';
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

  async insert(transaction: WagerTransaction): Promise<WagerTransaction> {
    await this.repository.insert(WagerTransactionMapper.toPersistence(transaction));
    return transaction;
  }

  async save(transaction: WagerTransaction): Promise<WagerTransaction> {
    const entity = await this.repository.save(WagerTransactionMapper.toPersistence(transaction));
    return WagerTransactionMapper.toDomain(entity);
  }
}
