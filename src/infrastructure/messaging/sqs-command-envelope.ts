import { createHash } from 'node:crypto';
import { z } from 'zod';

import { createWagerTransactionSchema } from '../../modules/wagering/presentation/wagering.dto';
import type {
  ProcessWagerTransactionInput,
  WagerInboxContext,
} from '../../modules/wagering/application/transaction.types';
import { canonicalizeJson, type JsonValue } from '../../modules/wagering/application/payload-hash';

export const WAGER_TRANSACTION_REQUESTED_TYPE = 'WagerTransactionRequested';
const ISO_8601_UTC_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const wagerTransactionRequestedDataSchema = createWagerTransactionSchema.extend({
  idempotencyKey: z.string().min(1).max(255),
});

export const wagerTransactionRequestedEnvelopeSchema = z.strictObject({
  messageId: z.string().min(1).max(255),
  type: z.literal(WAGER_TRANSACTION_REQUESTED_TYPE),
  occurredAt: z.string().refine(isCanonicalUtcTimestamp, {
    message: 'occurredAt must be an ISO-8601 date.',
  }),
  data: wagerTransactionRequestedDataSchema,
});

function isCanonicalUtcTimestamp(value: string): boolean {
  if (!ISO_8601_UTC_MILLISECONDS.test(value)) {
    return false;
  }

  const timestamp = new Date(value);
  return !Number.isNaN(timestamp.getTime()) && timestamp.toISOString() === value;
}

export type WagerTransactionRequestedEnvelope = z.infer<
  typeof wagerTransactionRequestedEnvelopeSchema
>;

export interface SqsWagerCommandEnvelope extends WagerTransactionRequestedEnvelope {
  readonly receivedAt: Date;
}

export function parseWagerTransactionRequestedEnvelope(
  body: string,
  receivedAt: Date = new Date(),
): SqsWagerCommandEnvelope {
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(body) as unknown;
  } catch {
    throw new InvalidSqsCommandEnvelopeError('The SQS message body must be valid JSON.');
  }

  const parsed = wagerTransactionRequestedEnvelopeSchema.safeParse(parsedBody);
  if (!parsed.success) {
    throw new InvalidSqsCommandEnvelopeError('The SQS message envelope is invalid.');
  }

  if (Number.isNaN(receivedAt.getTime())) {
    throw new InvalidSqsCommandEnvelopeError('The SQS receive date is invalid.');
  }

  return {
    ...parsed.data,
    receivedAt: new Date(receivedAt.getTime()),
  };
}

export function toProcessWagerTransactionInput(
  envelope: SqsWagerCommandEnvelope,
  consumerName: string,
): ProcessWagerTransactionInput {
  const inbox: WagerInboxContext = {
    consumerName,
    messageId: envelope.messageId,
    payloadHash: hashWagerCommandData(envelope),
    receivedAt: envelope.receivedAt,
  };

  return {
    ...envelope.data,
    correlationId: envelope.messageId,
    inbox,
  };
}

/** The inbox fingerprints the complete command data, including its idempotency key. */
export function hashWagerCommandData(envelope: WagerTransactionRequestedEnvelope): string {
  const data = envelope.data as unknown as JsonValue;
  return createHash('sha256').update(canonicalizeJson(data), 'utf8').digest('hex');
}

export class InvalidSqsCommandEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSqsCommandEnvelopeError';
  }
}
