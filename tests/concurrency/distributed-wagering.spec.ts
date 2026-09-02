import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';

import { DistributedHarness, type WagerInput } from './distributed-harness';

const runDistributedTests = process.env.RUN_REAL_CONCURRENCY_TESTS === 'true';
const distributed = runDistributedTests ? describe : describe.skip;

let harness: DistributedHarness | undefined;

distributed('Phase 13 distributed wagering suite', () => {
  beforeAll(async () => {
    harness = new DistributedHarness();
    await harness.start();
  }, 60000);

  afterAll(async () => {
    await harness?.stop();
  }, 30000);

  test('deduplicates the same BET sent 50 times in parallel across three processes', async () => {
    const active = requireHarness();
    const correlationId = active.nextCorrelationId();
    const wallet = await active.createWallet('100.00', correlationId);
    const input = wager(wallet, {
      providerId: `phase13-duplicate-${randomUUID()}`,
      externalTransactionId: `duplicate-${randomUUID()}`,
      money: '10.00',
    });
    const idempotencyKey = `phase13-duplicate-key-${randomUUID()}`;
    const barrier = startBarrier(50);

    const submissions = await Promise.all(
      Array.from({ length: 50 }, async (_, index) => {
        await barrier.wait();
        return active.submitHttp(index % 3, input, idempotencyKey, correlationId);
      }),
    );

    expect(submissions.filter(({ response }) => response.status === 201)).toHaveLength(1);
    expect(
      submissions.every(({ response }) => response.status === 200 || response.status === 201),
    ).toBe(true);
    expect(new Set(submissions.map(({ body }) => body.transactionId))).toHaveLength(1);
    expect(new Set(submissions.map(({ body }) => body.balance?.amount))).toEqual(
      new Set(['90.00']),
    );

    const audit = await active.auditWallet(wallet.id, correlationId);
    expect(audit).toMatchObject({
      balance: '9000',
      reconstructed: '9000',
      transactions: '2',
      ledger: '2',
    });
  }, 60000);

  test('serializes two concurrent BETs of 80.00 against a 100.00 wallet', async () => {
    const active = requireHarness();
    const correlationId = active.nextCorrelationId();
    const wallet = await active.createWallet('100.00', correlationId);
    const providerId = `phase13-hot-wallet-${randomUUID()}`;
    const barrier = startBarrier(2);
    const inputs = ['first', 'second'].map((suffix) =>
      wager(wallet, {
        providerId,
        externalTransactionId: `hot-${suffix}-${randomUUID()}`,
        money: '80.00',
      }),
    );

    const submissions = await Promise.all(
      inputs.map(async (input, index) => {
        await barrier.wait();
        return active.submitHttp(index, input, `phase13-hot-key-${randomUUID()}`, correlationId);
      }),
    );

    expect(submissions.filter(({ response }) => response.status === 201)).toHaveLength(1);
    expect(submissions.filter(({ response }) => response.status === 422)).toHaveLength(1);
    const audit = await active.auditWallet(wallet.id, correlationId);
    expect(audit).toMatchObject({
      balance: '2000',
      reconstructed: '2000',
      transactions: '3',
      ledger: '2',
    });
  }, 60000);

  test('processes distinct wallets in parallel without a shared global lock', async () => {
    const active = requireHarness();
    const correlationId = active.nextCorrelationId();
    const first = await active.createWallet('100.00', correlationId);
    const second = await active.createWallet('100.00', correlationId);
    const barrier = startBarrier(2);
    const submissions = await Promise.all(
      [first, second].map(async (wallet, index) => {
        await barrier.wait();
        return active.submitHttp(
          index + 1,
          wager(wallet, {
            providerId: `phase13-parallel-${randomUUID()}`,
            externalTransactionId: `parallel-${randomUUID()}`,
            money: '10.00',
          }),
          `phase13-parallel-key-${randomUUID()}`,
          correlationId,
        );
      }),
    );

    expect(submissions.map(({ response }) => response.status)).toEqual([201, 201]);
    expect(await active.auditWallet(first.id, correlationId)).toMatchObject({
      balance: '9000',
      reconstructed: '9000',
    });
    expect(await active.auditWallet(second.id, correlationId)).toMatchObject({
      balance: '9000',
      reconstructed: '9000',
    });
  }, 60000);

  test('redelivers safely after a real process dies after commit and before SQS acknowledgement', async () => {
    const active = requireHarness();
    const correlationId = active.nextCorrelationId();
    const wallet = await active.createWallet('100.00', correlationId);
    const crashInstance = await active.replaceWithCrashInstance();
    const input = wager(wallet, {
      providerId: `phase13-crash-${randomUUID()}`,
      externalTransactionId: `crash-${randomUUID()}`,
      money: '10.00',
    });

    const messageId = await active.sendCommand(
      input,
      `phase13-crash-key-${randomUUID()}`,
      correlationId,
    );
    await active.waitForProcessExit(crashInstance, correlationId);
    await active.restoreThreeInstances();
    await active.waitForTransaction(
      input.providerId,
      input.externalTransactionId,
      'PROCESSED',
      correlationId,
    );

    const inbox = await active.dataSource.query<Array<{ count: string }>>(
      `SELECT count(*)::text AS count
         FROM inbox_messages
         WHERE consumer_name = 'wager-command-consumer' AND message_id = $1 AND processed_at IS NOT NULL`,
      [messageId],
    );
    expect(inbox).toEqual([{ count: '1' }]);
    expect(await active.auditWallet(wallet.id, correlationId)).toMatchObject({
      balance: '9000',
      reconstructed: '9000',
      transactions: '2',
      ledger: '2',
    });
  }, 60000);

  test('runs concurrent real publishers and exposes every committed opening event', async () => {
    const active = requireHarness();
    const correlationId = active.nextCorrelationId();
    const first = await active.createWallet('1.00', correlationId);
    const second = await active.createWallet('1.00', correlationId);

    await active.waitForOutboxPublished([first.id, second.id], correlationId);
    const expectedEventIds = await active.outboxEventIds([first.id, second.id]);
    expect(expectedEventIds).toHaveLength(2);
    const eventIds = await active.receiveEventIds(expectedEventIds, correlationId);
    expect(new Set(eventIds.filter((eventId) => expectedEventIds.includes(eventId)))).toEqual(
      new Set(expectedEventIds),
    );
    await active.auditWallet(first.id, correlationId);
    await active.auditWallet(second.id, correlationId);
  }, 60000);

  test('resolves a REFUND delivered before its BET through the distributed worker', async () => {
    const active = requireHarness();
    const correlationId = active.nextCorrelationId();
    const wallet = await active.createWallet('100.00', correlationId);
    const providerId = `phase13-reference-${randomUUID()}`;
    const betExternalTransactionId = `bet-${randomUUID()}`;
    const refund = wager(wallet, {
      providerId,
      externalTransactionId: `refund-${randomUUID()}`,
      money: '25.00',
      kind: 'REFUND',
      referenceExternalTransactionId: betExternalTransactionId,
      roundId: 'phase13-reference-round',
    });
    const bet = wager(wallet, {
      providerId,
      externalTransactionId: betExternalTransactionId,
      money: '25.00',
      roundId: 'phase13-reference-round',
    });

    await active.sendCommand(refund, `phase13-refund-key-${randomUUID()}`, correlationId);
    await active.waitForTransaction(
      refund.providerId,
      refund.externalTransactionId,
      'PENDING_REFERENCE',
      correlationId,
    );
    await active.sendCommand(bet, `phase13-bet-key-${randomUUID()}`, correlationId);
    await active.waitForTransaction(
      bet.providerId,
      bet.externalTransactionId,
      'PROCESSED',
      correlationId,
    );
    await active.waitForTransaction(
      refund.providerId,
      refund.externalTransactionId,
      'PROCESSED',
      correlationId,
    );

    expect(await active.auditWallet(wallet.id, correlationId)).toMatchObject({
      balance: '10000',
      reconstructed: '10000',
      transactions: '3',
      ledger: '3',
    });
  }, 60000);

  test('keeps the historical idempotency result and ledger invariant after restarting all processes', async () => {
    const active = requireHarness();
    const correlationId = active.nextCorrelationId();
    const wallet = await active.createWallet('100.00', correlationId);
    const input = wager(wallet, {
      providerId: `phase13-restart-${randomUUID()}`,
      externalTransactionId: `restart-${randomUUID()}`,
      money: '25.00',
    });
    const idempotencyKey = `phase13-restart-key-${randomUUID()}`;
    const first = await active.submitHttp(0, input, idempotencyKey, correlationId);
    expect(first.response.status).toBe(201);

    await active.restartInstances();
    const replay = await active.submitHttp(2, input, idempotencyKey, correlationId);
    expect(replay.response.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    expect(await active.auditWallet(wallet.id, correlationId)).toMatchObject({
      balance: '7500',
      reconstructed: '7500',
      transactions: '2',
      ledger: '2',
    });
  }, 60000);

  test('runs migrations in an isolated database and proves schema constraints by direct SQL', async () => {
    const active = requireHarness();
    const correlationId = active.nextCorrelationId();
    const wallet = await active.createWallet('1.00', correlationId);

    await active.assertSchemaConstraints(wallet.id, correlationId);
    expect(await active.auditWallet(wallet.id, correlationId)).toMatchObject({
      balance: '100',
      reconstructed: '100',
      transactions: '1',
      ledger: '1',
    });
  }, 60000);
});

if (!runDistributedTests) {
  test('distributed Phase 13 suite is enabled by bun run test:concurrency', () => {
    expect(true).toBe(true);
  });
}

function requireHarness(): DistributedHarness {
  if (harness === undefined) {
    throw new Error('The distributed Phase 13 harness did not start.');
  }
  return harness;
}

function wager(
  wallet: { readonly id: string; readonly playerId: string },
  overrides: {
    readonly providerId: string;
    readonly externalTransactionId: string;
    readonly money: string;
    readonly kind?: WagerInput['kind'];
    readonly referenceExternalTransactionId?: string;
    readonly roundId?: string;
  },
): WagerInput {
  return {
    providerId: overrides.providerId,
    externalTransactionId: overrides.externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: overrides.roundId ?? `phase13-round-${randomUUID()}`,
    gameId: 'phase13-game',
    kind: overrides.kind ?? 'BET',
    money: { amount: overrides.money, currency: 'BRL' },
    ...(overrides.referenceExternalTransactionId === undefined
      ? {}
      : { referenceExternalTransactionId: overrides.referenceExternalTransactionId }),
  };
}

function startBarrier(parties: number): { readonly wait: () => Promise<void> } {
  let arrived = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    wait: async () => {
      arrived += 1;
      if (arrived === parties) {
        release?.();
      }
      await gate;
    },
  };
}
