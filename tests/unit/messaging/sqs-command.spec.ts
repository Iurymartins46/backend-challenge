import { describe, expect, test } from 'bun:test';

import {
  hashWagerCommandData,
  parseWagerTransactionRequestedEnvelope,
  toProcessWagerTransactionInput,
  WAGER_TRANSACTION_REQUESTED_TYPE,
} from '../../../src/infrastructure/messaging/sqs-command-envelope';
import {
  SqsCommandConsumer,
  sqsCommandCompletedLogContext,
  type SqsCommandConsumerOptions,
  type SqsCommandHandlerPort,
} from '../../../src/infrastructure/messaging/sqs-command.consumer';
import { SqsConsumerMetrics } from '../../../src/infrastructure/messaging/sqs-consumer.metrics';
import { SqsDlqMetricsMonitor } from '../../../src/infrastructure/messaging/sqs-dlq-metrics.monitor';
import type { SqsCommandHandlingResult } from '../../../src/infrastructure/messaging/sqs-command-handler';
import type {
  SqsQueuePort,
  SqsTransportMessage,
} from '../../../src/infrastructure/messaging/sqs-queue.port';
import {
  WagerTransactionStatus,
  DependencyUnavailableError,
} from '../../../src/modules/wagering/domain';

const receivedAt = new Date('2026-09-01T12:00:00.000Z');

function commandEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    messageId: 'application-message-1',
    type: WAGER_TRANSACTION_REQUESTED_TYPE,
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
  test('accepts the public envelope published by the challenge', () => {
    const envelope = parseWagerTransactionRequestedEnvelope(
      JSON.stringify(commandEnvelope({ messageId: 'challenge-message-1' })),
      receivedAt,
    );
    const input = toProcessWagerTransactionInput(envelope, 'wager-command-consumer');

    expect(envelope).toMatchObject({
      messageId: 'challenge-message-1',
      type: WAGER_TRANSACTION_REQUESTED_TYPE,
    });
    expect(input.inbox?.messageId).toBe('challenge-message-1');
    expect(input.correlationId).toBe('challenge-message-1');
  });

  test('keeps application message id separate from SQS transport id', () => {
    const envelope = parseWagerTransactionRequestedEnvelope(
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
    const first = parseWagerTransactionRequestedEnvelope(
      JSON.stringify(commandEnvelope()),
      receivedAt,
    );
    const replay = parseWagerTransactionRequestedEnvelope(
      JSON.stringify(commandEnvelope({ occurredAt: '2026-09-01T12:01:00.000Z' })),
      receivedAt,
    );
    const divergent = parseWagerTransactionRequestedEnvelope(
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
    expect(() => parseWagerTransactionRequestedEnvelope('{')).toThrow(
      'SQS message body must be valid JSON',
    );
    expect(() =>
      parseWagerTransactionRequestedEnvelope(
        JSON.stringify({ ...commandEnvelope(), type: 'UnsupportedCommand' }),
      ),
    ).toThrow('SQS message envelope is invalid');
    const { type: _type, ...legacyData } = commandEnvelope();
    expect(() =>
      parseWagerTransactionRequestedEnvelope(
        JSON.stringify({
          ...legacyData,
          messageType: 'WagerTransactionCommand',
          version: 1,
          correlationId: 'legacy-correlation',
        }),
      ),
    ).toThrow('SQS message envelope is invalid');
  });

  test('rejects non-canonical date formats accepted by Date.parse', () => {
    for (const occurredAt of [
      '2026',
      '01/02/2026',
      '2026-09-01T12:00:00Z',
      '2026-02-30T00:00:00.000Z',
    ]) {
      expect(() =>
        parseWagerTransactionRequestedEnvelope(JSON.stringify(commandEnvelope({ occurredAt }))),
      ).toThrow('SQS message envelope is invalid');
    }
  });
});

