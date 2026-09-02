import { createHash } from 'node:crypto';
import { z } from 'zod';

import { createWagerTransactionSchema } from '../../modules/wagering/presentation/wagering.dto';
import type {
  ProcessWagerTransactionInput,
  WagerInboxContext,
} from '../../modules/wagering/application/transaction.types';
import { canonicalizeJson, type JsonValue } from '../../modules/wagering/application/payload-hash';

export const WAGER_TRANSACTION_COMMAND_TYPE = 'WagerTransactionCommand';
export const WAGER_TRANSACTION_COMMAND_VERSION = 1 as const;

const wagerTransactionCommandDataSchema = createWagerTransactionSchema.extend({
  idempotencyKey: z.string().min(1).max(255),
});

export const wagerTransactionCommandEnvelopeSchema = z.strictObject({
  messageId: z.string().min(1).max(255),
  messageType: z.literal(WAGER_TRANSACTION_COMMAND_TYPE),
  version: z.literal(WAGER_TRANSACTION_COMMAND_VERSION),
  correlationId: z.string().min(1).max(255),
  causationId: z.string().min(1).max(255).optional(),
  occurredAt: z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
    message: 'occurredAt must be an ISO-8601 date.',
  }),
  data: wagerTransactionCommandDataSchema,
});

export type WagerTransactionCommandEnvelope = z.infer<typeof wagerTransactionCommandEnvelopeSchema>;

export interface SqsWagerCommandEnvelope extends WagerTransactionCommandEnvelope {
  readonly receivedAt: Date;
}

export function parseWagerTransactionCommandEnvelope(
  body: string,
  receivedAt: Date = new Date(),
): SqsWagerCommandEnvelope {
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(body) as unknown;
  } catch {
    throw new InvalidSqsCommandEnvelopeError('The SQS message body must be valid JSON.');
  }

  const parsed = wagerTransactionCommandEnvelopeSchema.safeParse(parsedBody);
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
    correlationId: envelope.correlationId,
    ...(envelope.causationId === undefined ? {} : { causationId: envelope.causationId }),
    inbox,
  };
}

/** The inbox fingerprints the complete command data, including its idempotency key. */
export function hashWagerCommandData(envelope: WagerTransactionCommandEnvelope): string {
  const data = envelope.data as unknown as JsonValue;
  return createHash('sha256').update(canonicalizeJson(data), 'utf8').digest('hex');
}

export class InvalidSqsCommandEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSqsCommandEnvelopeError';
  }
}
