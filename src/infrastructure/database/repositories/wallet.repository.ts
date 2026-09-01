import { type EntityManager, type Repository } from 'typeorm';

import type { WalletRepositoryPort } from '../../../modules/wagering/application/ports';
import type { Wallet } from '../../../modules/wagering/domain/wallet';
import { WalletEntity } from '../entities/wallet.entity';
import { WalletMapper } from '../mappers/wallet.mapper';

export class TypeOrmWalletRepository implements WalletRepositoryPort {
  private readonly repository: Repository<WalletEntity>;

  constructor(private readonly manager: EntityManager) {
    this.repository = manager.getRepository(WalletEntity);
  }

  async findById(id: string): Promise<Wallet | null> {
    const entity = await this.repository.findOne({ where: { id } });
    return entity === null ? null : WalletMapper.toDomain(entity);
  }

  async findByIdForUpdate(id: string): Promise<Wallet | null> {
    const entity = await this.repository
      .createQueryBuilder('wallet')
      .where('wallet.id = :id', { id })
      .setLock('pessimistic_write')
      .getOne();
    return entity === null ? null : WalletMapper.toDomain(entity);
  }

  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null> {
    const entity = await this.repository.findOne({ where: { playerId, currency } });
    return entity === null ? null : WalletMapper.toDomain(entity);
  }

  async insert(wallet: Wallet): Promise<Wallet> {
    await this.repository.insert(WalletMapper.toPersistence(wallet));
    return wallet;
  }

  async save(wallet: Wallet): Promise<Wallet> {
    const entity = await this.repository.save(WalletMapper.toPersistence(wallet));
    return WalletMapper.toDomain(entity);
  }
}
