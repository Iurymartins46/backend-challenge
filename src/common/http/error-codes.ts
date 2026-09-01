export const ErrorCode = {
  RequestInvalidJson: 'error.request.invalid_json',
  RequestInvalid: 'error.request.invalid_request',
  RequestNotFound: 'error.request.not_found',
  RequestConflict: 'error.request.conflict',
  RequestIdempotencyKeyRequired: 'error.request.idempotency_key_required',
  MoneyInvalidFormat: 'error.money.invalid_format',
  MoneyInvalidScale: 'error.money.invalid_scale',
  MoneyInvalidCurrency: 'error.money.invalid_currency',
  MoneyCurrencyMismatch: 'error.money.currency_mismatch',
  WalletNotFound: 'error.wallet.not_found',
  WalletAlreadyExists: 'error.wallet.already_exists',
  IdempotencyPayloadConflict: 'error.idempotency.payload_conflict',
  WagerInsufficientFunds: 'error.wager.insufficient_funds',
  WagerReversalNegativeBalance: 'error.wager.reversal_negative_balance',
  WagerReferenceNotFound: 'error.wager.reference_not_found',
  WagerReferenceAmountMismatch: 'error.wager.reference_amount_mismatch',
  InfrastructureDependencyUnavailable: 'error.infrastructure.dependency_unavailable',
  InfrastructureInternalError: 'error.infrastructure.internal_error',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ErrorCodeDescription {
  readonly status: number;
  readonly meaning: string;
  readonly clientAction: string;
}

export const ERROR_CATALOG: Readonly<Record<ErrorCode, ErrorCodeDescription>> = {
  [ErrorCode.RequestInvalidJson]: {
    status: 400,
    meaning: 'The request body is not valid JSON.',
    clientAction: 'Correct the request body.',
  },
  [ErrorCode.RequestInvalid]: {
    status: 400,
    meaning: 'The request is invalid.',
    clientAction: 'Correct the request.',
  },
  [ErrorCode.RequestNotFound]: {
    status: 404,
    meaning: 'The requested resource does not exist.',
    clientAction: 'Check the resource identifier.',
  },
  [ErrorCode.RequestConflict]: {
    status: 409,
    meaning: 'The request conflicts with persisted state.',
    clientAction: 'Correct the request or use a new idempotency key.',
  },
  [ErrorCode.RequestIdempotencyKeyRequired]: {
    status: 400,
    meaning: 'The idempotency key is required.',
    clientAction: 'Send the Idempotency-Key header.',
  },
  [ErrorCode.MoneyInvalidFormat]: {
    status: 400,
    meaning: 'The amount has an invalid decimal format.',
    clientAction: 'Send a canonical decimal string.',
  },
  [ErrorCode.MoneyInvalidScale]: {
    status: 400,
    meaning: 'The amount does not have exactly two decimal places.',
    clientAction: 'Correct the amount.',
  },
  [ErrorCode.MoneyInvalidCurrency]: {
    status: 400,
    meaning: 'The currency is not a valid ISO-4217 code.',
    clientAction: 'Correct the currency.',
  },
  [ErrorCode.MoneyCurrencyMismatch]: {
    status: 422,
    meaning: 'The operation uses a different currency from the wallet.',
    clientAction: 'Use the wallet currency.',
  },
  [ErrorCode.WalletNotFound]: {
    status: 404,
    meaning: 'The wallet does not exist.',
    clientAction: 'Check the wallet identifier.',
  },
  [ErrorCode.WalletAlreadyExists]: {
    status: 409,
    meaning: 'The player already has a wallet in this currency.',
    clientAction: 'Use the existing wallet.',
  },
  [ErrorCode.IdempotencyPayloadConflict]: {
    status: 409,
    meaning: 'The idempotency key was reused with another payload.',
    clientAction: 'Correct the key or payload.',
  },
  [ErrorCode.WagerInsufficientFunds]: {
    status: 422,
    meaning: 'The wallet does not have enough funds for the bet.',
    clientAction: 'Do not retry without a balance change.',
  },
  [ErrorCode.WagerReversalNegativeBalance]: {
    status: 422,
    meaning: 'The reversal would produce a negative wallet balance.',
    clientAction: 'Resolve the wallet state before retrying.',
  },
  [ErrorCode.WagerReferenceNotFound]: {
    status: 422,
    meaning: 'The referenced transaction was not found within the retry policy.',
    clientAction: 'Send or make the referenced transaction available.',
  },
  [ErrorCode.WagerReferenceAmountMismatch]: {
    status: 422,
    meaning: 'The reversal amount differs from the referenced transaction.',
    clientAction: 'Correct the reversal amount.',
  },
  [ErrorCode.InfrastructureDependencyUnavailable]: {
    status: 503,
    meaning: 'A required dependency is temporarily unavailable.',
    clientAction: 'Respect Retry-After before retrying.',
  },
  [ErrorCode.InfrastructureInternalError]: {
    status: 500,
    meaning: 'An unexpected internal error occurred.',
    clientAction: 'Retry only according to the endpoint contract.',
  },
};
