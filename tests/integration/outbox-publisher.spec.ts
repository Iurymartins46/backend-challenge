import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';

import { CreateWalletUseCase } from '../../src/modules/wallet/application';
import { FinancialUnitOfWork } from '../../src/infrastructure/database/financial-unit-of-work';
import { AwsSqsQueueAdapter } from '../../src/infrastructure/messaging/aws-sqs-queue.adapter';
import {
  OutboxPublisher,
  type OutboxPublisherFailpoint,
  type OutboxPublisherOptions,
} from '../../src/infrastructure/messaging/outbox.publisher';
import type {
  SqsPublishOptions,
  SqsQueuePort,
  SqsReceiveOptions,
  SqsTransportMessage,
} from '../../src/infrastructure/messaging/sqs-queue.port';
import dataSource from '../../src/infrastructure/database/data-source';
import {
  ExponentialRetryPolicy,
  RandomIdGenerator,
  SystemClock,
  type Clock,
} from '../../src/modules/wagering/domain';
import { validateEnvironment } from '../../src/config/environment';
import { SQSClient } from '@aws-sdk/client-sqs';

const runRealIntegration = process.env.RUN_REAL_INTEGRATION_TESTS === 'true';
const integration = runRealIntegration ? describe : describe.skip;
const env = validateEnvironment(process.env);

class MutableClock implements Clock {
  private current: Date;

  constructor(current = new Date('1970-01-01T00:00:00.000Z')) {
    this.current = current;
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

class RecordingQueue implements SqsQueuePort {
  readonly published: Array<{ queueName: string; options: SqsPublishOptions }> = [];

  constructor(
    private readonly delegate: AwsSqsQueueAdapter,
    private failuresRemaining = 0,
  ) {}

  receive(queueName: string, options: SqsReceiveOptions): Promise<readonly SqsTransportMessage[]> {
    return this.delegate.receive(queueName, options);
  }

  delete(queueName: string, receiptHandle: string): Promise<void> {
    return this.delegate.delete(queueName, receiptHandle);
  }

  changeVisibility(
    queueName: string,
    receiptHandle: string,
    visibilityTimeoutSeconds: number,
  ): Promise<void> {
    return this.delegate.changeVisibility(queueName, receiptHandle, visibilityTimeoutSeconds);
  }

  publish(queueName: string, options: SqsPublishOptions): Promise<void> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      return Promise.reject(new Error('simulated SQS outage'));
    }

    this.published.push({ queueName, options });
    return this.delegate.publish(queueName, options);
  }

  getApproximateMessageCount(
    queueName: string,
  ): ReturnType<AwsSqsQueueAdapter['getApproximateMessageCount']> {
    return this.delegate.getApproximateMessageCount(queueName);
  }
}

function publisherOptions(overrides: Partial<OutboxPublisherOptions> = {}): OutboxPublisherOptions {
  return {
    enabled: false,
    eventsQueueName: env.SQS_EVENTS_QUEUE_NAME,
    batchSize: 10,
    pollIntervalMs: 1000,
    leaseDurationMs: 1000,
    shutdownTimeoutMs: 1000,
    retryPolicy: new ExponentialRetryPolicy({
      baseDelayMs: 100,
      maxDelayMs: 200,
      maxAttempts: 2,
      jitterRatio: 0,
    }),
    ...overrides,
  };
}

function createPublisher(
  queue: SqsQueuePort,
  clock: MutableClock,
  id: string,
  options: OutboxPublisherOptions,
  afterPublishBeforeMark?: OutboxPublisherFailpoint,
): OutboxPublisher {
  return new OutboxPublisher(
    queue,
    FinancialUnitOfWork.fromEntityManager(dataSource.manager),
    clock,
    new RandomIdGeneratorWithId(id),
    options,
    undefined,
    afterPublishBeforeMark,
  );
}

class RandomIdGeneratorWithId extends RandomIdGenerator {
  constructor(private readonly fixedId: string) {
    super();
  }

  override next(): string {
    return this.fixedId;
  }
}

