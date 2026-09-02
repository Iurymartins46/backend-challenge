import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Module, StandardSchemaValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';

import { configuration } from '../../src/config/configuration';
import { validateEnvironment } from '../../src/config/environment';
import dataSource from '../../src/infrastructure/database/data-source';
import { FinancialUnitOfWork } from '../../src/infrastructure/database/financial-unit-of-work';
import { DatabaseModule } from '../../src/infrastructure/database/database.module';
import type { FinancialUnitOfWorkPort } from '../../src/modules/wagering/application/ports';
import {
  RandomIdGenerator,
  SystemClock,
  WagerTransactionKind,
} from '../../src/modules/wagering/domain';
import { ProcessWagerTransactionUseCase } from '../../src/modules/wagering/application';
import {
  ReconcileWalletUseCase,
  WalletReconciliationMetrics,
} from '../../src/modules/wallet/application';
import { WalletModule } from '../../src/modules/wallet/wallet.module';
import { WageringModule } from '../../src/modules/wagering/wagering.module';

const runRealIntegration = process.env.RUN_REAL_INTEGRATION_TESTS === 'true';
const integration = runRealIntegration ? describe : describe.skip;

let app: NestFastifyApplication | undefined;

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnvironment,
      load: [configuration],
    }),
    DatabaseModule,
    WalletModule,
    WageringModule,
  ],
})
class ReconciliationIntegrationModule {}

