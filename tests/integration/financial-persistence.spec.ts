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
import {
  ProcessWagerTransactionUseCase,
  type ProcessWagerTransactionInput,
} from '../../src/modules/wagering/application';

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
      repeatableRead: (callback) =>
        rootUnitOfWork.repeatableRead(async (transactionalUnitOfWork) =>
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

  test('replays the original balance snapshot and detects both conflict types', async () => {
    const rootUnitOfWork = FinancialUnitOfWork.fromEntityManager(dataSource.manager);
    const wallet = await new CreateWalletUseCase(
      rootUnitOfWork,
      new RandomIdGenerator(),
      new SystemClock(),
    ).execute({
      playerId: randomUUID(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const useCase = new ProcessWagerTransactionUseCase(
      rootUnitOfWork,
      new RandomIdGenerator(),
      new SystemClock(),
      undefined,
      () => Promise.resolve(),
    );
    const input: ProcessWagerTransactionInput = {
      providerId: 'phase6-replay-provider',
      externalTransactionId: `replay-${wallet.id}`,
      idempotencyKey: `replay-key-${wallet.id}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'phase6-replay-round',
      gameId: 'phase6-replay-game',
      kind: WagerTransactionKind.Bet,
      money: { amount: '25.00', currency: 'BRL' },
    };

    const first = await useCase.execute(input);
    await useCase.execute({
      ...input,
      providerId: 'phase6-replay-provider',
      externalTransactionId: `replay-second-${wallet.id}`,
      idempotencyKey: `replay-second-key-${wallet.id}`,
      money: { amount: '10.00', currency: 'BRL' },
    });
    const replay = await useCase.execute(input);

    expect(first.status).toBe(WagerTransactionStatus.Processed);
    expect(first.idempotentReplay).toBe(false);
    expect(replay).toEqual({
      ...first,
      idempotentReplay: true,
    });
    expect(replay.balance).toEqual({ amount: '75.00', currency: 'BRL' });

    await expectRejected(
      useCase.execute({ ...input, money: { amount: '26.00', currency: 'BRL' } }),
      'idempotency key was reused',
    );
    await expectRejected(
      useCase.execute({
        ...input,
        externalTransactionId: input.externalTransactionId,
        idempotencyKey: `replay-external-conflict-key-${wallet.id}`,
      }),
      'external transaction id was already used',
    );
  });

  test('processes 50 identical BET submissions as one debit on real connections', async () => {
    const rootUnitOfWork = FinancialUnitOfWork.fromEntityManager(dataSource.manager);
    const wallet = await new CreateWalletUseCase(
      rootUnitOfWork,
      new RandomIdGenerator(),
      new SystemClock(),
    ).execute({
      playerId: randomUUID(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const useCase = new ProcessWagerTransactionUseCase(
      rootUnitOfWork,
      new RandomIdGenerator(),
      new SystemClock(),
      undefined,
      () => Promise.resolve(),
    );
    const input: ProcessWagerTransactionInput = {
      providerId: 'phase6-parallel-provider',
      externalTransactionId: `parallel-${wallet.id}`,
      idempotencyKey: `parallel-key-${wallet.id}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'phase6-parallel-round',
      gameId: 'phase6-parallel-game',
      kind: WagerTransactionKind.Bet,
      money: { amount: '10.00', currency: 'BRL' },
    };

    const results = await Promise.all(Array.from({ length: 50 }, () => useCase.execute(input)));
    const reloadedWallet = await rootUnitOfWork.wallets.findById(wallet.id);
    const counts = await dataSource.manager.query<
      Array<{ transactions: string; ledger: string; debits: string }>
    >(
      `SELECT
         (SELECT count(*)::text FROM wager_transactions WHERE wallet_id = $1 AND kind = 'BET') AS transactions,
         (SELECT count(*)::text FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT') AS ledger,
         (SELECT count(*)::text FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT' AND amount_minor = 1000) AS debits`,
      [wallet.id],
    );

    expect(results.every((result) => result.status === WagerTransactionStatus.Processed)).toBe(
      true,
    );
    expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);
    expect(results.filter((result) => result.idempotentReplay === false)).toHaveLength(1);
    expect(reloadedWallet?.balance.toJSON()).toEqual({ amount: '90.00', currency: 'BRL' });
    expect(counts).toEqual([{ transactions: '1', ledger: '1', debits: '1' }]);
  });

  test('processes WIN as a credit with a matching ledger and snapshot', async () => {
    const rootUnitOfWork = FinancialUnitOfWork.fromEntityManager(dataSource.manager);
    const wallet = await new CreateWalletUseCase(
      rootUnitOfWork,
      new RandomIdGenerator(),
      new SystemClock(),
    ).execute({
      playerId: randomUUID(),
      initialBalance: { amount: '10.00', currency: 'BRL' },
    });
    const result = await new ProcessWagerTransactionUseCase(
      rootUnitOfWork,
      new RandomIdGenerator(),
      new SystemClock(),
      undefined,
      () => Promise.resolve(),
    ).execute({
      providerId: 'phase6-win-provider',
      externalTransactionId: `win-${wallet.id}`,
      idempotencyKey: `win-key-${wallet.id}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'phase6-win-round',
      gameId: 'phase6-win-game',
      kind: WagerTransactionKind.Win,
      money: { amount: '7.00', currency: 'BRL' },
    });
    const reloadedWallet = await rootUnitOfWork.wallets.findById(wallet.id);
    const rows = await dataSource.manager.query<Array<{ credits: string; version: number }>>(
      `SELECT
         (SELECT count(*)::text FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'CREDIT' AND amount_minor = 700) AS credits,
         version
       FROM wallets WHERE id = $1`,
      [wallet.id],
    );

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance).toEqual({ amount: '17.00', currency: 'BRL' });
    expect(reloadedWallet?.balance.toJSON()).toEqual({ amount: '17.00', currency: 'BRL' });
    expect(rows).toEqual([{ credits: '1', version: 2 }]);
  });

  test('serializes two 80 BETs into one processed and one rejected result', async () => {
    const rootUnitOfWork = FinancialUnitOfWork.fromEntityManager(dataSource.manager);
    const wallet = await new CreateWalletUseCase(
      rootUnitOfWork,
      new RandomIdGenerator(),
      new SystemClock(),
    ).execute({
      playerId: randomUUID(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const useCase = new ProcessWagerTransactionUseCase(
      rootUnitOfWork,
      new RandomIdGenerator(),
      new SystemClock(),
      undefined,
      () => Promise.resolve(),
    );
    const results = await Promise.all(
      (['first', 'second'] as const).map((suffix) =>
        useCase.execute({
          providerId: 'phase6-race-provider',
          externalTransactionId: `race-${suffix}-${wallet.id}`,
          idempotencyKey: `race-key-${suffix}-${wallet.id}`,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: 'phase6-race-round',
          gameId: 'phase6-race-game',
          kind: WagerTransactionKind.Bet,
          money: { amount: '80.00', currency: 'BRL' },
        }),
      ),
    );
    const reloadedWallet = await rootUnitOfWork.wallets.findById(wallet.id);
    const counts = await dataSource.manager.query<Array<{ debits: string; rejected: string }>>(
      `SELECT
         (SELECT count(*)::text FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT') AS debits,
         (SELECT count(*)::text FROM wager_transactions WHERE wallet_id = $1 AND status = 'REJECTED') AS rejected`,
      [wallet.id],
    );

    expect(
      results.filter((result) => result.status === WagerTransactionStatus.Processed),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === WagerTransactionStatus.Rejected),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === WagerTransactionStatus.Rejected)?.failureCode,
    ).toBe('error.wager.insufficient_funds');
    expect(reloadedWallet?.balance.toJSON()).toEqual({ amount: '20.00', currency: 'BRL' });
    expect(counts).toEqual([{ debits: '1', rejected: '1' }]);
  });

  test('processes different wallets in parallel and LOSS without a balance movement', async () => {
    const rootUnitOfWork = FinancialUnitOfWork.fromEntityManager(dataSource.manager);
    const walletUseCase = new CreateWalletUseCase(
      rootUnitOfWork,
      new RandomIdGenerator(),
      new SystemClock(),
    );
    const [walletOne, walletTwo] = await Promise.all([
      walletUseCase.execute({
        playerId: randomUUID(),
        initialBalance: { amount: '50.00', currency: 'BRL' },
      }),
      walletUseCase.execute({
        playerId: randomUUID(),
        initialBalance: { amount: '50.00', currency: 'BRL' },
      }),
    ]);
    const useCase = new ProcessWagerTransactionUseCase(
      rootUnitOfWork,
      new RandomIdGenerator(),
      new SystemClock(),
      undefined,
      () => Promise.resolve(),
    );
    const [betOne, betTwo, loss] = await Promise.all([
      useCase.execute({
        providerId: 'phase6-wallets-provider',
        externalTransactionId: `wallet-one-${walletOne.id}`,
        idempotencyKey: `wallet-one-key-${walletOne.id}`,
        playerId: walletOne.playerId,
        walletId: walletOne.id,
        roundId: 'phase6-wallets-round',
        gameId: 'phase6-wallets-game',
        kind: WagerTransactionKind.Bet,
        money: { amount: '10.00', currency: 'BRL' },
      }),
      useCase.execute({
        providerId: 'phase6-wallets-provider',
        externalTransactionId: `wallet-two-${walletTwo.id}`,
        idempotencyKey: `wallet-two-key-${walletTwo.id}`,
        playerId: walletTwo.playerId,
        walletId: walletTwo.id,
        roundId: 'phase6-wallets-round',
        gameId: 'phase6-wallets-game',
        kind: WagerTransactionKind.Bet,
        money: { amount: '10.00', currency: 'BRL' },
      }),
      useCase.execute({
        providerId: 'phase6-wallets-provider',
        externalTransactionId: `wallet-loss-${walletOne.id}`,
        idempotencyKey: `wallet-loss-key-${walletOne.id}`,
        playerId: walletOne.playerId,
        walletId: walletOne.id,
        roundId: 'phase6-wallets-round',
        gameId: 'phase6-wallets-game',
        kind: WagerTransactionKind.Loss,
        money: { amount: '10.00', currency: 'BRL' },
      }),
    ]);
    const [reloadedOne, reloadedTwo] = await Promise.all([
      rootUnitOfWork.wallets.findById(walletOne.id),
      rootUnitOfWork.wallets.findById(walletTwo.id),
    ]);
    const counts = await dataSource.manager.query<Array<{ ledger: string; version: number }>>(
      `SELECT
         (SELECT count(*)::text FROM wallet_ledger_entries WHERE wallet_id = $1) AS ledger,
         version
       FROM wallets WHERE id = $1`,
      [walletOne.id],
    );

    expect(betOne.status).toBe(WagerTransactionStatus.Processed);
    expect(betTwo.status).toBe(WagerTransactionStatus.Processed);
    expect(loss.status).toBe(WagerTransactionStatus.Processed);
    expect(reloadedOne?.balance.toJSON()).toEqual({ amount: '40.00', currency: 'BRL' });
    expect(reloadedTwo?.balance.toJSON()).toEqual({ amount: '40.00', currency: 'BRL' });
    expect(counts).toEqual([{ ledger: '2', version: 2 }]);
  });

  test('rolls back transaction, ledger and outbox when a processing write fails', async () => {
    const rootUnitOfWork = FinancialUnitOfWork.fromEntityManager(dataSource.manager);
    const wallet = await new CreateWalletUseCase(
      rootUnitOfWork,
      new RandomIdGenerator(),
      new SystemClock(),
    ).execute({
      playerId: randomUUID(),
      initialBalance: { amount: '10.00', currency: 'BRL' },
    });
    const failingOutbox: OutboxMessageRepositoryPort = {
      findById: (...args) => rootUnitOfWork.outbox.findById(...args),
      insert: () => Promise.reject(new Error('intentional Phase 6 outbox failure')),
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
      repeatableRead: (callback) =>
        rootUnitOfWork.repeatableRead(async (transactionalUnitOfWork) =>
          callback({ ...transactionalUnitOfWork, outbox: failingOutbox }),
        ),
    };
    const useCase = new ProcessWagerTransactionUseCase(
      failingUnitOfWork,
      new RandomIdGenerator(),
      new SystemClock(),
      undefined,
      () => Promise.resolve(),
    );

    await expectRejected(
      useCase.execute({
        providerId: 'phase6-rollback-provider',
        externalTransactionId: `rollback-${wallet.id}`,
        idempotencyKey: `rollback-key-${wallet.id}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'phase6-rollback-round',
        gameId: 'phase6-rollback-game',
        kind: WagerTransactionKind.Bet,
        money: { amount: '5.00', currency: 'BRL' },
      }),
      'intentional Phase 6 outbox failure',
    );

    const rows = await dataSource.manager.query<
      Array<{
        transactions: string;
        ledger: string;
        outbox: string;
        balance: string;
        version: number;
      }>
    >(
      `SELECT
         (SELECT count(*)::text FROM wager_transactions WHERE wallet_id = $1 AND provider_id = 'phase6-rollback-provider') AS transactions,
         (SELECT count(*)::text FROM wallet_ledger_entries WHERE wallet_id = $1 AND transaction_id IN (SELECT id FROM wager_transactions WHERE provider_id = 'phase6-rollback-provider')) AS ledger,
         (SELECT count(*)::text FROM outbox_messages WHERE aggregate_id = $1 AND event_type <> 'WalletBalanceChanged') AS outbox,
         balance_minor::text AS balance,
         version
       FROM wallets WHERE id = $1`,
      [wallet.id],
    );
    expect(rows).toEqual([
      { transactions: '0', ledger: '0', outbox: '0', balance: '1000', version: 1 },
    ]);
  });

  test('audits materialized balances against the SQL ledger invariant', async () => {
    const rootUnitOfWork = FinancialUnitOfWork.fromEntityManager(dataSource.manager);
    const wallet = await new CreateWalletUseCase(
      rootUnitOfWork,
      new RandomIdGenerator(),
      new SystemClock(),
    ).execute({ playerId: randomUUID(), initialBalance: { amount: '100.00', currency: 'BRL' } });
    const useCase = new ProcessWagerTransactionUseCase(
      rootUnitOfWork,
      new RandomIdGenerator(),
      new SystemClock(),
      undefined,
      () => Promise.resolve(),
    );
    await useCase.execute({
      providerId: 'phase6-audit-provider',
      externalTransactionId: `audit-${wallet.id}`,
      idempotencyKey: `audit-key-${wallet.id}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'phase6-audit-round',
      gameId: 'phase6-audit-game',
      kind: WagerTransactionKind.Bet,
      money: { amount: '25.00', currency: 'BRL' },
    });

    const rows = await dataSource.manager.query<Array<{ stored: string; calculated: string }>>(
      `SELECT
         w.balance_minor::text AS stored,
         COALESCE(SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount_minor ELSE -l.amount_minor END), 0)::text AS calculated
       FROM wallets w
       LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
       WHERE w.id = $1
       GROUP BY w.id, w.balance_minor`,
      [wallet.id],
    );
    expect(rows).toEqual([{ stored: '7500', calculated: '7500' }]);
  });
});

if (!runRealIntegration) {
  test('real integration is opt-in', () => {
    expect(true).toBe(true);
  });
}
