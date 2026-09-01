import { DomainInvariantError } from './errors';

export interface RetryPolicy {
  readonly maxAttempts: number;
  canRetry(attempt: number): boolean;
  nextAttemptAt(now: Date, attempt: number): Date;
}

export interface ExponentialRetryPolicyProps {
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly maxAttempts?: number;
}

/** Pure, injectable retry calculation. Delays are operational time, not money. */
export class ExponentialRetryPolicy implements RetryPolicy {
  readonly maxAttempts: number;

  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;

  constructor(props: ExponentialRetryPolicyProps = {}) {
    this.baseDelayMs = props.baseDelayMs ?? 1000;
    this.maxDelayMs = props.maxDelayMs ?? 300_000;
    this.maxAttempts = props.maxAttempts ?? 10;

    if (
      !Number.isInteger(this.baseDelayMs) ||
      this.baseDelayMs < 0 ||
      !Number.isInteger(this.maxDelayMs) ||
      this.maxDelayMs < this.baseDelayMs ||
      !Number.isInteger(this.maxAttempts) ||
      this.maxAttempts < 1
    ) {
      throw new DomainInvariantError('Retry policy parameters are invalid.');
    }
  }

  canRetry(attempt: number): boolean {
    return Number.isInteger(attempt) && attempt >= 1 && attempt <= this.maxAttempts;
  }

  nextAttemptAt(now: Date, attempt: number): Date {
    if (!this.canRetry(attempt)) {
      throw new DomainInvariantError('Retry attempt is outside the configured policy.');
    }

    if (Number.isNaN(now.getTime())) {
      throw new DomainInvariantError('Retry date must be valid.');
    }

    const exponentialDelay = this.baseDelayMs * 2 ** (attempt - 1);
    const delay = Math.min(exponentialDelay, this.maxDelayMs);
    return new Date(now.getTime() + delay);
  }
}

export const DEFAULT_RETRY_POLICY = new ExponentialRetryPolicy();
