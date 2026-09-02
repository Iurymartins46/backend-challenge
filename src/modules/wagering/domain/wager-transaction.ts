import {
  DomainInvariantError,
  InvalidTransactionStateError,
  NoLedgerForTransactionError,
  WagerRuleError,
  isBusinessFailureCode,
  isInfrastructureFailureCode,
} from './errors';
import type { FailureCode } from './errors';
import { LedgerDirection } from './ledger';
import type { Money } from './money';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export interface CreateWagerTransactionProps {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId?: string;
  readonly createdAt?: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  readonly createdAt: Date;
  readonly status: WagerTransactionStatus;
  readonly referenceTransactionId?: string;
  readonly failureCode?: FailureCode;
  readonly processedAt?: Date;
  readonly resultBalance?: Money;
  readonly resultWalletVersion?: number;
  readonly nextReferenceAttemptAt?: Date;
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new DomainInvariantError(`${field} must not be empty.`);
  }
}

function cloneDate(date: Date): Date {
  if (Number.isNaN(date.getTime())) {
    throw new DomainInvariantError('Transaction date must be valid.');
  }

  return new Date(date.getTime());
}

function isReferenceKind(kind: WagerTransactionKind): boolean {
  return kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _resultBalance?: Money,
    private _resultWalletVersion?: number,
    private _nextReferenceAttemptAt?: Date,
  ) {}

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    assertNonEmpty(props.id, 'Transaction id');
    assertNonEmpty(props.providerId, 'Provider id');
    assertNonEmpty(props.externalTransactionId, 'External transaction id');
    assertNonEmpty(props.idempotencyKey, 'Idempotency key');
    assertNonEmpty(props.payloadHash, 'Payload hash');
    assertNonEmpty(props.walletId, 'Wallet id');
    assertNonEmpty(props.playerId, 'Player id');
    assertNonEmpty(props.roundId, 'Round id');
    assertNonEmpty(props.gameId, 'Game id');

    if (!Object.values(WagerTransactionKind).includes(props.kind)) {
      throw new DomainInvariantError(`Unknown transaction kind: ${String(props.kind)}.`);
    }

    if (!props.money.isPositive()) {
      throw new DomainInvariantError('Transaction money must be positive.');
    }

    if (isReferenceKind(props.kind)) {
      if (props.referenceExternalTransactionId?.trim() === '') {
        throw new DomainInvariantError('A reference transaction id must not be empty.');
      }

      if (props.referenceExternalTransactionId === undefined) {
        throw new WagerRuleError(
          'error.wager.reference_not_found',
          `${props.kind} requires a reference transaction id.`,
        );
      }
    } else if (
      props.kind === WagerTransactionKind.Bet ||
      props.kind === WagerTransactionKind.Loss ||
      props.kind === WagerTransactionKind.Opening
    ) {
      if (props.referenceExternalTransactionId !== undefined) {
        throw new DomainInvariantError(`${props.kind} cannot have a reference.`);
      }
    }

    const createdAt = cloneDate(props.createdAt ?? new Date());
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      createdAt,
      WagerTransactionStatus.Pending,
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      cloneDate(state.createdAt),
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt === undefined ? undefined : cloneDate(state.processedAt),
      state.resultBalance,
      state.resultWalletVersion,
      state.nextReferenceAttemptAt === undefined
        ? undefined
        : cloneDate(state.nextReferenceAttemptAt),
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt === undefined ? undefined : new Date(this._processedAt.getTime());
  }

  get resultBalance(): Money | undefined {
    return this._resultBalance;
  }

  get resultWalletVersion(): number | undefined {
    return this._resultWalletVersion;
  }

  get nextReferenceAttemptAt(): Date | undefined {
    return this._nextReferenceAttemptAt === undefined
      ? undefined
      : new Date(this._nextReferenceAttemptAt.getTime());
  }

  recordResultSnapshot(balance: Money, walletVersion: number): void {
    if (this._status !== WagerTransactionStatus.Processed) {
      throw new DomainInvariantError('Only processed transactions can store a result snapshot.');
    }

    if (balance.currency !== this.money.currency || balance.isNegative()) {
      throw new DomainInvariantError(
        'Result snapshot must be a non-negative wallet balance in the transaction currency.',
      );
    }

    if (!Number.isInteger(walletVersion) || walletVersion < 1) {
      throw new DomainInvariantError('Result wallet version must be a positive integer.');
    }

    if (this._resultBalance !== undefined || this._resultWalletVersion !== undefined) {
      throw new DomainInvariantError('A transaction result snapshot can only be stored once.');
    }

    this._resultBalance = balance;
    this._resultWalletVersion = walletVersion;
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertCanTransition('mark processed');

    if (this.requiresReference() && referenceTransactionId === undefined) {
      throw new WagerRuleError(
        'error.wager.reference_not_found',
        `${this.kind} cannot be processed without a resolved reference.`,
      );
    }

    if (
      referenceTransactionId !== undefined &&
      (this.kind === WagerTransactionKind.Bet ||
        this.kind === WagerTransactionKind.Loss ||
        this.kind === WagerTransactionKind.Opening)
    ) {
      throw new DomainInvariantError(`${this.kind} cannot be processed with a reference.`);
    }

    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = cloneDate(at);
    this._nextReferenceAttemptAt = undefined;
  }

  markPendingReference(nextReferenceAttemptAt?: Date): void {
    if (this._status === WagerTransactionStatus.PendingReference) {
      return;
    }

    this.assertCanTransition('mark pending reference');
    if (!this.canWaitForReference()) {
      throw new DomainInvariantError(`${this.kind} does not require a reference.`);
    }

    this._status = WagerTransactionStatus.PendingReference;
    this._nextReferenceAttemptAt =
      nextReferenceAttemptAt === undefined ? undefined : cloneDate(nextReferenceAttemptAt);
  }

  schedulePendingReferenceRetry(nextReferenceAttemptAt: Date): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(this._status, 'schedule a pending reference retry');
    }

    this._nextReferenceAttemptAt = cloneDate(nextReferenceAttemptAt);
  }

  reject(code: FailureCode): void {
    this.assertCanTransition('reject');
    if (!isBusinessFailureCode(code)) {
      throw new DomainInvariantError(`Failure code ${code} is not a business rejection.`);
    }

    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._nextReferenceAttemptAt = undefined;
  }

  fail(code: FailureCode): void {
    this.assertCanTransition('fail');
    if (!isInfrastructureFailureCode(code)) {
      throw new DomainInvariantError(`Failure code ${code} is not an infrastructure failure.`);
    }

    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._nextReferenceAttemptAt = undefined;
  }

  isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return isReferenceKind(this.kind);
  }

  canWaitForReference(): boolean {
    return this.requiresReference() || this.referenceExternalTransactionId !== undefined;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
        if (reference !== undefined) {
          this.assertReferenceCompatible(reference);
          if (reference.kind !== WagerTransactionKind.Bet) {
            throw new WagerRuleError(
              'error.wager.reference_invalid_kind',
              'A WIN can reference only a BET.',
            );
          }
        }
        return LedgerDirection.Credit;
      case WagerTransactionKind.Refund:
        this.assertReferenceCompatible(reference);
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback:
        this.assertReferenceCompatible(reference);
        if (reference === undefined) {
          throw new DomainInvariantError('ROLLBACK reference was not resolved.');
        }

        if (reference.kind === WagerTransactionKind.Bet) {
          return LedgerDirection.Credit;
        }

        if (
          reference.kind === WagerTransactionKind.Win ||
          reference.kind === WagerTransactionKind.Refund
        ) {
          return LedgerDirection.Debit;
        }

        throw new NoLedgerForTransactionError(reference.kind);
      case WagerTransactionKind.Loss:
        throw new NoLedgerForTransactionError(this.kind);
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
    }
  }

  assertReferenceCompatible(reference: WagerTransaction | undefined): void {
    if (reference === undefined) {
      throw new WagerRuleError(
        'error.wager.reference_not_found',
        `${this.kind} requires a resolved reference transaction.`,
      );
    }

    if (reference.status !== WagerTransactionStatus.Processed) {
      throw new WagerRuleError(
        'error.wager.reference_not_found',
        'The referenced transaction has not been processed.',
      );
    }

    const contextMatches =
      this.providerId === reference.providerId &&
      this.playerId === reference.playerId &&
      this.walletId === reference.walletId &&
      this.roundId === reference.roundId &&
      this.gameId === reference.gameId;

    if (!contextMatches) {
      throw new WagerRuleError(
        'error.wager.reference_context_mismatch',
        'The referenced transaction belongs to another wagering context.',
      );
    }

    if (!this.money.currency || this.money.currency !== reference.money.currency) {
      throw new WagerRuleError(
        'error.wager.reference_context_mismatch',
        'The referenced transaction uses another currency.',
      );
    }

    if (this.kind === WagerTransactionKind.Refund && reference.kind !== WagerTransactionKind.Bet) {
      throw new WagerRuleError(
        'error.wager.reference_invalid_kind',
        'A REFUND can reference only a BET.',
      );
    }

    if (
      this.kind === WagerTransactionKind.Rollback &&
      reference.kind !== WagerTransactionKind.Bet &&
      reference.kind !== WagerTransactionKind.Win &&
      reference.kind !== WagerTransactionKind.Refund
    ) {
      throw new WagerRuleError(
        'error.wager.reference_invalid_kind',
        'A ROLLBACK can reference only a BET, WIN or REFUND.',
      );
    }

    if (this.kind === WagerTransactionKind.Win && reference.kind !== WagerTransactionKind.Bet) {
      throw new WagerRuleError(
        'error.wager.reference_invalid_kind',
        'A WIN can reference only a BET.',
      );
    }

    if (isReferenceKind(this.kind) && !this.money.equals(reference.money)) {
      throw new WagerRuleError(
        'error.wager.reference_amount_mismatch',
        'The reversal amount must equal the referenced transaction amount.',
      );
    }
  }

  assertNoProcessedReversal(reversals: readonly WagerTransaction[]): void {
    if (!isReferenceKind(this.kind) || this.referenceExternalTransactionId === undefined) {
      throw new DomainInvariantError('Only reversal transactions can be checked for duplicates.');
    }

    const alreadyProcessed = reversals.some(
      (candidate) =>
        candidate !== this &&
        candidate.status === WagerTransactionStatus.Processed &&
        candidate.kind === this.kind &&
        candidate.providerId === this.providerId &&
        candidate.referenceExternalTransactionId === this.referenceExternalTransactionId,
    );

    if (alreadyProcessed) {
      throw new WagerRuleError(
        'error.wager.reversal_already_processed',
        `A ${this.kind} for this reference was already processed.`,
      );
    }
  }

  private assertCanTransition(operation: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this._status, operation);
    }
  }
}
