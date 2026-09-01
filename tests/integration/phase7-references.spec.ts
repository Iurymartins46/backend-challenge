import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';

import dataSource from '../../src/infrastructure/database/data-source';
import { FinancialUnitOfWork } from '../../src/infrastructure/database/financial-unit-of-work';
import {
  ProcessWagerTransactionUseCase,
  type ProcessWagerTransactionInput,
} from '../../src/modules/wagering/application';
import { CreateWalletUseCase } from '../../src/modules/wallet/application';
import {
  RandomIdGenerator,
  SystemClock,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/modules/wagering/domain';

const runRealIntegration = process.env.RUN_REAL_INTEGRATION_TESTS === 'true';
const integration = runRealIntegration ? describe : describe.skip;

integration('Phase 7 references, refunds and rollbacks', () => {
  beforeAll(async () => {
    await dataSource.initialize();
    await dataSource.runMigrations();
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  test('resolves a pending REFUND after its BET is committed', async () => {
    const useCase = createUseCase();
    const wallet = await createWallet('100.00');
    const providerId = `phase7-pending-${wallet.id}`;
    const refundInput = wagerInput(wallet, {
      providerId,
      externalTransactionId: 'refund-late',
      idempotencyKey: 'refund-late-key',
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'bet-late',
      money: { amount: '25.00', currency: 'BRL' },
    });

    const pending = await useCase.execute(refundInput);
    expect(pending).toMatchObject({
      status: WagerTransactionStatus.PendingReference,
      idempotentReplay: false,
    });

    const pendingRows = await dataSource.manager.query<
      Array<{ status: string; nextReferenceAttemptAt: Date | null }>
    >(
      `SELECT status, next_reference_attempt_at AS "nextReferenceAttemptAt"
       FROM wager_transactions WHERE id = $1`,
      [pending.transactionId],
    );
    expect(pendingRows[0]?.status).toBe(WagerTransactionStatus.PendingReference);
    expect(pendingRows[0]?.nextReferenceAttemptAt).not.toBeNull();

    const bet = await useCase.execute(
      wagerInput(wallet, {
        providerId,
        externalTransactionId: 'bet-late',
        idempotencyKey: 'bet-late-key',
        kind: WagerTransactionKind.Bet,
        money: { amount: '25.00', currency: 'BRL' },
      }),
    );
    expect(bet.status).toBe(WagerTransactionStatus.Processed);

    const resolved = await useCase.execute(refundInput);
    expect(resolved).toMatchObject({
      status: WagerTransactionStatus.Processed,
      idempotentReplay: true,
      balance: { amount: '100.00', currency: 'BRL' },
    });

    const outboxRows = await dataSource.manager.query<Array<{ eventType: string }>>(
      `SELECT event_type AS "eventType"
       FROM outbox_messages WHERE aggregate_id = $1 ORDER BY occurred_at, id`,
      [wallet.id],
    );
    expect(outboxRows.map((row) => row.eventType).sort()).toEqual(
      [
        'WalletBalanceChanged',
        'WagerTransactionPendingReference',
        'WagerTransactionProcessed',
        'WalletBalanceChanged',
        'WagerTransactionProcessed',
        'WalletBalanceChanged',
      ].sort(),
    );
  });

  test('applies the three ROLLBACK directions and prevents concurrent duplicate REFUNDs', async () => {
    const useCase = createUseCase();
    const wallet = await createWallet('100.00');
    const providerId = `phase7-directions-${wallet.id}`;
    const process = (overrides: Partial<ProcessWagerTransactionInput>) =>
      useCase.execute(wagerInput(wallet, { providerId, ...overrides }));

    const bet = await process({
      externalTransactionId: 'bet',
      idempotencyKey: 'bet-key',
      kind: WagerTransactionKind.Bet,
      money: { amount: '30.00', currency: 'BRL' },
    });
    const rollbackBet = await process({
      externalTransactionId: 'rollback-bet',
      idempotencyKey: 'rollback-bet-key',
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'bet',
      money: { amount: '30.00', currency: 'BRL' },
    });
    const win = await process({
      externalTransactionId: 'win',
      idempotencyKey: 'win-key',
      kind: WagerTransactionKind.Win,
      money: { amount: '40.00', currency: 'BRL' },
    });
    const rollbackWin = await process({
      externalTransactionId: 'rollback-win',
      idempotencyKey: 'rollback-win-key',
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'win',
      money: { amount: '40.00', currency: 'BRL' },
    });
    const refund = await process({
      externalTransactionId: 'refund',
      idempotencyKey: 'refund-key',
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'bet',
      money: { amount: '30.00', currency: 'BRL' },
    });
    const rollbackRefund = await process({
      externalTransactionId: 'rollback-refund',
      idempotencyKey: 'rollback-refund-key',
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'refund',
      money: { amount: '30.00', currency: 'BRL' },
    });

    expect(
      [bet, rollbackBet, win, rollbackWin, refund, rollbackRefund].every(
        (result) => result.status === WagerTransactionStatus.Processed,
      ),
    ).toBe(true);
    expect(
      (
        await useCase.execute(
          wagerInput(wallet, {
            providerId,
            externalTransactionId: 'refund-duplicate-a',
            idempotencyKey: 'refund-duplicate-a-key',
            kind: WagerTransactionKind.Refund,
            referenceExternalTransactionId: 'bet',
            money: { amount: '30.00', currency: 'BRL' },
          }),
        )
      ).status,
    ).toBe(WagerTransactionStatus.Rejected);

    const concurrentBet = await process({
      externalTransactionId: 'bet-concurrent',
      idempotencyKey: 'bet-concurrent-key',
      kind: WagerTransactionKind.Bet,
      money: { amount: '10.00', currency: 'BRL' },
    });
    const concurrentRefunds = await Promise.all(
      (['concurrent-a', 'concurrent-b'] as const).map((suffix) =>
        process({
          externalTransactionId: `refund-${suffix}`,
          idempotencyKey: `refund-${suffix}-key`,
          kind: WagerTransactionKind.Refund,
          referenceExternalTransactionId: 'bet-concurrent',
          money: { amount: '10.00', currency: 'BRL' },
        }),
      ),
    );
    expect(
      concurrentRefunds.filter((result) => result.status === WagerTransactionStatus.Processed),
    ).toHaveLength(1);
    expect(
      concurrentRefunds.filter(
        (result) => result.failureCode === 'error.wager.reversal_already_processed',
      ),
    ).toHaveLength(1);

    const rows = await dataSource.manager.query<
      Array<{ balance: string; ledger: string; duplicateRefunds: string }>
    >(
      `SELECT
         w.balance_minor::text AS balance,
         (SELECT count(*)::text FROM wallet_ledger_entries WHERE wallet_id = w.id) AS ledger,
         (SELECT count(*)::text FROM wager_transactions
          WHERE wallet_id = w.id AND kind = 'REFUND'
            AND reference_transaction_id = $2 AND status = 'PROCESSED') AS "duplicateRefunds"
       FROM wallets w WHERE w.id = $1`,
      [wallet.id, concurrentBet.transactionId],
    );
    expect(rows).toEqual([{ balance: '10000', ledger: '9', duplicateRefunds: '1' }]);
  });

  test('persists invalid reference rules and reversal underflow without ledger effects', async () => {
    const useCase = createUseCase();
    const wallet = await createWallet('0.00');
    const providerId = `phase7-invalid-${wallet.id}`;
    const process = (overrides: Partial<ProcessWagerTransactionInput>) =>
      useCase.execute(wagerInput(wallet, { providerId, ...overrides }));

    await process({
      externalTransactionId: 'win',
      idempotencyKey: 'win-key',
      kind: WagerTransactionKind.Win,
      money: { amount: '10.00', currency: 'BRL' },
    });
    await process({
      externalTransactionId: 'bet',
      idempotencyKey: 'bet-key',
      kind: WagerTransactionKind.Bet,
      money: { amount: '10.00', currency: 'BRL' },
    });

    const rollbackUnderflow = await process({
      externalTransactionId: 'rollback-win',
      idempotencyKey: 'rollback-win-key',
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'win',
      money: { amount: '10.00', currency: 'BRL' },
    });
    expect(rollbackUnderflow).toMatchObject({
      status: WagerTransactionStatus.Rejected,
      failureCode: 'error.wager.reversal_negative_balance',
    });

    const invalidKind = await process({
      externalTransactionId: 'refund-win',
      idempotencyKey: 'refund-win-key',
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'win',
      money: { amount: '10.00', currency: 'BRL' },
    });
    expect(invalidKind.failureCode).toBe('error.wager.reference_invalid_kind');

    const amountMismatch = await process({
      externalTransactionId: 'refund-bet-wrong-amount',
      idempotencyKey: 'refund-bet-wrong-amount-key',
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'bet',
      money: { amount: '9.00', currency: 'BRL' },
    });
    expect(amountMismatch.failureCode).toBe('error.wager.reference_amount_mismatch');

    const contextMismatch = await process({
      externalTransactionId: 'refund-bet-wrong-round',
      idempotencyKey: 'refund-bet-wrong-round-key',
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'bet',
      roundId: 'another-round',
      money: { amount: '10.00', currency: 'BRL' },
    });
    expect(contextMismatch.failureCode).toBe('error.wager.reference_context_mismatch');

    const rows = await dataSource.manager.query<
      Array<{ balance: string; ledger: string; rejected: string }>
    >(
      `SELECT
         w.balance_minor::text AS balance,
         (SELECT count(*)::text FROM wallet_ledger_entries WHERE wallet_id = w.id) AS ledger,
         (SELECT count(*)::text FROM wager_transactions
          WHERE wallet_id = w.id AND status = 'REJECTED') AS rejected
       FROM wallets w WHERE w.id = $1`,
      [wallet.id],
    );
    expect(rows).toEqual([{ balance: '0', ledger: '2', rejected: '4' }]);
  });
});

function createUseCase(): ProcessWagerTransactionUseCase {
  const unitOfWork = FinancialUnitOfWork.fromEntityManager(dataSource.manager);
  return new ProcessWagerTransactionUseCase(
    unitOfWork,
    new RandomIdGenerator(),
    new SystemClock(),
    undefined,
    () => Promise.resolve(),
  );
}

async function createWallet(initialBalance: string): Promise<{
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
  version: number;
}> {
  return new CreateWalletUseCase(
    FinancialUnitOfWork.fromEntityManager(dataSource.manager),
    new RandomIdGenerator(),
    new SystemClock(),
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
    providerId: 'phase7-provider',
    externalTransactionId: `external-${randomUUID()}`,
    idempotencyKey: `key-${randomUUID()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'phase7-round',
    gameId: 'phase7-game',
    kind: WagerTransactionKind.Bet,
    money: { amount: '1.00', currency: 'BRL' },
    ...overrides,
  };
}

if (!runRealIntegration) {
  test('real Phase 7 reference integration is opt-in', () => {
    expect(true).toBe(true);
  });
}
