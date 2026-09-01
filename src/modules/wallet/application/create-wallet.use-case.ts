import { createHash } from 'node:crypto';

import type { Clock, IdGenerator } from '../../wagering/domain';
import {
  LedgerDirection,
  Money,
  OutboxMessage,
  WagerTransaction,
  WagerTransactionKind,
  Wallet,
  WalletAlreadyExistsError,
  WalletBalanceChanged,
  WalletLedgerEntry,
} from '../../wagering/domain';
import type { FinancialUnitOfWorkPort } from '../../wagering/application/ports';
import type { CreateWalletInput, WalletView } from './wallet.types';

const OPENING_PROVIDER_ID = 'system';
const OPENING_ROUND_ID = 'wallet-opening';
const OPENING_GAME_ID = 'wallet-opening';

export class CreateWalletUseCase {
  constructor(
    private readonly unitOfWork: FinancialUnitOfWorkPort,
    private readonly idGenerator: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(input: CreateWalletInput): Promise<WalletView> {
    const initialBalance = Money.from(input.initialBalance);

    return this.unitOfWork.transaction(async (unitOfWork) => {
      const existingWallet = await unitOfWork.wallets.findByPlayerAndCurrency(
        input.playerId,
        initialBalance.currency,
      );
      if (existingWallet !== null) {
        throw new WalletAlreadyExistsError();
      }

      const createdAt = this.clock.now();
      const wallet = Wallet.open({
        id: this.idGenerator.next(),
        playerId: input.playerId,
        initialBalance,
        createdAt,
      });
      await unitOfWork.wallets.insert(wallet);

      if (initialBalance.isPositive()) {
        const opening = WagerTransaction.create({
          id: this.idGenerator.next(),
          providerId: OPENING_PROVIDER_ID,
          externalTransactionId: `opening:${wallet.id}`,
          idempotencyKey: `opening:${wallet.id}`,
          payloadHash: openingPayloadHash(wallet),
          walletId: wallet.id,
          playerId: wallet.playerId,
          roundId: OPENING_ROUND_ID,
          gameId: OPENING_GAME_ID,
          kind: WagerTransactionKind.Opening,
          money: initialBalance,
          createdAt,
        });
        opening.markProcessed(undefined, createdAt);
        opening.recordResultSnapshot(wallet.balance, wallet.version);
        await unitOfWork.transactions.insert(opening);

        const ledgerEntry = WalletLedgerEntry.create({
          id: this.idGenerator.next(),
          walletId: wallet.id,
          transactionId: opening.id,
          direction: LedgerDirection.Credit,
          money: initialBalance,
          balanceBefore: Money.zero(wallet.currency),
          balanceAfter: wallet.balance,
          createdAt,
        });
        await unitOfWork.ledger.insert(ledgerEntry);

        // OPENING is an internal wallet lifecycle transaction. Its one integration
        // event is the balance change; provider wager processing starts in Phase 6.
        const event = WalletBalanceChanged.from(wallet, ledgerEntry, {
          correlationId: input.correlationId?.trim() || wallet.id,
          causationId: opening.id,
          occurredAt: createdAt,
        });
        await unitOfWork.outbox.insert(OutboxMessage.enqueue(event));
      }

      return toWalletView(wallet);
    });
  }
}

function openingPayloadHash(wallet: Wallet): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        kind: WagerTransactionKind.Opening,
        walletId: wallet.id,
        playerId: wallet.playerId,
        money: wallet.balance.toJSON(),
      }),
    )
    .digest('hex');
}

export function toWalletView(wallet: Wallet): WalletView {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
  };
}
