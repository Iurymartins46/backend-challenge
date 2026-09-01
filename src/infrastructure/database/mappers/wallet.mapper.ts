import { Money } from '../../../modules/wagering/domain/money';
import { Wallet } from '../../../modules/wagering/domain/wallet';
import { WalletEntity } from '../entities/wallet.entity';

export class WalletMapper {
  static toPersistence(wallet: Wallet): WalletEntity {
    const entity = new WalletEntity();
    entity.id = wallet.id;
    entity.playerId = wallet.playerId;
    entity.currency = wallet.currency;
    entity.balanceMinor = wallet.balance.toMinorUnits().toString();
    entity.version = wallet.version;
    entity.createdAt = new Date(wallet.createdAt.getTime());
    entity.updatedAt = new Date(wallet.updatedAt.getTime());
    return entity;
  }

  static toDomain(entity: WalletEntity): Wallet {
    return Wallet.rehydrate({
      id: entity.id,
      playerId: entity.playerId,
      currency: entity.currency,
      balance: Money.rehydrate({
        minorUnits: BigInt(entity.balanceMinor),
        currency: entity.currency,
      }),
      version: entity.version,
      createdAt: new Date(entity.createdAt.getTime()),
      updatedAt: new Date(entity.updatedAt.getTime()),
    });
  }
}
