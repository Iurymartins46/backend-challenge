import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';

import dataSource from '../../src/infrastructure/database/data-source';
import { FinancialUnitOfWork } from '../../src/infrastructure/database/financial-unit-of-work';
import {
  PendingReferenceWorker,
  type PendingReferenceWorkerOptions,
} from '../../src/infrastructure/messaging/pending-reference.worker';
import {
  ProcessWagerTransactionUseCase,
  type ProcessWagerTransactionInput,
} from '../../src/modules/wagering/application';
import { CreateWalletUseCase } from '../../src/modules/wallet/application';
import {
  ExponentialRetryPolicy,
  RandomIdGenerator,
  type Clock,
  type IdGenerator,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/modules/wagering/domain';

const runRealIntegration = process.env.RUN_REAL_INTEGRATION_TESTS === 'true';
const integration = runRealIntegration ? describe : describe.skip;

class MutableClock implements Clock {
  private current: Date;

  constructor(current = new Date('2026-09-01T12:00:00.000Z')) {
    this.current = current;
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

class FixedIdGenerator implements IdGenerator {
  constructor(private readonly id: string) {}

  next(): string {
    return this.id;
  }
}

integration('pending-reference worker with PostgreSQL', () => {
  beforeAll(async () => {
    await dataSource.initialize();
    await dataSource.runMigrations();
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  test('processes REFUND and ROLLBACK delivered before their references', async () => {
    const clock = new MutableClock();
    const wallet = await createWallet('100.00', clock);
    const processor = createProcessor(clock);
    const providerId = `phase10-order-${wallet.id}`;

    const refund = await processor.execute(
      wagerInput(wallet, {
        providerId,
        externalTransactionId: 'refund-before-bet',
        idempotencyKey: 'refund-before-bet-key',
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'bet-after',
        money: { amount: '25.00', currency: 'BRL' },
      }),
    );
    const rollback = await processor.execute(
      wagerInput(wallet, {
        providerId,
        externalTransactionId: 'rollback-before-win',
        idempotencyKey: 'rollback-before-win-key',
        kind: WagerTransactionKind.Rollback,
        referenceExternalTransactionId: 'win-after',
        money: { amount: '10.00', currency: 'BRL' },
      }),
    );
    expect([refund.status, rollback.status]).toEqual([
      WagerTransactionStatus.PendingReference,
      WagerTransactionStatus.PendingReference,
    ]);

    clock.advance(2_000);
    const worker = createWorker(clock, 'order-worker');
    const firstAttempt = await worker.processOnce();
    expect(firstAttempt).toMatchObject({ claimed: 2, rescheduled: 2, processed: 0 });

    await processor.execute(
      wagerInput(wallet, {
        providerId,
        externalTransactionId: 'bet-after',
        idempotencyKey: 'bet-after-key',
        kind: WagerTransactionKind.Bet,
        money: { amount: '25.00', currency: 'BRL' },
      }),
    );
    await processor.execute(
      wagerInput(wallet, {
        providerId,
        externalTransactionId: 'win-after',
        idempotencyKey: 'win-after-key',
        kind: WagerTransactionKind.Win,
        money: { amount: '10.00', currency: 'BRL' },
      }),
    );

    clock.advance(2_000);
    const resolved = await worker.processOnce();
    expect(resolved).toMatchObject({ claimed: 2, processed: 2, rescheduled: 0, expired: 0 });

    const rows = await dataSource.manager.query<
      Array<{
        status: string;
        attempts: number;
        lockedUntil: Date | null;
        balance: string;
        ledger: string;
        events: string;
      }>
    >(
      `SELECT
         (SELECT status FROM wager_transactions WHERE id = $2) AS status,
         (SELECT reference_attempts FROM wager_transactions WHERE id = $2) AS attempts,
         (SELECT reference_locked_until FROM wager_transactions WHERE id = $2) AS "lockedUntil",
         w.balance_minor::text AS balance,
         (SELECT count(*)::text FROM wallet_ledger_entries WHERE wallet_id = w.id) AS ledger,
         (SELECT count(*)::text FROM outbox_messages WHERE aggregate_id = w.id) AS events
       FROM wallets w WHERE w.id = $1`,
      [wallet.id, refund.transactionId],
    );
    expect(rows).toEqual([
      {
        status: 'PROCESSED',
        attempts: 2,
        lockedUntil: null,
        balance: '10000',
        ledger: '5',
        events: '11',
      },
    ]);
    expect(worker.metrics.snapshot()).toMatchObject({
      attempts: 4,
      rescheduled: 2,
      processed: 2,
    });
  });

  test('three workers claim one pending reference once and preserve one ledger effect', async () => {
    const clock = new MutableClock();
    const wallet = await createWallet('100.00', clock);
    const processor = createProcessor(clock);
    const providerId = `phase10-race-${wallet.id}`;
    const pending = await processor.execute(
      wagerInput(wallet, {
        providerId,
        externalTransactionId: 'refund-race',
        idempotencyKey: 'refund-race-key',
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'bet-race',
        money: { amount: '25.00', currency: 'BRL' },
      }),
    );
    await processor.execute(
      wagerInput(wallet, {
        providerId,
        externalTransactionId: 'bet-race',
        idempotencyKey: 'bet-race-key',
        kind: WagerTransactionKind.Bet,
        money: { amount: '25.00', currency: 'BRL' },
      }),
    );

    clock.advance(2_000);
    const workers = ['a', 'b', 'c'].map((suffix) => createWorker(clock, `race-worker-${suffix}`));
    const results = await Promise.all(workers.map((worker) => worker.processOnce()));
    expect(results.reduce((total, result) => total + result.claimed, 0)).toBe(1);
    expect(results.reduce((total, result) => total + result.processed, 0)).toBe(1);

    const rows = await dataSource.manager.query<
      Array<{ status: string; balance: string; ledgers: string; attempts: number }>
    >(
      `SELECT
         wager_transaction.status,
         wallet.balance_minor::text AS balance,
         (SELECT count(*)::text FROM wallet_ledger_entries WHERE transaction_id = wager_transaction.id) AS ledgers,
         wager_transaction.reference_attempts AS attempts
       FROM wager_transactions wager_transaction
       JOIN wallets wallet ON wallet.id = wager_transaction.wallet_id
       WHERE wager_transaction.id = $1`,
      [pending.transactionId],
    );
    expect(rows).toEqual([{ status: 'PROCESSED', balance: '10000', ledgers: '1', attempts: 1 }]);
  });

  test('a restarted worker keeps the persisted retry agenda without sleeping', async () => {
    const clock = new MutableClock();
    const wallet = await createWallet('100.00', clock);
    const processor = createProcessor(clock);
    const providerId = `phase10-restart-${wallet.id}`;
    const pending = await processor.execute(
      wagerInput(wallet, {
        providerId,
        externalTransactionId: 'refund-restart',
        idempotencyKey: 'refund-restart-key',
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'bet-restart',
        money: { amount: '10.00', currency: 'BRL' },
      }),
    );

    clock.advance(2_000);
    await createWorker(clock, 'first-process').processOnce();
    const scheduled = await dataSource.manager.query<
      Array<{ nextAttemptAt: Date; attempts: number }>
    >(
      `SELECT next_reference_attempt_at AS "nextAttemptAt", reference_attempts AS attempts
       FROM wager_transactions WHERE id = $1`,
      [pending.transactionId],
    );
    expect(scheduled[0]?.attempts).toBe(1);
    expect(scheduled[0]?.nextAttemptAt.getTime()).toBe(clock.now().getTime() + 2_000);

    await processor.execute(
      wagerInput(wallet, {
        providerId,
        externalTransactionId: 'bet-restart',
        idempotencyKey: 'bet-restart-key',
        kind: WagerTransactionKind.Bet,
        money: { amount: '10.00', currency: 'BRL' },
      }),
    );
    clock.advance(2_000);
    const restarted = await createWorker(clock, 'second-process').processOnce();
    expect(restarted).toMatchObject({ claimed: 1, processed: 1 });

    const transaction = await FinancialUnitOfWork.fromEntityManager(
      dataSource.manager,
    ).transactions.findById(pending.transactionId);
    expect(transaction).toMatchObject({ status: WagerTransactionStatus.Processed });
  });

  test('TTL exhaustion rejects atomically with the durable reference-not-found failure code', async () => {
    const clock = new MutableClock();
    const wallet = await createWallet('100.00', clock);
    const processor = createProcessor(clock);
    const pending = await processor.execute(
      wagerInput(wallet, {
        providerId: `phase10-ttl-${wallet.id}`,
        externalTransactionId: 'refund-ttl',
        idempotencyKey: 'refund-ttl-key',
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'bet-never-arrives',
        money: { amount: '10.00', currency: 'BRL' },
      }),
    );

    clock.advance(2_000);
    const worker = createWorker(clock, 'ttl-worker', { maxAttempts: 10, ttlMs: 2_000 });
    expect(await worker.processOnce()).toMatchObject({ claimed: 1, expired: 1 });

    const rows = await dataSource.manager.query<
      Array<{ status: string; failureCode: string; ledger: string; rejectedEvents: string }>
    >(
      `SELECT
         wager_transaction.status,
         wager_transaction.failure_code AS "failureCode",
         (SELECT count(*)::text FROM wallet_ledger_entries WHERE transaction_id = wager_transaction.id) AS ledger,
         (SELECT count(*)::text FROM outbox_messages
          WHERE aggregate_id = wager_transaction.wallet_id AND event_type = 'WagerTransactionRejected') AS "rejectedEvents"
       FROM wager_transactions wager_transaction WHERE wager_transaction.id = $1`,
      [pending.transactionId],
    );
    expect(rows).toEqual([
      {
        status: 'REJECTED',
        failureCode: 'error.wager.reference_not_found',
        ledger: '0',
        rejectedEvents: '1',
      },
    ]);
    expect(worker.metrics.snapshot()).toMatchObject({ expired: 1, attempts: 1 });
  });
});

function createProcessor(clock: Clock): ProcessWagerTransactionUseCase {
  return new ProcessWagerTransactionUseCase(
    FinancialUnitOfWork.fromEntityManager(dataSource.manager),
    new RandomIdGenerator(),
    clock,
    undefined,
    () => Promise.resolve(),
  );
}

function createWorker(
  clock: Clock,
  id: string,
  overrides: Partial<PendingReferenceWorkerOptions> = {},
): PendingReferenceWorker {
  const options: PendingReferenceWorkerOptions = {
    enabled: false,
    batchSize: 10,
    pollIntervalMs: 1,
    leaseDurationMs: 30_000,
    shutdownTimeoutMs: 1,
    maxAttempts: 10,
    ttlMs: 30 * 60 * 1_000,
    retryPolicy: new ExponentialRetryPolicy({
      baseDelayMs: 2_000,
      maxDelayMs: 5 * 60 * 1_000,
      maxAttempts: 10,
      jitterRatio: 0,
    }),
    ...overrides,
  };
  return new PendingReferenceWorker(
    createProcessor(clock),
    FinancialUnitOfWork.fromEntityManager(dataSource.manager),
    clock,
    new FixedIdGenerator(id),
    options,
  );
}

async function createWallet(
  initialBalance: string,
  clock: Clock,
): Promise<{ id: string; playerId: string }> {
  return new CreateWalletUseCase(
    FinancialUnitOfWork.fromEntityManager(dataSource.manager),
    new RandomIdGenerator(),
    clock,
  ).execute({
    playerId: randomUUID(),
    initialBalance: { amount: initialBalance, currency: 'BRL' },
  });
}

function wagerInput(
  wallet: { id: string; playerId: string },
  overrides: Partial<ProcessWagerTransactionInput>,
): ProcessWagerTransactionInput {
  return {
    providerId: 'phase10-provider',
    externalTransactionId: `external-${randomUUID()}`,
    idempotencyKey: `key-${randomUUID()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'phase10-round',
    gameId: 'phase10-game',
    kind: WagerTransactionKind.Bet,
    money: { amount: '1.00', currency: 'BRL' },
    ...overrides,
  };
}

if (!runRealIntegration) {
  test('real Phase 10 pending-reference worker integration is opt-in', () => {
    expect(true).toBe(true);
  });
}
