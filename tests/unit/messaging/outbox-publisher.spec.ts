import { describe, expect, test } from 'bun:test';

import type {
  FinancialUnitOfWorkPort,
  OutboxClaimInput,
  OutboxLeaseMutationInput,
  OutboxMessageRepositoryPort,
  OutboxPendingMetrics,
  OutboxRetryMutationInput,
} from '../../../src/modules/wagering/application/ports';
import {
  ExponentialRetryPolicy,
  OutboxMessage,
  type Clock,
  type IdGenerator,
} from '../../../src/modules/wagering/domain';
import {
  OutboxPublisher,
  type OutboxPublisherOptions,
} from '../../../src/infrastructure/messaging/outbox.publisher';
import { OutboxPublisherMetrics } from '../../../src/infrastructure/messaging/outbox-publisher.metrics';
import type {
  SqsPublishOptions,
  SqsQueuePort,
  SqsReceiveOptions,
  SqsTransportMessage,
} from '../../../src/infrastructure/messaging/sqs-queue.port';

const initialTime = new Date('2026-09-01T12:00:00.000Z');

class MutableClock implements Clock {
  constructor(private current: Date = initialTime) {}

  now(): Date {
    return new Date(this.current.getTime());
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

class FixedIdGenerator implements IdGenerator {
  constructor(private readonly id: string) {}

  next(): string {
    return this.id;
  }
}

class FakeQueue implements SqsQueuePort {
  readonly published: Array<{ queueName: string; options: SqsPublishOptions }> = [];
  failuresRemaining = 0;

  receive(
    _queueName: string,
    _options: SqsReceiveOptions,
  ): Promise<readonly SqsTransportMessage[]> {
    return Promise.resolve([]);
  }

  delete(_queueName: string, _receiptHandle: string): Promise<void> {
    return Promise.resolve();
  }

  changeVisibility(
    _queueName: string,
    _receiptHandle: string,
    _visibilityTimeoutSeconds: number,
  ): Promise<void> {
    return Promise.resolve();
  }

  publish(queueName: string, options: SqsPublishOptions): Promise<void> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      return Promise.reject(new Error('SQS unavailable'));
    }

    this.published.push({ queueName, options });
    return Promise.resolve();
  }

  getApproximateMessageCount(): Promise<{
    visible: number;
    inFlight: number;
    delayed: number;
    total: number;
  }> {
    return Promise.resolve({ visible: 0, inFlight: 0, delayed: 0, total: 0 });
  }
}

class FakeOutboxRepository implements OutboxMessageRepositoryPort {
  private messages: OutboxMessage[];

  constructor(messages: readonly OutboxMessage[]) {
    this.messages = [...messages];
  }

  findById(id: string): Promise<OutboxMessage | null> {
    return Promise.resolve(this.messages.find((message) => message.id === id) ?? null);
  }

  insert(message: OutboxMessage): Promise<OutboxMessage> {
    this.messages.push(message);
    return Promise.resolve(message);
  }

  save(message: OutboxMessage): Promise<OutboxMessage> {
    this.replace(message);
    return Promise.resolve(message);
  }

  claimDue(input: OutboxClaimInput): Promise<readonly OutboxMessage[]> {
    const claimed: OutboxMessage[] = [];
    for (const message of this.messages) {
      if (claimed.length >= input.limit || !message.isPending() || !message.isDue(input.now)) {
        continue;
      }

      const lockedUntil = message.lockedUntil;
      if (lockedUntil !== undefined && lockedUntil.getTime() > input.now.getTime()) {
        continue;
      }

      const locked = rehydrate(message, {
        lockedBy: input.owner,
        lockedUntil: input.leaseUntil,
      });
      this.replace(locked);
      claimed.push(rehydrate(locked, {}));
    }

    return Promise.resolve(claimed);
  }

  markPublishedIfOwned(input: OutboxLeaseMutationInput): Promise<boolean> {
    const message = this.messages.find((candidate) => candidate.id === input.id);
    if (
      message === undefined ||
      message.lockedBy === undefined ||
      message.lockedBy !== input.owner ||
      message.lockedUntil === undefined ||
      message.lockedUntil.getTime() <= input.now.getTime()
    ) {
      return Promise.resolve(false);
    }

    message.markPublished(input.now);
    return Promise.resolve(true);
  }

  saveRetryIfOwned(input: OutboxRetryMutationInput): Promise<boolean> {
    const current = this.messages.find((candidate) => candidate.id === input.message.id);
    if (
      current === undefined ||
      current.lockedBy !== input.owner ||
      current.lockedUntil === undefined ||
      current.lockedUntil.getTime() <= input.now.getTime()
    ) {
      return Promise.resolve(false);
    }

    this.replace(input.message);
    return Promise.resolve(true);
  }

  measurePending(now: Date): Promise<OutboxPendingMetrics> {
    const pending = this.messages.filter((message) => message.isPending());
    const oldest = pending.reduce(
      (value, message) => Math.min(value, message.occurredAt.getTime()),
      now.getTime(),
    );
    return Promise.resolve({
      pendingCount: pending.length,
      lagMs: Math.max(0, now.getTime() - oldest),
    });
  }

