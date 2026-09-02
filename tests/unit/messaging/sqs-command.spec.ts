import { describe, expect, test } from 'bun:test';

import {
  hashWagerCommandData,
  parseWagerTransactionCommandEnvelope,
  toProcessWagerTransactionInput,
} from '../../../src/infrastructure/messaging/sqs-command-envelope';
import {
  SqsCommandConsumer,
  type SqsCommandConsumerOptions,
  type SqsCommandHandlerPort,
} from '../../../src/infrastructure/messaging/sqs-command.consumer';
import { SqsConsumerMetrics } from '../../../src/infrastructure/messaging/sqs-consumer.metrics';
import type { SqsCommandHandlingResult } from '../../../src/infrastructure/messaging/sqs-command-handler';
import type {
  SqsQueuePort,
  SqsTransportMessage,
} from '../../../src/infrastructure/messaging/sqs-queue.port';
import { WagerTransactionStatus } from '../../../src/modules/wagering/domain';

const receivedAt = new Date('2026-09-01T12:00:00.000Z');

function commandEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    messageId: 'application-message-1',
    messageType: 'WagerTransactionCommand',
    version: 1,
    correlationId: 'correlation-1',
    occurredAt: receivedAt.toISOString(),
    data: {
      providerId: 'provider-a',
      externalTransactionId: 'transaction-1',
      idempotencyKey: 'provider-a:transaction-1',
      playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
      walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    },
    ...overrides,
  };
}

function transportMessage(body: string): SqsTransportMessage {
  return {
    transportMessageId: 'sqs-transport-id-1',
    receiptHandle: 'receipt-1',
    body,
  };
}

describe('SQS command envelope', () => {
  test('keeps application message id separate from SQS transport id', () => {
    const envelope = parseWagerTransactionCommandEnvelope(
      JSON.stringify(commandEnvelope()),
      receivedAt,
    );
    const input = toProcessWagerTransactionInput(envelope, 'wager-command-consumer');

    expect(input.inbox).toMatchObject({
      consumerName: 'wager-command-consumer',
      messageId: 'application-message-1',
    });
    expect(input.inbox?.messageId).not.toBe('sqs-transport-id-1');
  });

  test('fingerprints command data including idempotency key but ignores envelope metadata', () => {
    const first = parseWagerTransactionCommandEnvelope(
      JSON.stringify(commandEnvelope()),
      receivedAt,
    );
    const replay = parseWagerTransactionCommandEnvelope(
      JSON.stringify(commandEnvelope({ correlationId: 'correlation-2' })),
      receivedAt,
    );
    const divergent = parseWagerTransactionCommandEnvelope(
      JSON.stringify({
        ...commandEnvelope(),
        data: { ...first.data, idempotencyKey: 'another-key' },
      }),
      receivedAt,
    );

    expect(hashWagerCommandData(first)).toBe(hashWagerCommandData(replay));
    expect(hashWagerCommandData(first)).not.toBe(hashWagerCommandData(divergent));
  });

  test('rejects malformed and unsupported envelopes', () => {
    expect(() => parseWagerTransactionCommandEnvelope('{')).toThrow(
      'SQS message body must be valid JSON',
    );
    expect(() =>
      parseWagerTransactionCommandEnvelope(JSON.stringify({ ...commandEnvelope(), version: 2 })),
    ).toThrow('SQS message envelope is invalid');
  });
});

class FakeQueue implements SqsQueuePort {
  readonly deleted: string[] = [];
  readonly visibilityChanges: Array<{ receiptHandle: string; timeout: number }> = [];

  receive(): Promise<readonly SqsTransportMessage[]> {
    return Promise.resolve([]);
  }

  delete(_queueName: string, receiptHandle: string): Promise<void> {
    this.deleted.push(receiptHandle);
    return Promise.resolve();
  }

  changeVisibility(
    _queueName: string,
    receiptHandle: string,
    visibilityTimeoutSeconds: number,
  ): Promise<void> {
    this.visibilityChanges.push({ receiptHandle, timeout: visibilityTimeoutSeconds });
    return Promise.resolve();
  }

  publish(): Promise<void> {
    return Promise.resolve();
  }
}

function options(overrides: Partial<SqsCommandConsumerOptions> = {}): SqsCommandConsumerOptions {
  return {
    enabled: false,
    queueName: 'wager-transactions.fifo',
    consumerName: 'wager-command-consumer',
    concurrency: 2,
    waitTimeSeconds: 0,
    visibilityTimeoutSeconds: 30,
    visibilityHeartbeatSeconds: 10,
    shutdownTimeoutMs: 100,
    ...overrides,
  };
}

function handlingResult(status: WagerTransactionStatus): SqsCommandHandlingResult {
  return {
    envelope: parseWagerTransactionCommandEnvelope(JSON.stringify(commandEnvelope()), receivedAt),
    result: {
      transactionId: 'transaction-1',
      status,
      idempotentReplay: false,
    },
  };
}

describe('SQS command consumer', () => {
  test('deletes only after the handler has completed and records business rejection', async () => {
    const queue = new FakeQueue();
    let releaseHandler: (() => void) | undefined;
    const handler: SqsCommandHandlerPort = {
      handle: () =>
        new Promise((resolve) => {
          releaseHandler = () => resolve(handlingResult(WagerTransactionStatus.Rejected));
        }),
    };
    const metrics = new SqsConsumerMetrics();
    const consumer = new SqsCommandConsumer(queue, handler, options(), metrics);
    const processing = consumer.processMessage(transportMessage(JSON.stringify(commandEnvelope())));

    await Promise.resolve();
    expect(queue.deleted).toHaveLength(0);
    releaseHandler?.();
    await processing;

    expect(queue.deleted).toEqual(['receipt-1']);
    expect(metrics.snapshot()).toMatchObject({
      messagesReceived: 1,
      messagesRejected: 1,
      messagesAcked: 1,
    });
  });

  test('does not acknowledge a permanent handler failure', async () => {
    const queue = new FakeQueue();
    const handler: SqsCommandHandlerPort = {
      handle: () => Promise.reject(new Error('invalid envelope')),
    };
    const consumer = new SqsCommandConsumer(queue, handler, options(), new SqsConsumerMetrics());

    await consumer.processMessage(transportMessage(JSON.stringify(commandEnvelope())));

    expect(queue.deleted).toHaveLength(0);
    expect(consumer.metrics.snapshot().permanentFailures).toBe(1);
  });
});
