import type { FinancialUnitOfWorkPort } from '../../wagering/application/ports';
import { WalletNotFoundError } from '../../wagering/domain';
import { toWalletView } from './create-wallet.use-case';
import type { WalletView } from './wallet.types';

export class GetWalletUseCase {
  constructor(private readonly unitOfWork: FinancialUnitOfWorkPort) {}

  async execute(walletId: string): Promise<WalletView> {
    const wallet = await this.unitOfWork.wallets.findById(walletId);
    if (wallet === null) {
      throw new WalletNotFoundError();
    }

    return toWalletView(wallet);
  }
}