integration('wallet reconciliation', () => {
  beforeAll(async () => {
    await dataSource.initialize();
    await dataSource.runMigrations();

    const module = await Test.createTestingModule({
      imports: [ReconciliationIntegrationModule],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(new StandardSchemaValidationPipe({ transform: true }));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  });

  test('reconciles zero, opening and multiple operations through HTTP', async () => {
    if (app === undefined) {
      throw new Error('The HTTP application was not initialized.');
    }

    const zeroWallet = await createWallet(app, '0.00');
    const zero = await reconcile(app, zeroWallet.id);
    expect(zero).toEqual({
      walletId: zeroWallet.id,
      storedBalance: { amount: '0.00', currency: 'BRL' },
      calculatedBalance: { amount: '0.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 0,
    });

    const wallet = await createWallet(app, '100.00');
    await submitTransaction(app, wallet, 'BET', '25.00');
    await submitTransaction(app, wallet, 'WIN', '10.00');
    await submitTransaction(app, wallet, 'LOSS', '5.00');

    const reconciliation = await reconcile(app, wallet.id);
    expect(reconciliation).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: '85.00', currency: 'BRL' },
      calculatedBalance: { amount: '85.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 3,
    });
  });

  test('uses one repeatable-read snapshot when an operation commits during reconciliation', async () => {
    const wallet = await createWalletRequired('100.00');
    const rootUnitOfWork = FinancialUnitOfWork.fromEntityManager(dataSource.manager);
    const processor = new ProcessWagerTransactionUseCase(
      rootUnitOfWork,
      new RandomIdGenerator(),
      new SystemClock(),
    );
    let concurrentWriteCompleted = false;

    const snapshotUnitOfWork: FinancialUnitOfWorkPort = {
      wallets: rootUnitOfWork.wallets,
      transactions: rootUnitOfWork.transactions,
      ledger: rootUnitOfWork.ledger,
      inbox: rootUnitOfWork.inbox,
      outbox: rootUnitOfWork.outbox,
      transaction: (callback) => rootUnitOfWork.transaction(callback),
      repeatableRead: (callback) =>
        rootUnitOfWork.repeatableRead(async (transactionalUnitOfWork) => {
          const snapshotWallets = {
            findById: async (id: string) => {
              const storedWallet = await transactionalUnitOfWork.wallets.findById(id);
              if (!concurrentWriteCompleted) {
                concurrentWriteCompleted = true;
                await processor.execute({
                  providerId: `reconciliation-provider-${wallet.id}`,
                  externalTransactionId: `reconciliation-bet-${wallet.id}`,
                  idempotencyKey: `reconciliation-key-${wallet.id}`,
                  playerId: wallet.playerId,
                  walletId: wallet.id,
                  roundId: 'reconciliation-round',
                  gameId: 'reconciliation-game',
                  kind: WagerTransactionKind.Bet,
                  money: { amount: '25.00', currency: 'BRL' },
                });
              }

              return storedWallet;
            },
            findByIdForUpdate: (id: string) =>
              transactionalUnitOfWork.wallets.findByIdForUpdate(id),
            findByPlayerAndCurrency: (playerId: string, currency: string) =>
              transactionalUnitOfWork.wallets.findByPlayerAndCurrency(playerId, currency),
            insert: (candidate: Parameters<typeof transactionalUnitOfWork.wallets.insert>[0]) =>
              transactionalUnitOfWork.wallets.insert(candidate),
            save: (candidate: Parameters<typeof transactionalUnitOfWork.wallets.save>[0]) =>
              transactionalUnitOfWork.wallets.save(candidate),
          };

          return callback({ ...transactionalUnitOfWork, wallets: snapshotWallets });
        }),
    };
    const useCase = new ReconcileWalletUseCase(
      snapshotUnitOfWork,
      new WalletReconciliationMetrics(),
    );

    const snapshot = await useCase.execute(wallet.id);
    expect(snapshot).toMatchObject({
      storedBalance: { amount: '100.00', currency: 'BRL' },
      calculatedBalance: { amount: '100.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 1,
    });
    const current = await new ReconcileWalletUseCase(
      rootUnitOfWork,
      new WalletReconciliationMetrics(),
    ).execute(wallet.id);
    expect(current).toMatchObject({
      storedBalance: { amount: '75.00', currency: 'BRL' },
      calculatedBalance: { amount: '75.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 2,
    });
  });

  test('detects a fixture divergence, exposes the metric and does not correct persisted state', async () => {
    if (app === undefined) {
      throw new Error('The HTTP application was not initialized.');
    }

    const wallet = await createWallet(app, '100.00');
    await dataSource.manager.query('UPDATE wallets SET balance_minor = $1 WHERE id = $2', [
      '8800',
      wallet.id,
    ]);
    try {
      const response = await reconcile(app, wallet.id);
      expect(response).toMatchObject({
        storedBalance: { amount: '88.00', currency: 'BRL' },
        calculatedBalance: { amount: '100.00', currency: 'BRL' },
        difference: { amount: '-12.00', currency: 'BRL' },
        consistent: false,
        checkedEntries: 1,
      });
      expect(app.get(WalletReconciliationMetrics).snapshot().divergences).toBeGreaterThan(0);

      const rows = await dataSource.manager.query<Array<{ balance_minor: string }>>(
        'SELECT balance_minor::text FROM wallets WHERE id = $1',
        [wallet.id],
      );
      expect(rows).toEqual([{ balance_minor: '8800' }]);
    } finally {
      await dataSource.manager.query('UPDATE wallets SET balance_minor = $1 WHERE id = $2', [
        '10000',
        wallet.id,
      ]);
    }
  });
});

if (!runRealIntegration) {
  test('real reconciliation integration is opt-in', () => {
    expect(true).toBe(true);
  });
}

async function createWallet(
  application: NestFastifyApplication,
  initialAmount: string,
): Promise<{ id: string; playerId: string }> {
  const response = await application.inject({
    method: 'POST',
    url: '/wallets',
    payload: {
      playerId: randomUUID(),
      initialBalance: { amount: initialAmount, currency: 'BRL' },
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ id: string; playerId: string }>();
}

async function createWalletRequired(
  initialAmount: string,
): Promise<{ id: string; playerId: string }> {
  if (app === undefined) {
    throw new Error('The HTTP application was not initialized.');
  }

  return createWallet(app, initialAmount);
}

async function submitTransaction(
  application: NestFastifyApplication,
  wallet: { id: string; playerId: string },
  kind: 'BET' | 'WIN' | 'LOSS',
  amount: string,
): Promise<void> {
  const nonce = randomUUID();
  const response = await application.inject({
    method: 'POST',
    url: '/wagering/transactions',
    headers: { 'idempotency-key': `reconciliation-${nonce}` },
    payload: {
      providerId: `reconciliation-provider-${nonce}`,
      externalTransactionId: `reconciliation-transaction-${nonce}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: `reconciliation-round-${nonce}`,
      gameId: 'reconciliation-game',
      kind,
      money: { amount, currency: 'BRL' },
    },
  });
  expect(response.statusCode).toBe(201);
}

async function reconcile(
  application: NestFastifyApplication,
  walletId: string,
): Promise<{
  walletId: string;
  storedBalance: { amount: string; currency: string };
  calculatedBalance: { amount: string; currency: string };
  difference: { amount: string; currency: string };
  consistent: boolean;
  checkedEntries: number;
}> {
  const response = await application.inject({
    method: 'POST',
    url: `/wallets/${walletId}/reconciliation`,
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}
