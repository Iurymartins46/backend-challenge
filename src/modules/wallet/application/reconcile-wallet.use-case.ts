import { Logger } from '@nestjs/common';

import { isTransientFinancialError } from '../../wagering/application/process-wager-transaction.use-case';
import type { FinancialUnitOfWorkPort } from '../../wagering/application/ports';
import { DependencyUnavailableError, Money, WalletNotFoundError } from '../../wagering/domain';
import type { WalletReconciliationMetrics } from './wallet-reconciliation.metrics';
import type { WalletReconciliationView } from './wallet.types';

export class ReconcileWalletUseCase {
  private readonly logger = new Logger(ReconcileWalletUseCase.name);

  constructor(
    private readonly unitOfWork: FinancialUnitOfWorkPort,
    private readonly metrics: WalletReconciliationMetrics,
  ) {}

  async execute(walletId: string): Promise<WalletReconciliationView> {
    let reconciliation: WalletReconciliationView;
    try {
      reconciliation = await this.unitOfWork.repeatableRead(async (unitOfWork) => {
        const wallet = await unitOfWork.wallets.findById(walletId);
        if (wallet === null) {
          throw new WalletNotFoundError();
        }

        const summary = await unitOfWork.ledger.summarizeWalletBalance(walletId);
        const calculatedBalance = Money.fromMinorUnits(
          summary.calculatedBalanceMinor,
          wallet.currency,
        );
        const difference = wallet.balance.subtract(calculatedBalance);

        return {
          walletId,
          storedBalance: wallet.balance.toJSON(),
          calculatedBalance: calculatedBalance.toJSON(),
          difference: difference.toJSON(),
          consistent: difference.isZero(),
          checkedEntries: summary.checkedEntries,
        };
      });
    } catch (error: unknown) {
      if (isTransientFinancialError(error)) {
        throw new DependencyUnavailableError();
      }

      throw error;
    }

    this.metrics.increment('checks');
    if (!reconciliation.consistent) {
      this.metrics.increment('divergences');
      this.logger.error(
        `Wallet reconciliation divergence detected for wallet ${walletId} after ${reconciliation.checkedEntries} ledger entries.`,
      );
    }

    return reconciliation;
  }
}
