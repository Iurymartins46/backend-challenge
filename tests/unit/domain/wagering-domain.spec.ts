import { describe, expect, test } from 'bun:test';

import {
  DomainInvariantError,
  ExponentialRetryPolicy,
  InboxMessage,
  InsufficientFundsError,
  InvalidTransactionStateError,
  LedgerDirection,
  Money,
  MoneyCurrencyMismatchError,
  OutboxMessage,
  ReversalNegativeBalanceError,
  WagerRuleError,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WagerTransactionStatus,
  Wallet,
  WalletBalanceChanged,
  WalletLedgerEntry,
} from '../../../src/modules/wagering/domain';
import type { CreateWagerTransactionProps } from '../../../src/modules/wagering/domain';

const at = new Date('2026-09-01T12:00:00.000Z');
const context = { correlationId: 'correlation-1', causationId: 'message-1' };

function money(amount: string, currency = 'BRL'): Money {
  return Money.from({ amount, currency });
}

function transaction(
  kind: WagerTransactionKind,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  return WagerTransaction.create({
    id: overrides.id ?? `${kind.toLowerCase()}-id`,
    providerId: overrides.providerId ?? 'provider-a',
    externalTransactionId: overrides.externalTransactionId ?? `${kind.toLowerCase()}-external`,
    idempotencyKey: overrides.idempotencyKey ?? `${kind.toLowerCase()}-key`,
    payloadHash: overrides.payloadHash ?? `${kind.toLowerCase()}-hash`,
    walletId: overrides.walletId ?? 'wallet-1',
    playerId: overrides.playerId ?? 'player-1',
    roundId: overrides.roundId ?? 'round-1',
    gameId: overrides.gameId ?? 'game-1',
    kind,
    money: overrides.money ?? money('10.00'),
    referenceExternalTransactionId: overrides.referenceExternalTransactionId,
    createdAt: overrides.createdAt ?? at,
  });
}

function processed(
  kind: WagerTransactionKind,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  const wager = transaction(kind, overrides);
  wager.markProcessed(kind === WagerTransactionKind.Bet ? undefined : `reference-${kind}`, at);
  return wager;
}

describe('Wallet', () => {
  test('opens, changes balance and increments version only on movement', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: money('100.00'),
      createdAt: at,
    });

    expect(wallet.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(wallet.version).toBe(1);

    const debit = wallet.debit(money('25.00'), at);
    expect(debit).toMatchObject({ direction: LedgerDirection.Debit, walletVersion: 2 });
    expect(debit.balanceBefore.toString()).toBe('100.00');
    expect(debit.balanceAfter.toString()).toBe('75.00');
    expect(wallet.balance.toString()).toBe('75.00');

    const credit = wallet.credit(money('5.00'), new Date(at.getTime() + 1));
    expect(credit).toMatchObject({ direction: LedgerDirection.Credit, walletVersion: 3 });
    expect(wallet.balance.toString()).toBe('80.00');
    expect(wallet.updatedAt.getTime()).toBe(at.getTime() + 1);
  });

  test('allows zero opening balance but rejects negative and insufficient movements', () => {
    const zeroWallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: money('0.00'),
      createdAt: at,
    });

    expect(zeroWallet.version).toBe(1);
    expect(() => zeroWallet.debit(money('0.01'), at)).toThrow(InsufficientFundsError);
    expect(() => zeroWallet.debitForReversal(money('0.01'), at)).toThrow(
      ReversalNegativeBalanceError,
    );
    expect(() => zeroWallet.credit(money('0.00'), at)).toThrow(DomainInvariantError);
  });

  test('rejects currency mismatches before changing state', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: money('10.00'),
      createdAt: at,
    });

    expect(() => wallet.debit(money('1.00', 'USD'), at)).toThrow(MoneyCurrencyMismatchError);
    expect(wallet.balance.toString()).toBe('10.00');
    expect(wallet.version).toBe(1);
  });
});