integration('outbox publisher with PostgreSQL and LocalStack', () => {
  let sqsClient: SQSClient;
  let queue: AwsSqsQueueAdapter;

  beforeAll(async () => {
    await dataSource.initialize();
    await dataSource.runMigrations();
    sqsClient = new SQSClient({
      region: env.AWS_REGION,
      endpoint: env.SQS_ENDPOINT,
      credentials: {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      },
    });
    queue = new AwsSqsQueueAdapter(sqsClient);
  });

  afterAll(async () => {
    sqsClient?.destroy();
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  });

  test('two publishers claim distinct committed events and publish them once', async () => {
    const unitOfWork = FinancialUnitOfWork.fromEntityManager(dataSource.manager);
    const createWallet = new CreateWalletUseCase(
      unitOfWork,
      new RandomIdGenerator(),
      new SystemClock(),
    );
    const firstWallet = await createWallet.execute({
      playerId: randomUUID(),
      initialBalance: { amount: '1.00', currency: 'BRL' },
    });
    const secondWallet = await createWallet.execute({
      playerId: randomUUID(),
      initialBalance: { amount: '1.00', currency: 'BRL' },
    });
    await prioritizeOutbox([firstWallet.id, secondWallet.id]);
    const rows = await dataSource.manager.query<
      Array<{ id: string; aggregateId: string; eventType: string }>
    >(
      `SELECT id, aggregate_id AS "aggregateId", event_type AS "eventType"
       FROM outbox_messages
       WHERE aggregate_id IN ($1, $2) AND published_at IS NULL
       ORDER BY id`,
      [firstWallet.id, secondWallet.id],
    );
    expect(rows).toHaveLength(2);

    const recordingQueue = new RecordingQueue(queue);
    const clock = new MutableClock(new Date('1970-01-01T00:00:00.000Z'));
    const options = publisherOptions({ batchSize: 1 });
    const first = createPublisher(recordingQueue, clock, 'integration-publisher-1', options);
    const second = createPublisher(recordingQueue, clock, 'integration-publisher-2', options);

    const results = await Promise.all([first.publishOnce(), second.publishOnce()]);
    const published = await dataSource.manager.query<Array<{ id: string; publishedAt: Date }>>(
      `SELECT id, published_at AS "publishedAt"
       FROM outbox_messages WHERE id IN ($1, $2) AND published_at IS NOT NULL`,
      [rows[0]?.id, rows[1]?.id],
    );

    expect(results.reduce((total, result) => total + result.published, 0)).toBe(2);
    expect(published).toHaveLength(2);
    expect(recordingQueue.published).toHaveLength(2);
    expect(
      recordingQueue.published.map(({ options: value }) => value.messageGroupId).sort(),
    ).toEqual([firstWallet.id, secondWallet.id].sort());
    expect(
      recordingQueue.published.map(({ options: value }) => value.messageDeduplicationId).sort(),
    ).toEqual(rows.map((row) => row.id).sort());
    expect(
      recordingQueue.published.every(({ queueName }) => queueName === env.SQS_EVENTS_QUEUE_NAME),
    ).toBe(true);

    await drainEvents(recordingQueue, new Set(rows.map((row) => row.id)));
  });

  test('does not publish an outbox row before its financial transaction commits', async () => {
    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    const eventId = randomUUID();
    const walletId = randomUUID();
    const occurredAt = new Date('1970-01-01T00:00:00.000Z');
    const recordingQueue = new RecordingQueue(queue);
    const publisher = createPublisher(
      recordingQueue,
      new MutableClock(),
      'commit-gate-publisher',
      publisherOptions(),
    );

    try {
      await queryRunner.manager.query(
        'SELECT id FROM outbox_messages WHERE published_at IS NULL FOR UPDATE',
      );
      await queryRunner.manager.query(
        `INSERT INTO outbox_messages
          (id, aggregate_id, event_type, envelope, occurred_at, attempts)
         VALUES ($1, $2, $3, $4::jsonb, $5, 0)`,
        [
          eventId,
          walletId,
          'WagerTransactionProcessed',
          JSON.stringify({ eventId, eventType: 'WagerTransactionProcessed', version: 1 }),
          occurredAt,
        ],
      );

      const result = await publisher.publishOnce();
      expect(result.claimed).toBe(0);
      expect(recordingQueue.published).toHaveLength(0);
    } finally {
      await queryRunner.rollbackTransaction();
      await queryRunner.release();
    }
  });

  test('recovers a committed claim when the publisher crashes before SQS publish', async () => {
    const wallet = await new CreateWalletUseCase(
      FinancialUnitOfWork.fromEntityManager(dataSource.manager),
      new RandomIdGenerator(),
      new SystemClock(),
    ).execute({
      playerId: randomUUID(),
      initialBalance: { amount: '10.00', currency: 'BRL' },
    });
    await prioritizeOutbox([wallet.id]);
    const eventRows = await dataSource.manager.query<Array<{ id: string }>>(
      `SELECT id FROM outbox_messages WHERE aggregate_id = $1 AND published_at IS NULL`,
      [wallet.id],
    );
    const eventId = eventRows[0]?.id;
    if (eventId === undefined) {
      throw new Error('The wallet did not create an outbox event.');
    }

    const recordingQueue = new RecordingQueue(queue);
    const clock = new MutableClock();
    const options = publisherOptions({
      batchSize: 1,
      leaseDurationMs: 1000,
      beforePublish: () => Promise.reject(new Error('simulated crash after claim commit')),
    });
    const crashed = createPublisher(recordingQueue, clock, 'claim-crashed-publisher', options);

    const crashResult = await crashed.publishOnce().catch((error: unknown) => error);
    expect(crashResult).toBeInstanceOf(Error);
    expect((crashResult as Error).message).toBe('simulated crash after claim commit');
    const claimedRows = await dataSource.manager.query<
      Array<{ publishedAt: Date | null; lockedUntil: Date | null }>
    >(
      `SELECT published_at AS "publishedAt", locked_until AS "lockedUntil"
       FROM outbox_messages WHERE id = $1`,
      [eventId],
    );
    expect(claimedRows[0]?.publishedAt).toBeNull();
    expect(claimedRows[0]?.lockedUntil).toBeInstanceOf(Date);
    expect(recordingQueue.published).toHaveLength(0);

    clock.advance(1001);
    const recovery = createPublisher(
      recordingQueue,
      clock,
      'claim-recovery-publisher',
      publisherOptions({ batchSize: 1 }),
    );
    await recovery.publishOnce();

    const publishedRows = await dataSource.manager.query<Array<{ publishedAt: Date | null }>>(
      `SELECT published_at AS "publishedAt" FROM outbox_messages WHERE id = $1`,
      [eventId],
    );
    expect(publishedRows[0]?.publishedAt).not.toBeNull();
    expect(recordingQueue.published).toHaveLength(1);
    expect(recordingQueue.published[0]?.options.messageDeduplicationId).toBe(eventId);
    await drainEvents(recordingQueue, new Set([eventId]));
  });

  test('keeps financial state unchanged on SQS failure and retries after recovery', async () => {
    const unitOfWork = FinancialUnitOfWork.fromEntityManager(dataSource.manager);
    const wallet = await new CreateWalletUseCase(
      unitOfWork,
      new RandomIdGenerator(),
      new SystemClock(),
    ).execute({
      playerId: randomUUID(),
      initialBalance: { amount: '10.00', currency: 'BRL' },
    });
    const before = await unitOfWork.wallets.findById(wallet.id);
    await prioritizeOutbox([wallet.id]);
    const eventRows = await dataSource.manager.query<Array<{ id: string }>>(
      `SELECT id FROM outbox_messages WHERE aggregate_id = $1 AND published_at IS NULL`,
      [wallet.id],
    );
    const recordingQueue = new RecordingQueue(queue, 1);
    const clock = new MutableClock(new Date('1970-01-01T00:00:00.000Z'));
    const outboxPublisher = createPublisher(
      recordingQueue,
      clock,
      'retry-publisher',
      publisherOptions({ batchSize: 1 }),
    );

    const firstResult = await outboxPublisher.publishOnce();
    const afterFailure = await unitOfWork.wallets.findById(wallet.id);
    const failedRows = await dataSource.manager.query<
      Array<{ attempts: number; publishedAt: Date | null }>
    >(
      `SELECT attempts, published_at AS "publishedAt"
       FROM outbox_messages WHERE id = $1`,
      [eventRows[0]?.id],
    );

    expect(firstResult.retried).toBe(1);
    expect(afterFailure?.balance.toJSON()).toEqual(before?.balance.toJSON());
    expect(afterFailure?.version).toBe(before?.version);
    expect(failedRows).toEqual([{ attempts: 1, publishedAt: null }]);

    clock.advance(100);
    const secondResult = await outboxPublisher.publishOnce();
    const recoveredRows = await dataSource.manager.query<Array<{ publishedAt: Date | null }>>(
      `SELECT published_at AS "publishedAt" FROM outbox_messages WHERE id = $1`,
      [eventRows[0]?.id],
    );
    expect(secondResult.published).toBe(1);
    expect(recoveredRows[0]?.publishedAt).not.toBeNull();
    await drainEvents(recordingQueue, new Set(eventRows.map((row) => row.id)));
  });

  test('recovers a lease after publish-before-mark with the same eventId', async () => {
    const wallet = await new CreateWalletUseCase(
      FinancialUnitOfWork.fromEntityManager(dataSource.manager),
      new RandomIdGenerator(),
      new SystemClock(),
    ).execute({
      playerId: randomUUID(),
      initialBalance: { amount: '10.00', currency: 'BRL' },
    });
    await prioritizeOutbox([wallet.id]);
    const eventRows = await dataSource.manager.query<Array<{ id: string }>>(
      `SELECT id FROM outbox_messages WHERE aggregate_id = $1 AND published_at IS NULL`,
      [wallet.id],
    );
    const eventId = eventRows[0]?.id;
    if (eventId === undefined) {
      throw new Error('The wallet did not create an outbox event.');
    }

    const recordingQueue = new RecordingQueue(queue);
    const clock = new MutableClock(new Date('1970-01-01T00:00:00.000Z'));
    const options = publisherOptions({ batchSize: 1, leaseDurationMs: 1000 });
    let failOnce = true;
    const crashed = createPublisher(recordingQueue, clock, 'crashed-publisher', options, () => {
      if (failOnce) {
        failOnce = false;
        throw new Error('simulated crash after publish');
      }
      return Promise.resolve();
    });

    await crashed.publishOnce();
    const leasedRows = await dataSource.manager.query<
      Array<{ publishedAt: Date | null; lockedUntil: Date | null }>
    >(
      `SELECT published_at AS "publishedAt", locked_until AS "lockedUntil"
       FROM outbox_messages WHERE id = $1`,
      [eventId],
    );
    expect(leasedRows[0]?.publishedAt).toBeNull();
    expect(leasedRows[0]?.lockedUntil).toBeInstanceOf(Date);

    clock.advance(1001);
    const recovery = createPublisher(recordingQueue, clock, 'recovery-publisher', options);
    await recovery.publishOnce();
    const publishedRows = await dataSource.manager.query<Array<{ publishedAt: Date | null }>>(
      `SELECT published_at AS "publishedAt" FROM outbox_messages WHERE id = $1`,
      [eventId],
    );

    expect(publishedRows[0]?.publishedAt).not.toBeNull();
    const sends = recordingQueue.published.filter(
      ({ options: value }) => value.messageDeduplicationId === eventId,
    );
    expect(sends).toHaveLength(2);
    expect(new Set(sends.map(({ options: value }) => value.messageDeduplicationId))).toEqual(
      new Set([eventId]),
    );
    await drainEvents(recordingQueue, new Set([eventId]));
  });
});

