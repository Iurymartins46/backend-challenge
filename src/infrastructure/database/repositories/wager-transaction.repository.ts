import { type EntityManager, type Repository } from 'typeorm';

import type { WagerTransactionRepositoryPort } from '../../../modules/wagering/application/ports';
import {
  WagerTransactionStatus,
  type WagerTransactionKind,
  type WagerTransaction,
} from '../../../modules/wagering/domain/wager-transaction';
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
}
