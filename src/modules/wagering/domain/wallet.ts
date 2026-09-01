import {
  DomainInvariantError,
  InsufficientFundsError,
  MoneyCurrencyMismatchError,
  ReversalNegativeBalanceError,
} from './errors';
import { LedgerDirection } from './ledger';
import type { Money } from './money';

export interface WalletState {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly balance: Money;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface WalletBalanceChange {
  readonly walletId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly walletVersion: number;
  readonly occurredAt: Date;
}

export interface OpenWalletProps {
  readonly id: string;
  readonly playerId: string;
  readonly initialBalance: Money;
  readonly createdAt?: Date;
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new DomainInvariantError(`${field} must not be empty.`);
  }
}

function cloneDate(date: Date): Date {
  if (Number.isNaN(date.getTime())) {
    throw new DomainInvariantError('Wallet date must be valid.');
  }

  return new Date(date.getTime());
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): Wallet {
    assertNonEmpty(props.id, 'Wallet id');
    assertNonEmpty(props.playerId, 'Player id');

    if (props.initialBalance.isNegative()) {
      throw new DomainInvariantError('Wallet initial balance cannot be negative.');
    }

    const createdAt = cloneDate(props.createdAt ?? new Date());
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      createdAt,
      new Date(createdAt.getTime()),
    );
  }

  /** Rebuilds persisted state without replaying historical balance changes. */
  static rehydrate(state: WalletState): Wallet {
    assertNonEmpty(state.id, 'Wallet id');
    assertNonEmpty(state.playerId, 'Player id');

    if (!Number.isInteger(state.version) || state.version < 1) {
      throw new DomainInvariantError('Wallet version must be a positive integer.');
    }

    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      cloneDate(state.createdAt),
      cloneDate(state.updatedAt),
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return new Date(this._updatedAt.getTime());
  }

  debit(money: Money, at: Date = new Date()): WalletBalanceChange {
    return this.debitWithFailure(money, at, new InsufficientFundsError());
  }

  debitForReversal(money: Money, at: Date = new Date()): WalletBalanceChange {
    return this.debitWithFailure(money, at, new ReversalNegativeBalanceError());
  }

  private debitWithFailure(
    money: Money,
    at: Date,
    insufficientFundsError: InsufficientFundsError | ReversalNegativeBalanceError,
  ): WalletBalanceChange {
    this.assertPositiveSameCurrency(money);
    const balanceBefore = this._balance;
    const balanceAfter = balanceBefore.subtract(money);

    if (balanceAfter.isNegative()) {
      throw insufficientFundsError;
    }

    return this.applyChange(LedgerDirection.Debit, money, balanceBefore, balanceAfter, at);
  }

  credit(money: Money, at: Date = new Date()): WalletBalanceChange {
    this.assertPositiveSameCurrency(money);
    const balanceBefore = this._balance;
    const balanceAfter = balanceBefore.add(money);

    return this.applyChange(LedgerDirection.Credit, money, balanceBefore, balanceAfter, at);
  }

  private applyChange(
    direction: LedgerDirection,
    money: Money,
    balanceBefore: Money,
    balanceAfter: Money,
    at: Date,
  ): WalletBalanceChange {
    const occurredAt = cloneDate(at);
    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = occurredAt;

    return {
      walletId: this.id,
      direction,
      money,
      balanceBefore,
      balanceAfter,
      walletVersion: this._version,
      occurredAt: new Date(occurredAt.getTime()),
    };
  }

  private assertPositiveSameCurrency(money: Money): void {
    if (this.currency !== money.currency) {
      throw new MoneyCurrencyMismatchError(this.currency, money.currency);
    }

    if (!money.isPositive()) {
      throw new DomainInvariantError('Wallet movements must be positive.');
    }
  }
}