describe('WagerTransaction', () => {
  test('maps operations to directions and keeps LOSS without a ledger', () => {
    const bet = transaction(WagerTransactionKind.Bet);
    const win = transaction(WagerTransactionKind.Win);
    const loss = transaction(WagerTransactionKind.Loss);
    const refund = transaction(WagerTransactionKind.Refund, {
      referenceExternalTransactionId: 'bet-external',
    });
    const rollback = transaction(WagerTransactionKind.Rollback, {
      referenceExternalTransactionId: 'bet-external',
    });
    const opening = transaction(WagerTransactionKind.Opening);
    const processedBet = processed(WagerTransactionKind.Bet, {
      externalTransactionId: 'bet-external',
    });

    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(win.ledgerDirectionFor(processedBet)).toBe(LedgerDirection.Credit);
    expect(refund.ledgerDirectionFor(processedBet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(processedBet)).toBe(LedgerDirection.Credit);
    expect(opening.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(
      transaction(WagerTransactionKind.Rollback, {
        referenceExternalTransactionId: 'win-external',
      }).ledgerDirectionFor(
        processed(WagerTransactionKind.Win, { externalTransactionId: 'win-external' }),
      ),
    ).toBe(LedgerDirection.Debit);
    expect(
      transaction(WagerTransactionKind.Rollback, {
        referenceExternalTransactionId: 'refund-external',
      }).ledgerDirectionFor(
        processed(WagerTransactionKind.Refund, {
          externalTransactionId: 'refund-external',
          referenceExternalTransactionId: 'bet-external',
        }),
      ),
    ).toBe(LedgerDirection.Debit);
    expect(loss.affectsBalance()).toBe(false);
    expect(() => loss.ledgerDirectionFor()).toThrow(DomainInvariantError);
  });

  test('supports only non-terminal transitions and preserves terminality', () => {
    const pending = transaction(WagerTransactionKind.Bet);
    expect(pending.status).toBe(WagerTransactionStatus.Pending);
    pending.markProcessed(undefined, at);
    expect(pending.isTerminal()).toBe(true);
    expect(() => pending.reject('error.wager.insufficient_funds')).toThrow(
      InvalidTransactionStateError,
    );

    const pendingReference = transaction(WagerTransactionKind.Refund, {
      referenceExternalTransactionId: 'bet-external',
    });
    pendingReference.markPendingReference();
    pendingReference.markPendingReference();
    expect(pendingReference.status).toBe(WagerTransactionStatus.PendingReference);
    pendingReference.reject('error.wager.reference_not_found');
    expect(pendingReference.failureCode).toBe('error.wager.reference_not_found');
    expect(() => pendingReference.fail('error.infrastructure.internal_error')).toThrow(
      InvalidTransactionStateError,
    );
  });

  test('requires compatible references and exact reversal values', () => {
    const bet = processed(WagerTransactionKind.Bet, {
      externalTransactionId: 'bet-external',
    });
    const refund = transaction(WagerTransactionKind.Refund, {
      referenceExternalTransactionId: 'bet-external',
    });
    refund.assertReferenceCompatible(bet);

    const wrongKind = processed(WagerTransactionKind.Win, {
      id: 'win-id',
      externalTransactionId: 'win-external',
    });
    expect(() => refund.assertReferenceCompatible(wrongKind)).toThrow(WagerRuleError);

    const wrongAmount = transaction(WagerTransactionKind.Refund, {
      referenceExternalTransactionId: 'bet-external',
      money: money('11.00'),
    });
    expect(() => wrongAmount.assertReferenceCompatible(bet)).toThrow(WagerRuleError);

    const wrongContext = processed(WagerTransactionKind.Bet, {
      id: 'other-bet-id',
      externalTransactionId: 'other-bet-external',
      walletId: 'wallet-2',
    });
    expect(() => refund.assertReferenceCompatible(wrongContext)).toThrow(WagerRuleError);

    const wrongCurrency = processed(WagerTransactionKind.Bet, {
      id: 'usd-bet-id',
      externalTransactionId: 'usd-bet-external',
      money: money('10.00', 'USD'),
    });
    expect(() => refund.assertReferenceCompatible(wrongCurrency)).toThrow(WagerRuleError);
    expect(() => refund.assertReferenceCompatible(undefined)).toThrow(WagerRuleError);
  });

  test('detects one processed reversal per reference and kind', () => {
    const refund = transaction(WagerTransactionKind.Refund, {
      referenceExternalTransactionId: 'bet-external',
    });
    const existingRefund = processed(WagerTransactionKind.Refund, {
      referenceExternalTransactionId: 'bet-external',
    });

    expect(() => refund.assertNoProcessedReversal([existingRefund])).toThrow(WagerRuleError);
  });
});

describe('WalletLedgerEntry, inbox and outbox', () => {
  test('creates a balanced ledger entry and detects bad rehydrated state', () => {
    const entry = WalletLedgerEntry.create({
      id: 'ledger-1',
      walletId: 'wallet-1',
      transactionId: 'transaction-1',
      direction: LedgerDirection.Debit,
      money: money('25.00'),
      balanceBefore: money('100.00'),
      balanceAfter: money('75.00'),
      createdAt: at,
    });

    expect(entry.isBalanced()).toBe(true);
    expect(() => WalletLedgerEntry.create({ ...entry, balanceAfter: money('76.00') })).toThrow(
      DomainInvariantError,
    );

    const invalidPersistedEntry = WalletLedgerEntry.rehydrate({
      ...entry,
      balanceAfter: money('76.00'),
    });
    expect(invalidPersistedEntry.isBalanced()).toBe(false);
  });

  test('marks inbox once and applies bounded exponential retry to outbox', () => {
    const inbox = InboxMessage.receive({
      messageId: 'message-1',
      consumerName: 'wager-consumer',
      payloadHash: 'hash-1',
      receivedAt: at,
    });
    expect(inbox.isProcessed()).toBe(false);
    inbox.markProcessed(at);
    expect(inbox.isProcessed()).toBe(true);
    expect(() => inbox.markProcessed(at)).toThrow(DomainInvariantError);

    const transactionProcessed = processed(WagerTransactionKind.Bet);
    const event = WagerTransactionProcessed.from(transactionProcessed, context);
    const outbox = OutboxMessage.enqueue(event);
    const policy = new ExponentialRetryPolicy({
      baseDelayMs: 100,
      maxDelayMs: 250,
      maxAttempts: 2,
    });

    expect(outbox.isDue(at)).toBe(true);
    outbox.scheduleRetry(at, policy);
    expect(outbox.attempts).toBe(1);
    expect(outbox.nextAttemptAt?.getTime()).toBe(at.getTime() + 100);
    outbox.scheduleRetry(at, policy);
    expect(outbox.nextAttemptAt?.getTime()).toBe(at.getTime() + 200);
    expect(() => outbox.scheduleRetry(at, policy)).toThrow(DomainInvariantError);
    outbox.markPublished(at);
    expect(outbox.isPending()).toBe(false);
    expect(outbox.isDue(at)).toBe(false);
  });
});

describe('Integration events', () => {
  test('serializes four event types with MoneyProps and no bigint or Money instances', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: money('100.00'),
      createdAt: at,
    });
    const change = wallet.debit(money('25.00'), at);
    const entry = WalletLedgerEntry.create({
      id: 'ledger-1',
      walletId: wallet.id,
      transactionId: 'bet-id',
      direction: change.direction,
      money: change.money,
      balanceBefore: change.balanceBefore,
      balanceAfter: change.balanceAfter,
      createdAt: at,
    });
    const bet = processed(WagerTransactionKind.Bet, { id: 'bet-id' });
    const rejected = transaction(WagerTransactionKind.Bet, { id: 'rejected-id' });
    rejected.reject('error.wager.insufficient_funds');
    const pending = transaction(WagerTransactionKind.Refund, {
      id: 'pending-id',
      referenceExternalTransactionId: 'bet-external',
    });
    pending.markPendingReference();

    const events = [
      WagerTransactionProcessed.from(bet, context),
      WagerTransactionRejected.from(rejected, context),
      WalletBalanceChanged.from(wallet, entry, context),
      WagerTransactionPendingReference.from(pending, context),
    ];
    const serialized = events.map((event) => JSON.stringify(event));

    expect(serialized.every((payload) => !payload.includes('bigint'))).toBe(true);
    expect(serialized[0]).toContain('"amount":"10.00"');
    expect(events[2]?.data.money).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(events[2]?.data.money).not.toBeInstanceOf(Money);
    expect(events.map((event) => event.eventType)).toEqual([
      'WagerTransactionProcessed',
      'WagerTransactionRejected',
      'WalletBalanceChanged',
      'WagerTransactionPendingReference',
    ]);
  });
});