async function drainEvents(queue: SqsQueuePort, expectedIds: ReadonlySet<string>): Promise<void> {
  const received = new Set<string>();
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && received.size < expectedIds.size) {
    const messages = await queue.receive(env.SQS_EVENTS_QUEUE_NAME, {
      maxNumberOfMessages: 10,
      waitTimeSeconds: 0,
      visibilityTimeoutSeconds: 5,
    });
    for (const message of messages) {
      const body = JSON.parse(message.body) as { eventId?: string };
      if (body.eventId !== undefined && expectedIds.has(body.eventId)) {
        received.add(body.eventId);
      }
      await queue.delete(env.SQS_EVENTS_QUEUE_NAME, message.receiptHandle);
    }
    if (received.size < expectedIds.size) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  expect(received).toEqual(new Set(expectedIds));
}

async function prioritizeOutbox(aggregateIds: readonly string[]): Promise<void> {
  await dataSource.manager.query(
    `UPDATE outbox_messages
     SET occurred_at = TIMESTAMPTZ '1970-01-01 00:00:00+00'
     WHERE aggregate_id = ANY($1::uuid[])`,
    [aggregateIds],
  );
}

if (!runRealIntegration) {
  test('real outbox publisher integration is opt-in', () => {
    expect(true).toBe(true);
  });
}
