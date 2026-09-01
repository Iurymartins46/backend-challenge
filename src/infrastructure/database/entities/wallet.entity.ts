import { Check, Column, Entity, Index, PrimaryColumn, Unique } from 'typeorm';

@Entity({ name: 'wallets' })
@Unique('uq_wallets_player_currency', ['playerId', 'currency'])
@Unique('uq_wallets_id_currency', ['id', 'currency'])
@Unique('uq_wallets_id_player_currency', ['id', 'playerId', 'currency'])
@Index('idx_wallets_player_id', ['playerId'])
@Check('ck_wallets_balance_non_negative', '"balance_minor" >= 0')
@Check('ck_wallets_version_positive', '"version" >= 1')
@Check('ck_wallets_currency_format', '"currency" ~ \'^[A-Z]{3}$\'')
export class WalletEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'uuid', name: 'player_id' })
  playerId!: string;

  @Column({ type: 'char', length: 3 })
  currency!: string;

  /** PostgreSQL BIGINT is deliberately kept as a string at the ORM boundary. */
  @Column({ type: 'bigint', name: 'balance_minor' })
  balanceMinor!: string;

  @Column({ type: 'integer' })
  version!: number;

  @Column({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
