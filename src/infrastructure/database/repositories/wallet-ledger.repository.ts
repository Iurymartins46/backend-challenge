import { type EntityManager, type Repository } from 'typeorm';

import type {
  WalletLedgerBalanceSummary,
  WalletLedgerPage,
  WalletLedgerPageQuery,
  WalletLedgerRepositoryPort,
} from '../../../modules/wagering/application/ports';
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

  async findByWalletIdPage(
    walletId: string,
    query: WalletLedgerPageQuery,
  ): Promise<WalletLedgerPage> {
    const builder = this.repository
      .createQueryBuilder('ledger')
      .where('ledger.walletId = :walletId', { walletId })
      .orderBy('ledger.createdAt', 'ASC')
      .addOrderBy('ledger.id', 'ASC')
      .take(query.limit + 1);

    if (query.after !== undefined) {
      builder.andWhere('(ledger.createdAt, ledger.id) > (:afterCreatedAt, :afterId)', {
        afterCreatedAt: query.after.createdAt,
        afterId: query.after.id,
      });
    }

    const entities = await builder.getMany();
    const hasMore = entities.length > query.limit;
    const pageEntities = hasMore ? entities.slice(0, query.limit) : entities;

    return {
      entries: pageEntities.map((entity) => WalletLedgerEntryMapper.toDomain(entity)),
      hasMore,
    };
  }

  async summarizeWalletBalance(walletId: string): Promise<WalletLedgerBalanceSummary> {
    const row = await this.repository
      .createQueryBuilder('ledger')
      .select(
        `COALESCE(SUM(CASE WHEN ledger.direction = 'CREDIT' THEN ledger.amount_minor ELSE -ledger.amount_minor END), 0)::text`,
        'calculated_balance_minor',
      )
      .addSelect('COUNT(*)::text', 'checked_entries')
      .where('ledger.wallet_id = :walletId', { walletId })
      .getRawOne<{ calculated_balance_minor: string; checked_entries: string }>();

    if (row === undefined) {
      throw new Error('Wallet ledger summary query returned no row.');
    }

    const checkedEntries = Number(row.checked_entries);
    if (!Number.isSafeInteger(checkedEntries) || checkedEntries < 0) {
      throw new Error('Wallet ledger summary returned an invalid entry count.');
    }

    return {
      calculatedBalanceMinor: BigInt(row.calculated_balance_minor),
      checkedEntries,
    };
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
