import { DomainInvariantError, MoneyCurrencyMismatchError } from './errors';
import type { Money } from './money';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface CreateLedgerEntryProps {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly createdAt: Date;
}

export type LedgerEntryState = CreateLedgerEntryProps;

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new DomainInvariantError(`${field} must not be empty.`);
  }
}

function cloneDate(date: Date): Date {
  if (Number.isNaN(date.getTime())) {
    throw new DomainInvariantError('Ledger entry date must be valid.');
  }

  return new Date(date.getTime());
}

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    assertNonEmpty(props.id, 'Ledger entry id');
    assertNonEmpty(props.walletId, 'Wallet id');
    assertNonEmpty(props.transactionId, 'Transaction id');

    if (!Object.values(LedgerDirection).includes(props.direction)) {
      throw new DomainInvariantError(`Unknown ledger direction: ${String(props.direction)}.`);
    }

    if (!props.money.isPositive()) {
      throw new DomainInvariantError('Ledger amount must be positive.');
    }

    if (props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
      throw new DomainInvariantError('Ledger balances cannot be negative.');
    }

    const expectedBalance =
      props.direction === LedgerDirection.Debit
        ? props.balanceBefore.subtract(props.money)
        : props.balanceBefore.add(props.money);

    if (!expectedBalance.equals(props.balanceAfter)) {
      throw new DomainInvariantError('Ledger entry arithmetic is not balanced.');
    }

    return new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      cloneDate(props.createdAt),
    );
  }

  /** Rebuilds persisted state without reapplying a historical transition. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      cloneDate(state.createdAt),
    );
  }

  isBalanced(): boolean {
    try {
      const expectedBalance =
        this.direction === LedgerDirection.Debit
          ? this.balanceBefore.subtract(this.money)
          : this.balanceBefore.add(this.money);

      return (
        this.money.isPositive() &&
        !this.balanceBefore.isNegative() &&
        !this.balanceAfter.isNegative() &&
        expectedBalance.equals(this.balanceAfter)
      );
    } catch (error) {
      if (error instanceof MoneyCurrencyMismatchError) {
        return false;
      }

      throw error;
    }
  }
}
