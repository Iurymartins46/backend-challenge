import { DomainInvariantError, WagerRuleError } from './errors';
import type { FailureCode } from './errors';
import type { LedgerDirection } from './ledger';
import type { WalletLedgerEntry } from './ledger';
import type { MoneyProps } from './money';
import { WagerTransactionStatus } from './wager-transaction';
import type { WagerTransaction, WagerTransactionKind } from './wager-transaction';
import type { Wallet } from './wallet';

export interface EventContext {
  readonly correlationId: string;
  readonly causationId?: string;
  readonly eventId?: string;
  readonly occurredAt?: Date;
}

export interface IntegrationEventProps<T> {
  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: T;
}

export interface IntegrationEventJSON<T> {
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: string;
  readonly version: number;
  readonly data: T;
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new DomainInvariantError(`${field} must not be empty.`);
  }
}

function cloneDate(date: Date): Date {
  if (Number.isNaN(date.getTime())) {
    throw new DomainInvariantError('Integration event date must be valid.');
  }

  return new Date(date.getTime());
}

function contextDate(context: EventContext, fallback: Date): Date {
  return cloneDate(context.occurredAt ?? fallback);
}

function contextProps(
  context: EventContext,
  fallback: Date,
): Pick<IntegrationEventProps<unknown>, 'correlationId' | 'causationId' | 'occurredAt'> {
  assertNonEmpty(context.correlationId, 'Correlation id');
  if (context.causationId !== undefined) {
    assertNonEmpty(context.causationId, 'Causation id');
  }

  return {
    correlationId: context.correlationId,
    ...(context.causationId === undefined ? {} : { causationId: context.causationId }),
    occurredAt: contextDate(context, fallback),
  };
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId: string | undefined;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    assertNonEmpty(props.eventId, 'Event id');
    assertNonEmpty(props.aggregateId, 'Event aggregate id');
    assertNonEmpty(props.correlationId, 'Correlation id');
    if (props.causationId !== undefined) {
      assertNonEmpty(props.causationId, 'Causation id');
    }

    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = cloneDate(props.occurredAt);
    this.data = props.data;
  }

  toJSON(): IntegrationEventJSON<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId === undefined ? {} : { causationId: this.causationId }),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data,
    };
  }
}

export interface WagerTransactionProcessedData {
  readonly transactionId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly walletId: string;
  readonly kind: WagerTransactionKind;
  readonly status: WagerTransactionStatus.Processed;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId?: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionProcessedData>) {
    super(props);
  }

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionProcessed {
    if (transaction.status !== WagerTransactionStatus.Processed) {
      throw new DomainInvariantError('Only processed transactions can emit a processed event.');
    }

    return new WagerTransactionProcessed({
      eventId: context.eventId ?? transaction.id,
      aggregateId: transaction.walletId,
      ...contextProps(context, transaction.processedAt ?? transaction.createdAt),
      data: {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        walletId: transaction.walletId,
        kind: transaction.kind,
        status: WagerTransactionStatus.Processed,
        money: transaction.money.toJSON(),
        ...(transaction.referenceExternalTransactionId === undefined
          ? {}
          : { referenceExternalTransactionId: transaction.referenceExternalTransactionId }),
      },
    });
  }
}

export interface WagerTransactionRejectedData {
  readonly transactionId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly walletId: string;
  readonly kind: WagerTransactionKind;
  readonly status: WagerTransactionStatus.Rejected;
  readonly money: MoneyProps;
  readonly failureCode: FailureCode;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionRejectedData>) {
    super(props);
  }

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionRejected {
    if (transaction.status !== WagerTransactionStatus.Rejected) {
      throw new DomainInvariantError('Only rejected transactions can emit a rejected event.');
    }

    if (transaction.failureCode === undefined) {
      throw new DomainInvariantError('A rejected transaction must have a failure code.');
    }

    return new WagerTransactionRejected({
      eventId: context.eventId ?? transaction.id,
      aggregateId: transaction.walletId,
      ...contextProps(context, transaction.createdAt),
      data: {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        walletId: transaction.walletId,
        kind: transaction.kind,
        status: WagerTransactionStatus.Rejected,
        money: transaction.money.toJSON(),
        failureCode: transaction.failureCode,
      },
    });
  }
}

export interface WalletBalanceChangedData {
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: MoneyProps;
  readonly balanceBefore: MoneyProps;
  readonly balanceAfter: MoneyProps;
  readonly walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WalletBalanceChangedData>) {
    super(props);
  }

  static from(
    wallet: Wallet,
    entry: WalletLedgerEntry,
    context: EventContext,
  ): WalletBalanceChanged {
    if (entry.walletId !== wallet.id) {
      throw new WagerRuleError(
        'error.wager.reference_context_mismatch',
        'The ledger entry belongs to another wallet.',
      );
    }

    if (!entry.isBalanced() || !entry.balanceAfter.equals(wallet.balance)) {
      throw new DomainInvariantError('Wallet balance event does not match the ledger entry.');
    }

    return new WalletBalanceChanged({
      eventId: entry.id,
      aggregateId: wallet.id,
      ...contextProps(context, entry.createdAt),
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}

export interface WagerTransactionPendingReferenceData {
  readonly transactionId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly walletId: string;
  readonly kind: WagerTransactionKind;
  readonly status: WagerTransactionStatus.PendingReference;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionPendingReferenceData>) {
    super(props);
  }

  static from(
    transaction: WagerTransaction,
    context: EventContext,
  ): WagerTransactionPendingReference {
    if (transaction.status !== WagerTransactionStatus.PendingReference) {
      throw new DomainInvariantError(
        'Only pending-reference transactions can emit a pending-reference event.',
      );
    }

    if (transaction.referenceExternalTransactionId === undefined) {
      throw new DomainInvariantError('A pending-reference event must identify its reference.');
    }

    return new WagerTransactionPendingReference({
      eventId: context.eventId ?? transaction.id,
      aggregateId: transaction.walletId,
      ...contextProps(context, transaction.createdAt),
      data: {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        walletId: transaction.walletId,
        kind: transaction.kind,
        status: WagerTransactionStatus.PendingReference,
        money: transaction.money.toJSON(),
        referenceExternalTransactionId: transaction.referenceExternalTransactionId,
      },
    });
  }
}
