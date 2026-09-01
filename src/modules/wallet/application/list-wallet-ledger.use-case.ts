import type { FinancialUnitOfWorkPort } from '../../wagering/application/ports';
import { WalletNotFoundError } from '../../wagering/domain';
import { encodeLedgerCursor } from './ledger-cursor';
import type {
  ListWalletLedgerInput,
  WalletLedgerEntryView,
  WalletLedgerPageView,
} from './wallet.types';

export class ListWalletLedgerUseCase {
  constructor(private readonly unitOfWork: FinancialUnitOfWorkPort) {}

  async execute(input: ListWalletLedgerInput): Promise<WalletLedgerPageView> {
    const page = await this.unitOfWork.transaction(async (unitOfWork) => {
      const wallet = await unitOfWork.wallets.findById(input.walletId);
      if (wallet === null) {
        throw new WalletNotFoundError();
      }

      return unitOfWork.ledger.findByWalletIdPage(input.walletId, {
        after: input.after,
        limit: input.limit,
      });
    });

    const entries = page.entries.map(toLedgerEntryView);
    const lastEntry = page.entries[page.entries.length - 1];

    return {
      walletId: input.walletId,
      entries,
      nextCursor:
        page.hasMore && lastEntry !== undefined
          ? encodeLedgerCursor({ createdAt: lastEntry.createdAt, id: lastEntry.id })
          : null,
    };
  }
}

function toLedgerEntryView(entry: {
  readonly id: string;
  readonly transactionId: string;
  readonly direction: WalletLedgerEntryView['direction'];
  readonly money: { toJSON(): WalletLedgerEntryView['money'] };
  readonly balanceBefore: { toJSON(): WalletLedgerEntryView['balanceBefore'] };
  readonly balanceAfter: { toJSON(): WalletLedgerEntryView['balanceAfter'] };
  readonly createdAt: Date;
}): WalletLedgerEntryView {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    createdAt: entry.createdAt.toISOString(),
  };
}
