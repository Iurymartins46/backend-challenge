import type { WalletLedgerCursorPosition } from '../../wagering/application/ports/financial-repositories';
import type { LedgerDirection } from '../../wagering/domain/ledger';
import type { MoneyProps } from '../../wagering/domain/money';

export interface CreateWalletInput {
  readonly playerId: string;
  readonly initialBalance: MoneyProps;
  readonly correlationId?: string;
}

export interface WalletView {
  readonly id: string;
  readonly playerId: string;
  readonly balance: MoneyProps;
  readonly version: number;
}

export interface WalletLedgerEntryView {
  readonly id: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: MoneyProps;
  readonly balanceBefore: MoneyProps;
  readonly balanceAfter: MoneyProps;
  readonly createdAt: string;
}

export interface WalletLedgerPageView {
  readonly walletId: string;
  readonly entries: WalletLedgerEntryView[];
  readonly nextCursor: string | null;
}

export interface ListWalletLedgerInput {
  readonly walletId: string;
  readonly after?: WalletLedgerCursorPosition;
  readonly limit: number;
}
