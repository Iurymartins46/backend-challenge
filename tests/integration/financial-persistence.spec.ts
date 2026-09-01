import { beforeAll, afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';

import { FinancialUnitOfWork } from '../../src/infrastructure/database/financial-unit-of-work';
import dataSource from '../../src/infrastructure/database/data-source';
import type {
  FinancialUnitOfWorkPort,
  OutboxMessageRepositoryPort,
} from '../../src/modules/wagering/application/ports';
import {
  InboxMessage,
  Money,
  OutboxMessage,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionPendingReference,
  WagerTransactionStatus,
  Wallet,
  WalletLedgerEntry,
  LedgerDirection,
  RandomIdGenerator,
  SystemClock,
  type IdGenerator,
} from '../../src/modules/wagering/domain';
import {
  CreateWalletUseCase,
  decodeLedgerCursor,
  ListWalletLedgerUseCase,
} from '../../src/modules/wallet/application';

const runRealIntegration = process.env.RUN_REAL_INTEGRATION_TESTS === 'true';
const integration = runRealIntegration ? describe : describe.skip;

function money(amount: string, currency = 'BRL'): Money {
  return Money.from({ amount, currency });
}

function ids(): { walletId: string; playerId: string } {
  return { walletId: randomUUID(), playerId: randomUUID() };
}

async function expectRejected(promise: Promise<unknown>, message?: string): Promise<void> {
  let rejected = false;
  let rejection: unknown;
  try {
    await promise;
  } catch (error: unknown) {
    rejected = true;
    rejection = error;
  }

  expect(rejected).toBe(true);
  if (message !== undefined) {
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain(message);
  }
}

integration('financial PostgreSQL persistence', () => {
  beforeAll(async () => {
    await dataSource.initialize();
    await dataSource.runMigrations();
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  test('round-trips all Phase 4 aggregates through the same transactional UoW', async () => {
    const { walletId, playerId } = ids();
    const transactionId = randomUUID();
    const now = new Date('2026-09-01T12:00:00.000Z');
    const wallet = Wallet.open({
      id: walletId,
      playerId,
      initialBalance: money('0.00'),
      createdAt: now,
    });
    const transaction = WagerTransaction.create({
      id: transactionId,
      providerId: 'provider-integration',
      externalTransactionId: `external-${transactionId}`,
      idempotencyKey: `key-${transactionId}`,
      payloadHash: 'a'.repeat(64),
      walletId,
      playerId,
      roundId: 'round-integration',
      gameId: 'game-integration',
      kind: WagerTransactionKind.Refund,
      money: money('1.00'),
      referenceExternalTransactionId: 'reference-not-yet-seen',
      createdAt: now,
    });
    transaction.markPendingReference();
    const inbox = InboxMessage.receive({
      messageId: `message-${transactionId}`,
      consumerName: 'integration-consumer',
      payloadHash: 'b'.repeat(64),
      receivedAt: now,
    });
    const outbox = OutboxMessage.enqueue(
      WagerTransactionPendingReference.from(transaction, {
        correlationId: `correlation-${transactionId}`,
        occurredAt: now,
      }),
    );

    const rootUnitOfWork = FinancialUnitOfWork.fromEntityManager(dataSource.manager);
    await rootUnitOfWork.transaction(async (unitOfWork) => {
      await unitOfWork.wallets.insert(wallet);
      await unitOfWork.transactions.insert(transaction);
      await unitOfWork.inbox.insert(inbox);
      await unitOfWork.outbox.insert(outbox);
    });

    const loaded = await rootUnitOfWork.transaction(async (unitOfWork) => ({
      wallet: await unitOfWork.wallets.findById(walletId),
      transaction: await unitOfWork.transactions.findById(transactionId),
      inbox: await unitOfWork.inbox.findById('integration-consumer', `message-${transactionId}`),
      outbox: await unitOfWork.outbox.findById(transactionId),
    }));

    expect(loaded.wallet?.balance.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(loaded.transaction?.status).toBe(WagerTransactionStatus.PendingReference);
    expect(loaded.transaction?.money.toJSON()).toEqual({ amount: '1.00', currency: 'BRL' });
    expect(loaded.inbox?.isProcessed()).toBe(false);
    expect(loaded.outbox?.eventType).toBe('WagerTransactionPendingReference');
  });

  test('keeps wallet, transaction and ledger atomic on rollback', async () => {
    const { walletId, playerId } = ids();
    const unitOfWork = FinancialUnitOfWork.fromEntityManager(dataSource.manager);

    await expectRejected(
      unitOfWork.transaction(async (transactionalUnitOfWork) => {
        await transactionalUnitOfWork.wallets.insert(
          Wallet.open({ id: walletId, playerId, initialBalance: money('0.00') }),
        );
        throw new Error('intentional rollback');
      }),
      'intentional rollback',
    );

    expect(await unitOfWork.wallets.findById(walletId)).toBeNull();
  });

  test('rejects direct ledger mutation and invalid arithmetic in PostgreSQL', async () => {
    const { walletId, playerId } = ids();
    const transactionId = randomUUID();
    const invalidTransactionId = randomUUID();
    const ledgerId = randomUUID();
    const wallet = Wallet.open({ id: walletId, playerId, initialBalance: money('1.00') });
    const transaction = WagerTransaction.create({
      id: transactionId,
      providerId: 'provider-integration',
      externalTransactionId: `opening-${transactionId}`,
      idempotencyKey: `opening-key-${transactionId}`,
      payloadHash: 'c'.repeat(64),
      walletId,
      playerId,
      roundId: 'opening-round',
      gameId: 'opening-game',
      kind: WagerTransactionKind.Opening,
      money: money('1.00'),
    });
    transaction.markProcessed(undefined, new Date());
    transaction.recordResultSnapshot(wallet.balance, wallet.version);
    const invalidTransaction = WagerTransaction.create({
      id: invalidTransactionId,
      providerId: 'provider-integration',
      externalTransactionId: `invalid-opening-${invalidTransactionId}`,
      idempotencyKey: `invalid-opening-key-${invalidTransactionId}`,
      payloadHash: 'd'.repeat(64),
      walletId,
      playerId,
      roundId: 'opening-round',
      gameId: 'opening-game',
      kind: WagerTransactionKind.Opening,
      money: money('2.00'),
    });
    invalidTransaction.markProcessed(undefined, new Date());
    invalidTransaction.recordResultSnapshot(wallet.balance, wallet.version);
    const ledger = WalletLedgerEntry.create({
      id: ledgerId,
      walletId,
      transactionId,
      direction: LedgerDirection.Credit,
      money: money('1.00'),
      balanceBefore: money('0.00'),
      balanceAfter: money('1.00'),
      createdAt: new Date(),
    });
    const unitOfWork = FinancialUnitOfWork.fromEntityManager(dataSource.manager);

    await unitOfWork.transaction(async (transactionalUnitOfWork) => {
      await transactionalUnitOfWork.wallets.insert(wallet);
      await transactionalUnitOfWork.transactions.insert(transaction);
      await transactionalUnitOfWork.transactions.insert(invalidTransaction);
      await transactionalUnitOfWork.ledger.insert(ledger);
    });

    await expectRejected(
      dataSource.manager.query('UPDATE wallet_ledger_entries SET amount_minor = $2 WHERE id = $1', [
        ledgerId,
        '2',
      ]),
    );
    await expectRejected(
      dataSource.manager.query('DELETE FROM wallet_ledger_entries WHERE id = $1', [ledgerId]),
    );
    await expectRejected(
      dataSource.manager.query(
        `INSERT INTO wallet_ledger_entries
         (id, wallet_id, transaction_id, direction, amount_minor, currency,
           balance_before_minor, balance_after_minor)
         VALUES ($1, $2, $3, 'DEBIT', $4, $5, $6, $7)`,
        [randomUUID(), walletId, invalidTransactionId, '200', 'BRL', '100', '0'],
      ),
    );
    await expectRejected(
      dataSource.manager.query('UPDATE wallets SET balance_minor = $2 WHERE id = $1', [
        walletId,
        '-1',
      ]),
    );
    const duplicateLedger = WalletLedgerEntry.create({
      id: randomUUID(),
      walletId,
      transactionId,
      direction: LedgerDirection.Credit,
      money: money('1.00'),
      balanceBefore: money('0.00'),
      balanceAfter: money('1.00'),
      createdAt: new Date(),
    });
    await expectRejected(unitOfWork.ledger.insert(duplicateLedger));
  });

  test('enforces unique business keys and round-trips the BIGINT upper boundary', async () => {
    const { walletId, playerId } = ids();
    const uniqueSuffix = randomUUID();
    const wallet = Wallet.open({
      id: walletId,
      playerId,
      initialBalance: money('92233720368547758.07'),
    });
    const unitOfWork = FinancialUnitOfWork.fromEntityManager(dataSource.manager);

    await unitOfWork.wallets.insert(wallet);
    expect((await unitOfWork.wallets.findById(walletId))?.balance.toJSON()).toEqual({
      amount: '92233720368547758.07',
      currency: 'BRL',
    });

    const duplicateWallet = Wallet.open({
      id: randomUUID(),
      playerId,
      initialBalance: money('0.00'),
    });
    await expectRejected(unitOfWork.wallets.insert(duplicateWallet));

    const transaction = WagerTransaction.create({
      id: randomUUID(),
      providerId: `provider-${uniqueSuffix}`,
      externalTransactionId: `external-${uniqueSuffix}`,
      idempotencyKey: `idempotency-${uniqueSuffix}`,
      payloadHash: 'e'.repeat(64),
      walletId,
      playerId,
      roundId: 'round-unique',
      gameId: 'game-unique',
      kind: WagerTransactionKind.Bet,
      money: money('0.01'),
    });
    await unitOfWork.transactions.insert(transaction);

    const duplicateIdempotency = WagerTransaction.create({
      id: randomUUID(),
      providerId: transaction.providerId,
      externalTransactionId: `external-idempotency-conflict-${uniqueSuffix}`,
      idempotencyKey: transaction.idempotencyKey,
      payloadHash: 'f'.repeat(64),
      walletId,
      playerId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: WagerTransactionKind.Bet,
      money: money('0.01'),
    });
    await expectRejected(unitOfWork.transactions.insert(duplicateIdempotency));

    const duplicateExternal = WagerTransaction.create({
      id: randomUUID(),
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      idempotencyKey: `idempotency-external-conflict-${uniqueSuffix}`,
      payloadHash: 'a'.repeat(64),
      walletId,
      playerId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: WagerTransactionKind.Bet,
      money: money('0.01'),
    });
    await expectRejected(unitOfWork.transactions.insert(duplicateExternal));
  });

  test('creates zero and positive wallets with the Phase 5 persistence contract', async () => {
    const unitOfWork = FinancialUnitOfWork.fromEntityManager(dataSource.manager);
    const useCase = new CreateWalletUseCase(unitOfWork, new RandomIdGenerator(), new SystemClock());
    const zeroWallet = await useCase.execute({
      playerId: randomUUID(),
      initialBalance: { amount: '0.00', currency: 'BRL' },
    });
    const positiveWallet = await useCase.execute({
      playerId: randomUUID(),
      initialBalance: { amount: '1000.00', currency: 'BRL' },
    });

    const counts = await dataSource.manager.query<
      Array<{ transactions: string; ledger: string; outbox: string }>
    >(
      `SELECT
         (SELECT count(*)::text FROM wager_transactions WHERE wallet_id = $1) AS transactions,
         (SELECT count(*)::text FROM wallet_ledger_entries WHERE wallet_id = $1) AS ledger,
         (SELECT count(*)::text FROM outbox_messages WHERE aggregate_id = $1) AS outbox
       UNION ALL
       SELECT
         (SELECT count(*)::text FROM wager_transactions WHERE wallet_id = $2),
         (SELECT count(*)::text FROM wallet_ledger_entries WHERE wallet_id = $2),
         (SELECT count(*)::text FROM outbox_messages WHERE aggregate_id = $2)`,
      [zeroWallet.id, positiveWallet.id],
    );

    expect(counts).toEqual([
      { transactions: '0', ledger: '0', outbox: '0' },
      { transactions: '1', ledger: '1', outbox: '1' },
    ]);
    expect(positiveWallet.balance).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(positiveWallet.version).toBe(1);
  });

  test('rolls back every positive-wallet write when the outbox insert fails', async () => {
    const rootUnitOfWork = FinancialUnitOfWork.fromEntityManager(dataSource.manager);
    const failingOutbox: OutboxMessageRepositoryPort = {
      findById: (...args) => rootUnitOfWork.outbox.findById(...args),
      insert: () => Promise.reject(new Error('intentional outbox failure')),
      save: (...args) => rootUnitOfWork.outbox.save(...args),
    };
    const failingUnitOfWork: FinancialUnitOfWorkPort = {
      wallets: rootUnitOfWork.wallets,
      transactions: rootUnitOfWork.transactions,
      ledger: rootUnitOfWork.ledger,
      inbox: rootUnitOfWork.inbox,
      outbox: failingOutbox,
      transaction: (callback) =>
        rootUnitOfWork.transaction(async (transactionalUnitOfWork) =>
          callback({ ...transactionalUnitOfWork, outbox: failingOutbox }),
        ),
    };
    const walletId = randomUUID();
    const openingTransactionId = randomUUID();
    const openingLedgerId = randomUUID();
    const generatedIds = [walletId, openingTransactionId, openingLedgerId];
    let generatedIdIndex = 0;
    const idGenerator: IdGenerator = {
      next: () => {
        const id = generatedIds[generatedIdIndex];
        generatedIdIndex += 1;
        if (id === undefined) {
          throw new Error('No test id available.');
        }

        return id;
      },
    };
    const useCase = new CreateWalletUseCase(failingUnitOfWork, idGenerator, new SystemClock());

    await expectRejected(
      useCase.execute({
        playerId: randomUUID(),
        initialBalance: { amount: '1.00', currency: 'BRL' },
      }),
      'intentional outbox failure',
    );

    expect(await rootUnitOfWork.wallets.findById(walletId)).toBeNull();
    const rows = await dataSource.manager.query<
      Array<{ wallets: string; transactions: string; ledger: string; outbox: string }>
    >(
      `SELECT
         (SELECT count(*)::text FROM wallets WHERE id = $1) AS wallets,
         (SELECT count(*)::text FROM wager_transactions WHERE wallet_id = $1) AS transactions,
         (SELECT count(*)::text FROM wallet_ledger_entries WHERE wallet_id = $1) AS ledger,
         (SELECT count(*)::text FROM outbox_messages WHERE aggregate_id = $1) AS outbox`,
      [walletId],
    );
    expect(rows).toEqual([{ wallets: '0', transactions: '0', ledger: '0', outbox: '0' }]);
  });

  test('paginates the ledger without duplicates when timestamps tie', async () => {
    const rootUnitOfWork = FinancialUnitOfWork.fromEntityManager(dataSource.manager);
    const useCase = new CreateWalletUseCase(
      rootUnitOfWork,
      new RandomIdGenerator(),
      new SystemClock(),
    );
    const wallet = await useCase.execute({
      playerId: randomUUID(),
      initialBalance: { amount: '1.00', currency: 'BRL' },
    });
    const createdAt = new Date('2026-09-01T12:00:00.000Z');

    await rootUnitOfWork.transaction(async (unitOfWork) => {
      const persistedWallet = await unitOfWork.wallets.findByIdForUpdate(wallet.id);
      if (persistedWallet === null) {
        throw new Error('Wallet was not created.');
      }

      for (const [index, amount] of (['2.00', '3.00'] as const).entries()) {
        const change = persistedWallet.credit(money(amount), createdAt);
        const transaction = WagerTransaction.create({
          id: randomUUID(),
          providerId: `phase5-pagination-${wallet.id}`,
          externalTransactionId: `external-${index}-${wallet.id}`,
          idempotencyKey: `key-${index}-${wallet.id}`,
          payloadHash: `${index}`.repeat(64),
          walletId: persistedWallet.id,
          playerId: persistedWallet.playerId,
          roundId: 'phase5-pagination-round',
          gameId: 'phase5-pagination-game',
          kind: WagerTransactionKind.Bet,
          money: money(amount),
          createdAt,
        });
        transaction.markProcessed(undefined, createdAt);
        transaction.recordResultSnapshot(persistedWallet.balance, persistedWallet.version);
        await unitOfWork.transactions.insert(transaction);
        await unitOfWork.ledger.insert(
          WalletLedgerEntry.create({
            id: randomUUID(),
            walletId: persistedWallet.id,
            transactionId: transaction.id,
            direction: change.direction,
            money: change.money,
            balanceBefore: change.balanceBefore,
            balanceAfter: change.balanceAfter,
            createdAt,
          }),
        );
      }

      await unitOfWork.wallets.save(persistedWallet);
    });

    const ledgerUseCase = new ListWalletLedgerUseCase(rootUnitOfWork);
    const seenEntryIds: string[] = [];
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < 3; pageNumber += 1) {
      const page = await ledgerUseCase.execute({
        walletId: wallet.id,
        after: cursor === undefined ? undefined : decodeLedgerCursor(cursor),
        limit: 1,
      });
      seenEntryIds.push(...page.entries.map((entry) => entry.id));
      cursor = page.nextCursor ?? undefined;
    }

    expect(seenEntryIds).toHaveLength(3);
    expect(new Set(seenEntryIds).size).toBe(3);
    expect(cursor).toBeUndefined();
  });
});

if (!runRealIntegration) {
  test('real integration is opt-in', () => {
    expect(true).toBe(true);
  });
}
