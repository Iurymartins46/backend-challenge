import { QueryFailedError, type EntityManager, type Repository } from 'typeorm';

import type { WalletRepositoryPort } from '../../../modules/wagering/application/ports';
import { WalletAlreadyExistsError, type Wallet } from '../../../modules/wagering/domain';
import { WalletEntity } from '../entities/wallet.entity';
import { WalletMapper } from '../mappers/wallet.mapper';
import { withTelemetrySpan } from '../../telemetry';

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
    return withTelemetrySpan(
      'wallet.lock',
      { 'wallet.id': id, 'db.lock.mode': 'pessimistic-write' },
      async () => {
        const entity = await this.repository
          .createQueryBuilder('wallet')
          .where('wallet.id = :id', { id })
          .setLock('pessimistic_write')
          .getOne();
        return entity === null ? null : WalletMapper.toDomain(entity);
      },
    );
  }

  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null> {
    const entity = await this.repository.findOne({ where: { playerId, currency } });
    return entity === null ? null : WalletMapper.toDomain(entity);
  }

  async insert(wallet: Wallet): Promise<Wallet> {
    try {
      await this.repository.insert(WalletMapper.toPersistence(wallet));
    } catch (error: unknown) {
      if (isPlayerCurrencyUniqueViolation(error)) {
        throw new WalletAlreadyExistsError();
      }

      throw error;
    }

    return wallet;
  }

  async save(wallet: Wallet): Promise<Wallet> {
    const entity = await this.repository.save(WalletMapper.toPersistence(wallet));
    return WalletMapper.toDomain(entity);
  }
}

function isPlayerCurrencyUniqueViolation(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) {
    return false;
  }

  const driverError = error.driverError as { code?: unknown; constraint?: unknown };
  return driverError.code === '23505' && driverError.constraint === 'uq_wallets_player_currency';
}
