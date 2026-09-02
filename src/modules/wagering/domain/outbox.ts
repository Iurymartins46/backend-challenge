import { DomainInvariantError, RetryExhaustedError } from './errors';
import { DEFAULT_RETRY_POLICY } from './retry-policy';
import type { RetryPolicy } from './retry-policy';
import type { IntegrationEvent } from './events';

export interface OutboxMessageState {
  readonly id: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
  readonly attempts: number;
  readonly nextAttemptAt?: Date;
  readonly publishedAt?: Date;
  readonly lockedBy?: string;
  readonly lockedUntil?: Date;
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new DomainInvariantError(`${field} must not be empty.`);
  }
}

function cloneDate(date: Date): Date {
  if (Number.isNaN(date.getTime())) {
    throw new DomainInvariantError('Outbox date must be valid.');
  }

  return new Date(date.getTime());
}

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
    private _lockedBy?: string,
    private _lockedUntil?: Date,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const payload: Readonly<Record<string, unknown>> = { ...event.toJSON() };

    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      payload,
      cloneDate(event.occurredAt),
      0,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    assertNonEmpty(state.id, 'Outbox message id');
    assertNonEmpty(state.aggregateId, 'Outbox aggregate id');
    assertNonEmpty(state.eventType, 'Outbox event type');

    if (!Number.isInteger(state.attempts) || state.attempts < 0) {
      throw new DomainInvariantError('Outbox attempts must be a non-negative integer.');
    }

    if (state.lockedBy !== undefined) {
      assertNonEmpty(state.lockedBy, 'Outbox lock owner');
    }

    if ((state.lockedBy === undefined) !== (state.lockedUntil === undefined)) {
      throw new DomainInvariantError('Outbox lease owner and expiry must be set together.');
    }

    if (state.publishedAt !== undefined && state.lockedBy !== undefined) {
      throw new DomainInvariantError('Published outbox messages cannot retain a lease.');
    }

    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      cloneDate(state.occurredAt),
      state.attempts,
      state.nextAttemptAt === undefined ? undefined : cloneDate(state.nextAttemptAt),
      state.publishedAt === undefined ? undefined : cloneDate(state.publishedAt),
      state.lockedBy,
      state.lockedUntil === undefined ? undefined : cloneDate(state.lockedUntil),
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt === undefined ? undefined : new Date(this._nextAttemptAt.getTime());
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt === undefined ? undefined : new Date(this._publishedAt.getTime());
  }

  get lockedBy(): string | undefined {
    return this._lockedBy;
  }

  get lockedUntil(): Date | undefined {
    return this._lockedUntil === undefined ? undefined : new Date(this._lockedUntil.getTime());
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    if (!this.isPending() || Number.isNaN(now.getTime())) {
      return false;
    }

    return this._nextAttemptAt === undefined || this._nextAttemptAt.getTime() <= now.getTime();
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new DomainInvariantError('Outbox message is already published.');
    }

    this._publishedAt = cloneDate(at);
    this._nextAttemptAt = undefined;
    this._lockedBy = undefined;
    this._lockedUntil = undefined;
  }

  scheduleRetry(now: Date, policy: RetryPolicy = DEFAULT_RETRY_POLICY): void {
    if (!this.isPending()) {
      throw new DomainInvariantError('Published outbox messages cannot be retried.');
    }

    const nextAttempt = this._attempts + 1;
    if (!policy.canRetry(nextAttempt)) {
      throw new RetryExhaustedError();
    }

    this._attempts = nextAttempt;
    this._nextAttemptAt = policy.nextAttemptAt(now, nextAttempt);
    this._lockedBy = undefined;
    this._lockedUntil = undefined;
  }

  /**
   * Keeps a permanently pending event retryable after the operational attempt cap.
   * The counter is saturated so a dependency outage cannot discard a confirmed event
   * or overflow the persisted integer while the publisher keeps recovering it.
   */
  deferRetry(now: Date, policy: RetryPolicy = DEFAULT_RETRY_POLICY): void {
    if (!this.isPending()) {
      throw new DomainInvariantError('Published outbox messages cannot be retried.');
    }

    const attempt = Math.max(1, Math.min(this._attempts, policy.maxAttempts));
    this._attempts = attempt;
    this._nextAttemptAt = policy.nextAttemptAt(now, attempt);
    this._lockedBy = undefined;
    this._lockedUntil = undefined;
  }
}