  get(id: string): OutboxMessage | undefined {
    return this.messages.find((message) => message.id === id);
  }

  private replace(message: OutboxMessage): void {
    const index = this.messages.findIndex((candidate) => candidate.id === message.id);
    if (index === -1) {
      this.messages.push(message);
      return;
    }

    this.messages[index] = message;
  }
}

function rehydrate(
  message: OutboxMessage,
  overrides: Partial<{
    attempts: number;
    nextAttemptAt: Date;
    publishedAt: Date;
    lockedBy: string;
    lockedUntil: Date;
  }>,
): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: message.id,
    aggregateId: message.aggregateId,
    eventType: message.eventType,
    payload: message.payload,
    occurredAt: message.occurredAt,
    attempts: overrides.attempts ?? message.attempts,
    nextAttemptAt: overrides.nextAttemptAt ?? message.nextAttemptAt,
    publishedAt: overrides.publishedAt ?? message.publishedAt,
    lockedBy: overrides.lockedBy ?? message.lockedBy,
    lockedUntil: overrides.lockedUntil ?? message.lockedUntil,
  });
}

function unitOfWork(outbox: OutboxMessageRepositoryPort): FinancialUnitOfWorkPort {
  const value = {
    outbox,
    transaction: <T>(callback: (transactional: FinancialUnitOfWorkPort) => Promise<T>) =>
      callback(value as unknown as FinancialUnitOfWorkPort),
  };
  return value as unknown as FinancialUnitOfWorkPort;
}

function message(id: string, eventType: string, version: number): OutboxMessage {
  return OutboxMessage.rehydrate({
    id,
    aggregateId: 'wallet-1',
    eventType,
    payload: {
      eventId: id,
      eventType,
      version,
      aggregateId: 'wallet-1',
      data: { transactionId: `transaction-${id}` },
    },
    occurredAt: initialTime,
    attempts: 0,
  });
}

function options(policy: ExponentialRetryPolicy): OutboxPublisherOptions {
  return {
    enabled: false,
    eventsQueueName: 'wager-events.fifo',
    batchSize: 10,
    pollIntervalMs: 1000,
    leaseDurationMs: 1000,
    shutdownTimeoutMs: 1000,
    retryPolicy: policy,
  };
}

function publisher(
  queue: SqsQueuePort,
  repository: OutboxMessageRepositoryPort,
  clock: MutableClock,
  id: string,
  publisherOptions: OutboxPublisherOptions,
  metrics = new OutboxPublisherMetrics(),
  failpoint?: (outboxMessage: OutboxMessage) => Promise<void>,
): OutboxPublisher {
  return new OutboxPublisher(
    queue,
    unitOfWork(repository),
    clock,
    new FixedIdGenerator(id),
    publisherOptions,
    metrics,
    failpoint,
  );
}

