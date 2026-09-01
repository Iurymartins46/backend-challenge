import { type EntityManager, type Repository } from 'typeorm';

import type { WalletLedgerRepositoryPort } from '../../../modules/wagering/application/ports';
import type { WalletLedgerEntry } from '../../../modules/wagering/domain/ledger';
import { WalletLedgerEntryEntity } from '../entities/wallet-ledger-entry.entity';
import { WalletLedgerEntryMapper } from '../mappers/wallet-ledger-entry.mapper';

export class TypeOrmWalletLedgerRepository implements WalletLedgerRepositoryPort {
  private readonly repository: Repository<WalletLedgerEntryEntity>;

  constructor(private readonly manager: EntityManager) {
    this.repository = manager.getRepository(WalletLedgerEntryEntity);
  }

  async findById(id: string): Promise<WalletLedgerEntry | null> {
    const entity = await this.repository.findOne({ where: { id } });
    return entity === null ? null : WalletLedgerEntryMapper.toDomain(entity);
  }

  async findByTransactionId(transactionId: string): Promise<WalletLedgerEntry | null> {
    const entity = await this.repository.findOne({ where: { transactionId } });
    return entity === null ? null : WalletLedgerEntryMapper.toDomain(entity);
  }

  async findByWalletId(walletId: string): Promise<readonly WalletLedgerEntry[]> {
    const entities = await this.repository.find({
      where: { walletId },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
    return entities.map((entity) => WalletLedgerEntryMapper.toDomain(entity));
  }

  async insert(entry: WalletLedgerEntry): Promise<WalletLedgerEntry> {
    await this.repository.insert(WalletLedgerEntryMapper.toPersistence(entry));
    return entry;
  }

  async save(entry: WalletLedgerEntry): Promise<WalletLedgerEntry> {
    const entity = await this.repository.save(WalletLedgerEntryMapper.toPersistence(entry));
    return WalletLedgerEntryMapper.toDomain(entity);
  }
}
