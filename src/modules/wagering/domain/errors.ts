export type DomainErrorCode =
  | 'error.money.invalid_format'
  | 'error.money.invalid_scale'
  | 'error.money.invalid_currency'
  | 'error.money.negative'
  | 'error.money.out_of_range'
  | 'error.money.currency_mismatch'
  | 'error.wallet.not_found'
  | 'error.wallet.already_exists'
  | 'error.idempotency.payload_conflict'
  | 'error.wager.external_transaction_conflict'
  | 'error.wager.wallet_context_mismatch'
  | 'error.wager.transaction_not_found'
  | 'error.domain.invariant_violation'
  | 'error.wager.insufficient_funds'
  | 'error.wager.reversal_negative_balance'
  | 'error.wager.reference_not_found'
  | 'error.wager.reference_amount_mismatch'
  | 'error.wager.reference_invalid_kind'
  | 'error.wager.reference_context_mismatch'
  | 'error.wager.reversal_already_processed'
  | 'error.messaging.inbox_payload_conflict'
  | 'error.infrastructure.dependency_unavailable'
  | 'error.infrastructure.internal_error';

export type FailureCode =
  | 'error.wager.insufficient_funds'
  | 'error.wager.reversal_negative_balance'
  | 'error.wager.reference_not_found'
  | 'error.wager.reference_amount_mismatch'
  | 'error.wager.reference_invalid_kind'
  | 'error.wager.reference_context_mismatch'
  | 'error.wager.reversal_already_processed'
  | 'error.infrastructure.dependency_unavailable'
  | 'error.infrastructure.internal_error';

const BUSINESS_FAILURE_CODES: ReadonlySet<FailureCode> = new Set([
  'error.wager.insufficient_funds',
  'error.wager.reversal_negative_balance',
  'error.wager.reference_not_found',
  'error.wager.reference_amount_mismatch',
  'error.wager.reference_invalid_kind',
  'error.wager.reference_context_mismatch',
  'error.wager.reversal_already_processed',
]);

const INFRASTRUCTURE_FAILURE_CODES: ReadonlySet<FailureCode> = new Set([
  'error.infrastructure.dependency_unavailable',
  'error.infrastructure.internal_error',
]);

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

export class InvalidTransactionStateError extends DomainInvariantError {
  constructor(status: string, operation: string) {
    super(`Cannot ${operation} a transaction in ${status} state.`);
  }
}

export class WagerRuleError extends DomainError {
  constructor(code: Extract<FailureCode, `error.wager.${string}`>, message: string) {
    super(message, code);
  }
}

export class InsufficientFundsError extends WagerRuleError {
  constructor() {
    super(
      'error.wager.insufficient_funds',
      'The wallet does not have sufficient funds for this bet.',
    );
  }
}

export class ReversalNegativeBalanceError extends WagerRuleError {
  constructor() {
    super(
      'error.wager.reversal_negative_balance',
      'The reversal would produce a negative wallet balance.',
    );
  }
}

export class NoLedgerForTransactionError extends DomainInvariantError {
  constructor(kind: string) {
    super(`Transaction kind ${kind} does not produce a ledger entry.`);
  }
}

export class RetryExhaustedError extends DomainInvariantError {
  constructor() {
    super('The retry policy has no attempts remaining.');
  }
}

export function isBusinessFailureCode(code: FailureCode): boolean {
  return BUSINESS_FAILURE_CODES.has(code);
}

export function isInfrastructureFailureCode(code: FailureCode): boolean {
  return INFRASTRUCTURE_FAILURE_CODES.has(code);
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

export class WalletNotFoundError extends DomainError {
  constructor() {
    super('The requested wallet does not exist.', 'error.wallet.not_found');
  }
}

export class WalletAlreadyExistsError extends DomainError {
  constructor() {
    super('The player already has a wallet in this currency.', 'error.wallet.already_exists');
  }
}

export class IdempotencyPayloadConflictError extends DomainError {
  constructor() {
    super(
      'The idempotency key was reused with another business payload.',
      'error.idempotency.payload_conflict',
    );
  }
}

export class ExternalTransactionConflictError extends DomainError {
  constructor() {
    super(
      'The provider external transaction id was already used with another idempotency key.',
      'error.wager.external_transaction_conflict',
    );
  }
}

export class WagerWalletContextMismatchError extends DomainError {
  constructor() {
    super(
      'The wager player or currency does not match the wallet.',
      'error.wager.wallet_context_mismatch',
    );
  }
}

export class WagerTransactionNotFoundError extends DomainError {
  constructor() {
    super(
      'The requested wagering transaction does not exist.',
      'error.wager.transaction_not_found',
    );
  }
}

export class DependencyUnavailableError extends DomainError {
  constructor() {
    super(
      'A required database dependency is temporarily unavailable.',
      'error.infrastructure.dependency_unavailable',
    );
  }
}

export class InboxPayloadConflictError extends DomainError {
  constructor() {
    super(
      'The application message id was reused with another business payload.',
      'error.messaging.inbox_payload_conflict',
    );
  }
}