class FakeQueue implements SqsQueuePort {
  readonly deleted: string[] = [];
  readonly visibilityChanges: Array<{ receiptHandle: string; timeout: number }> = [];
  approximateMessageCount = { visible: 0, inFlight: 0, delayed: 0, total: 0 };
  approximateMessageCountError: Error | undefined;

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

  getApproximateMessageCount(): Promise<{
    visible: number;
    inFlight: number;
    delayed: number;
    total: number;
  }> {
    if (this.approximateMessageCountError !== undefined) {
      return Promise.reject(this.approximateMessageCountError);
    }
    return Promise.resolve(this.approximateMessageCount);
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
    envelope: parseWagerTransactionRequestedEnvelope(JSON.stringify(commandEnvelope()), receivedAt),
    result: {
      transactionId: 'transaction-1',
      status,
      idempotentReplay: false,
    },
  };
}

describe('SQS command consumer', () => {
  test('reports actual DLQ depth separately from permanent failure classifications', async () => {
    const queue = new FakeQueue();
    queue.approximateMessageCount = { visible: 2, inFlight: 1, delayed: 1, total: 4 };
    const metrics = new SqsConsumerMetrics();
    metrics.increment('permanentFailures');
    const monitor = new SqsDlqMetricsMonitor(queue, metrics, {
      enabled: false,
      queueName: 'wager-transactions-dlq.fifo',
      refreshIntervalMs: 5_000,
    });

    await monitor.refresh();

    expect(metrics.snapshot()).toMatchObject({ permanentFailures: 1, dlqMessages: 4 });

    queue.approximateMessageCountError = new Error('SQS unavailable');
    await monitor.refresh();
    expect(metrics.snapshot()).toMatchObject({
      permanentFailures: 1,
      dlqMessages: 4,
      dlqMetricRefreshFailures: 1,
    });
  });

  test('builds a structured operational log without financial payload or credentials', () => {
    const context = sqsCommandCompletedLogContext(handlingResult(WagerTransactionStatus.Processed));
    const serialized = JSON.stringify(context);

    expect(context).toEqual({
      correlationId: 'application-message-1',
      messageId: 'application-message-1',
      transactionId: 'transaction-1',
      walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
      providerId: 'provider-a',
      status: WagerTransactionStatus.Processed,
      idempotentReplay: false,
    });
    expect(serialized).not.toContain('amount');
    expect(serialized).not.toContain('money');
    expect(serialized).not.toContain('payload');
    expect(serialized).not.toContain('token');
  });

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

  test('acknowledges a pending-reference replay only after the handler commits', async () => {
    const queue = new FakeQueue();
    const handler: SqsCommandHandlerPort = {
      handle: () =>
        Promise.resolve({
          envelope: parseWagerTransactionRequestedEnvelope(
            JSON.stringify(commandEnvelope()),
            receivedAt,
          ),
          result: {
            transactionId: 'pending-transaction-1',
            status: WagerTransactionStatus.PendingReference,
            idempotentReplay: true,
          },
        }),
    };
    const consumer = new SqsCommandConsumer(queue, handler, options(), new SqsConsumerMetrics());

    await consumer.processMessage(transportMessage(JSON.stringify(commandEnvelope())));

    expect(queue.deleted).toEqual(['receipt-1']);
    expect(consumer.metrics.snapshot()).toMatchObject({
      messagesReceived: 1,
      messagesPendingReference: 1,
      duplicateMessages: 1,
      messagesAcked: 1,
    });
  });

  test('keeps a transient dependency failure available for redelivery', async () => {
    const queue = new FakeQueue();
    const handler: SqsCommandHandlerPort = {
      handle: () => Promise.reject(new DependencyUnavailableError()),
    };
    const consumer = new SqsCommandConsumer(queue, handler, options(), new SqsConsumerMetrics());

    await consumer.processMessage(transportMessage(JSON.stringify(commandEnvelope())));

    expect(queue.deleted).toHaveLength(0);
    expect(consumer.metrics.snapshot()).toMatchObject({
      messagesReceived: 1,
      transientFailures: 1,
      permanentFailures: 0,
      messagesAcked: 0,
    });
  });
});
