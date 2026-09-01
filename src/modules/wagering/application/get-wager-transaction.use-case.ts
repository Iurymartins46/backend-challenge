import { WagerTransactionNotFoundError } from '../domain';
import type { FinancialUnitOfWorkPort } from './ports';
import { toWagerTransactionView, type WagerTransactionView } from './transaction.types';

export class GetWagerTransactionUseCase {
  constructor(private readonly unitOfWork: FinancialUnitOfWorkPort) {}

  async byId(transactionId: string): Promise<WagerTransactionView> {
    const transaction = await this.unitOfWork.transactions.findById(transactionId);
    if (transaction === null) {
      throw new WagerTransactionNotFoundError();
    }

    return toWagerTransactionView(transaction);
  }

  async byProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionView> {
    const transaction = await this.unitOfWork.transactions.findByProviderAndExternalTransactionId(
      providerId,
      externalTransactionId,
    );
    if (transaction === null) {
      throw new WagerTransactionNotFoundError();
    }

    return toWagerTransactionView(transaction);
  }
}