describe('outbox publisher', () => {
  test('claims before publishing, uses the events FIFO metadata and marks the lease owner', async () => {
    const queue = new FakeQueue();
    const repository = new FakeOutboxRepository([
      message('event-processed', 'WagerTransactionProcessed', 1),
      message('event-rejected', 'WagerTransactionRejected', 1),
      message('event-balance', 'WalletBalanceChanged', 1),
      message('event-pending', 'WagerTransactionPendingReference', 1),
    ]);
    const clock = new MutableClock();
    const publisherOptions = options(
      new ExponentialRetryPolicy({ baseDelayMs: 100, maxDelayMs: 200, maxAttempts: 2 }),
    );
    const result = await publisher(
      queue,
      repository,
      clock,
      'publisher-1',
      publisherOptions,
    ).publishOnce();

    expect(result).toEqual({ claimed: 4, published: 4, retried: 0, leaseLost: 0 });
    expect(queue.published).toHaveLength(4);
    expect(queue.published.every(({ queueName }) => queueName === 'wager-events.fifo')).toBe(true);
    expect(queue.published.map(({ options: publish }) => publish.messageDeduplicationId)).toEqual([
      'event-processed',
      'event-rejected',
      'event-balance',
      'event-pending',
    ]);
    expect(
      queue.published.every(({ options: publish }) => publish.messageGroupId === 'wallet-1'),
    ).toBe(true);
    expect(
      queue.published.map(({ options: publish }) => {
        const body = JSON.parse(publish.messageBody) as { version: number };
        return body.version;
      }),
    ).toEqual([1, 1, 1, 1]);
    expect(repository.get('event-processed')?.isPending()).toBe(false);
  });

  test('schedules a jittered retry on SQS failure and publishes after the dependency returns', async () => {
    const queue = new FakeQueue();
    queue.failuresRemaining = 1;
    const repository = new FakeOutboxRepository([
      message('event-retry', 'WalletBalanceChanged', 1),
    ]);
    const clock = new MutableClock();
    const metrics = new OutboxPublisherMetrics();
    const retryPolicy = new ExponentialRetryPolicy({
      baseDelayMs: 100,
      maxDelayMs: 200,
      maxAttempts: 2,
      jitterRatio: 0.5,
      random: () => 1,
    });
    const outboxPublisher = publisher(
      queue,
      repository,
      clock,
      'publisher-retry',
      options(retryPolicy),
      metrics,
    );

    const firstResult = await outboxPublisher.publishOnce();
    expect(firstResult).toMatchObject({
      claimed: 1,
      published: 0,
      retried: 1,
    });
    expect(repository.get('event-retry')?.attempts).toBe(1);
    expect(repository.get('event-retry')?.nextAttemptAt?.getTime()).toBe(
      initialTime.getTime() + 150,
    );
    expect(repository.get('event-retry')?.isPending()).toBe(true);

    clock.advance(150);
    const secondResult = await outboxPublisher.publishOnce();
    expect(secondResult).toMatchObject({
      claimed: 1,
      published: 1,
    });
    expect(repository.get('event-retry')?.isPending()).toBe(false);
    expect(metrics.snapshot()).toMatchObject({
      publishFailures: 1,
      retryScheduled: 1,
      messagesPublished: 1,
      pendingMessages: 0,
    });
  });

  test('lease recovery allows a duplicate after publish-before-mark while preserving eventId', async () => {
    const queue = new FakeQueue();
    const repository = new FakeOutboxRepository([
      message('event-crash', 'WagerTransactionProcessed', 1),
    ]);
    const clock = new MutableClock();
    let failOnce = true;
    const crashPublisher = publisher(
      queue,
      repository,
      clock,
      'publisher-crashed',
      options(new ExponentialRetryPolicy({ baseDelayMs: 100, maxDelayMs: 100, maxAttempts: 2 })),
      new OutboxPublisherMetrics(),
      () => {
        if (failOnce) {
          failOnce = false;
          throw new Error('simulated process crash after publish');
        }
        return Promise.resolve();
      },
    );

    await crashPublisher.publishOnce();
    expect(queue.published).toHaveLength(1);
    expect(repository.get('event-crash')?.isPending()).toBe(true);

    clock.advance(1001);
    const recoveryPublisher = publisher(
      queue,
      repository,
      clock,
      'publisher-recovery',
      options(new ExponentialRetryPolicy({ baseDelayMs: 100, maxDelayMs: 100, maxAttempts: 2 })),
    );
    await recoveryPublisher.publishOnce();

    expect(queue.published).toHaveLength(2);
    expect(queue.published[0]?.options.messageDeduplicationId).toBe('event-crash');
    expect(queue.published[1]?.options.messageDeduplicationId).toBe('event-crash');
    expect(repository.get('event-crash')?.isPending()).toBe(false);
  });

  test('saturates the operational retry limit without discarding the event', async () => {
    const queue = new FakeQueue();
    queue.failuresRemaining = 2;
    const repository = new FakeOutboxRepository([
      message('event-limit', 'WalletBalanceChanged', 1),
    ]);
    const clock = new MutableClock();
    const metrics = new OutboxPublisherMetrics();
    const outboxPublisher = publisher(
      queue,
      repository,
      clock,
      'publisher-limit',
      options(
        new ExponentialRetryPolicy({
          baseDelayMs: 100,
          maxDelayMs: 100,
          maxAttempts: 1,
        }),
      ),
      metrics,
    );

    await outboxPublisher.publishOnce();
    clock.advance(100);
    const cappedResult = await outboxPublisher.publishOnce();

    expect(cappedResult.retried).toBe(1);
    expect(repository.get('event-limit')?.attempts).toBe(1);
    expect(repository.get('event-limit')?.isPending()).toBe(true);
    expect(metrics.snapshot()).toMatchObject({ retryLimitReached: 1 });

    clock.advance(100);
    const recoveredResult = await outboxPublisher.publishOnce();
    expect(recoveredResult.published).toBe(1);
    expect(repository.get('event-limit')?.isPending()).toBe(false);
  });

  test('two publishers claim disjoint batches', async () => {
    const queue = new FakeQueue();
    const repository = new FakeOutboxRepository([
      message('event-a', 'WagerTransactionProcessed', 1),
      message('event-b', 'WagerTransactionProcessed', 1),
    ]);
    const clock = new MutableClock();
    const publisherOptions = options(
      new ExponentialRetryPolicy({ baseDelayMs: 100, maxDelayMs: 200, maxAttempts: 2 }),
    );
    const first = publisher(queue, repository, clock, 'publisher-a', {
      ...publisherOptions,
      batchSize: 1,
    });
    const second = publisher(queue, repository, clock, 'publisher-b', {
      ...publisherOptions,
      batchSize: 1,
    });

    await Promise.all([first.publishOnce(), second.publishOnce()]);

    expect(
      queue.published.map(({ options: publish }) => publish.messageDeduplicationId).sort(),
    ).toEqual(['event-a', 'event-b']);
    expect(repository.get('event-a')?.isPending()).toBe(false);
    expect(repository.get('event-b')?.isPending()).toBe(false);
  });
});
