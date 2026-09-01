import { Money } from '../../../modules/wagering/domain/money';
import { WalletLedgerEntry, type LedgerDirection } from '../../../modules/wagering/domain/ledger';
import { WalletLedgerEntryEntity } from '../entities/wallet-ledger-entry.entity';

export class WalletLedgerEntryMapper {
  static toPersistence(entry: WalletLedgerEntry): WalletLedgerEntryEntity {
    const entity = new WalletLedgerEntryEntity();
    entity.id = entry.id;
    entity.walletId = entry.walletId;
    entity.transactionId = entry.transactionId;
    entity.direction = entry.direction;
    entity.amountMinor = entry.money.toMinorUnits().toString();
    entity.currency = entry.money.currency;
    entity.balanceBeforeMinor = entry.balanceBefore.toMinorUnits().toString();
    entity.balanceAfterMinor = entry.balanceAfter.toMinorUnits().toString();
    entity.createdAt = new Date(entry.createdAt.getTime());
    return entity;
  }

  static toDomain(entity: WalletLedgerEntryEntity): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({
      id: entity.id,
      walletId: entity.walletId,
      transactionId: entity.transactionId,
      direction: entity.direction as LedgerDirection,
      money: Money.rehydrate({
        minorUnits: BigInt(entity.amountMinor),
        currency: entity.currency,
      }),
      balanceBefore: Money.rehydrate({
        minorUnits: BigInt(entity.balanceBeforeMinor),
        currency: entity.currency,
      }),
      balanceAfter: Money.rehydrate({
        minorUnits: BigInt(entity.balanceAfterMinor),
        currency: entity.currency,
      }),
      createdAt: new Date(entity.createdAt.getTime()),
    });
  }
}
