import { describe, expect, test } from 'bun:test';

import type { FinancialUnitOfWorkPort } from '../../../src/modules/wagering/application/ports';
import {
  DependencyUnavailableError,
  Money,
  Wallet,
  WalletNotFoundError,
} from '../../../src/modules/wagering/domain';
import {
  ReconcileWalletUseCase,
  WalletReconciliationMetrics,
} from '../../../src/modules/wallet/application';

const walletId = '0192f291-27dd-7d3f-8071-5f8685deef37';
const playerId = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';

function unitOfWork(
  wallet: Wallet | null,
  calculatedBalanceMinor: bigint,
  checkedEntries: number,
): FinancialUnitOfWorkPort {
  const value = {
    wallets: {
      findById: () => Promise.resolve(wallet),
    },
    ledger: {
      summarizeWalletBalance: () => Promise.resolve({ calculatedBalanceMinor, checkedEntries }),
    },
    repeatableRead: <T>(callback: (transactional: FinancialUnitOfWorkPort) => Promise<T>) =>
      callback(value as unknown as FinancialUnitOfWorkPort),
  };

  return value as unknown as FinancialUnitOfWorkPort;
}

function rehydratedWallet(amount: string): Wallet {
  const now = new Date('2026-09-01T12:00:00.000Z');
  return Wallet.rehydrate({
    id: walletId,
    playerId,
    currency: 'BRL',
    balance: Money.from({ amount, currency: 'BRL' }),
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
}

describe('ReconcileWalletUseCase', () => {
  test('returns deterministic string money for an empty ledger', async () => {
    const metrics = new WalletReconciliationMetrics();
    const useCase = new ReconcileWalletUseCase(
      unitOfWork(rehydratedWallet('0.00'), 0n, 0),
      metrics,
    );

    const reconciliation = await useCase.execute(walletId);
    expect(reconciliation).toEqual({
      walletId,
      storedBalance: { amount: '0.00', currency: 'BRL' },
      calculatedBalance: { amount: '0.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 0,
    });
    expect(metrics.snapshot()).toEqual({ checks: 1, divergences: 0 });
  });

  test('reports a signed difference and increments the divergence metric without writing', async () => {
    const metrics = new WalletReconciliationMetrics();
    const useCase = new ReconcileWalletUseCase(
      unitOfWork(rehydratedWallet('88.00'), 8500n, 3),
      metrics,
    );

    const reconciliation = await useCase.execute(walletId);
    expect(reconciliation).toMatchObject({
      storedBalance: { amount: '88.00', currency: 'BRL' },
      calculatedBalance: { amount: '85.00', currency: 'BRL' },
      difference: { amount: '3.00', currency: 'BRL' },
      consistent: false,
      checkedEntries: 3,
    });
    expect(metrics.snapshot()).toEqual({ checks: 1, divergences: 1 });
  });

  test('preserves the wallet-not-found contract', async () => {
    const useCase = new ReconcileWalletUseCase(
      unitOfWork(null, 0n, 0),
      new WalletReconciliationMetrics(),
    );

    let failure: unknown;
    try {
      await useCase.execute(walletId);
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(WalletNotFoundError);
  });

  test('normalizes a transient PostgreSQL failure to the documented retryable contract', async () => {
    const transientUnitOfWork = {
      repeatableRead: () =>
        Promise.reject(Object.assign(new Error('lock timeout'), { code: '55P03' })),
    } as unknown as FinancialUnitOfWorkPort;
    const useCase = new ReconcileWalletUseCase(
      transientUnitOfWork,
      new WalletReconciliationMetrics(),
    );

    let failure: unknown;
    try {
      await useCase.execute(walletId);
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(DependencyUnavailableError);
  });
});
