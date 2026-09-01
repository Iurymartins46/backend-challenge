export type DomainErrorCode =
  | 'error.money.invalid_format'
  | 'error.money.invalid_scale'
  | 'error.money.invalid_currency'
  | 'error.money.negative'
  | 'error.money.out_of_range'
  | 'error.money.currency_mismatch'
  | 'error.domain.invariant_violation';

export class DomainError extends Error {
  constructor(
    message: string,
    public readonly code: DomainErrorCode,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class DomainInvariantError extends DomainError {
  constructor(message: string) {
    super(message, 'error.domain.invariant_violation');
  }
}

export class MoneyError extends DomainError {}

export class MoneyFormatError extends MoneyError {
  constructor(amount: unknown) {
    super(
      `Money amount must be a canonical decimal string: ${String(amount)}`,
      'error.money.invalid_format',
    );
  }
}

export class MoneyScaleError extends MoneyError {
  constructor(amount: string) {
    super(
      `Money amount must contain exactly two decimal places: ${amount}`,
      'error.money.invalid_scale',
    );
  }
}

export class MoneyCurrencyError extends MoneyError {
  constructor(currency: unknown) {
    super(
      `Money currency must be a three-letter ISO-4217 code: ${String(currency)}`,
      'error.money.invalid_currency',
    );
  }
}

export class MoneyNegativeError extends MoneyError {
  constructor(amount: string) {
    super(
      `Money amount cannot be negative in the external contract: ${amount}`,
      'error.money.negative',
    );
  }
}

export class MoneyRangeError extends MoneyError {
  constructor() {
    super(
      'Money amount is outside the PostgreSQL BIGINT range in minor units.',
      'error.money.out_of_range',
    );
  }
}

export class MoneyCurrencyMismatchError extends MoneyError {
  constructor(leftCurrency: string, rightCurrency: string) {
    super(
      `Money currencies do not match: ${leftCurrency} and ${rightCurrency}.`,
      'error.money.currency_mismatch',
    );
  }
}
