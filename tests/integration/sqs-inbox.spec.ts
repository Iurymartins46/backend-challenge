import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';

import { configuration } from '../../src/config/configuration';
import { validateEnvironment } from '../../src/config/environment';
import dataSource from '../../src/infrastructure/database/data-source';
import { FinancialUnitOfWork } from '../../src/infrastructure/database/financial-unit-of-work';
import { AwsSqsQueueAdapter } from '../../src/infrastructure/messaging/aws-sqs-queue.adapter';
import { SqsCommandConsumer } from '../../src/infrastructure/messaging/sqs-command.consumer';
import { SqsWagerCommandHandler } from '../../src/infrastructure/messaging/sqs-command-handler';
import { WAGER_TRANSACTION_REQUESTED_TYPE } from '../../src/infrastructure/messaging/sqs-command-envelope';
import { SqsConsumerMetrics } from '../../src/infrastructure/messaging/sqs-consumer.metrics';
import { SqsDlqMetricsMonitor } from '../../src/infrastructure/messaging/sqs-dlq-metrics.monitor';
import { CreateWalletUseCase } from '../../src/modules/wallet/application';
import { ProcessWagerTransactionUseCase } from '../../src/modules/wagering/application';
import {
  RandomIdGenerator,
  SystemClock,
  WagerTransactionKind,
} from '../../src/modules/wagering/domain';

const runRealIntegration = process.env.RUN_REAL_INTEGRATION_TESTS === 'true';
const integration = runRealIntegration ? describe : describe.skip;
const env = validateEnvironment(process.env);
const appConfig = configuration();

let sqsClient: SQSClient | undefined;
let queue: AwsSqsQueueAdapter | undefined;
const queueToken = `${process.pid}-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
const commandQueueName = `integration-inbox-${queueToken}.fifo`;
const commandDlqName = `integration-inbox-dlq-${queueToken}.fifo`;
let commandQueueUrl: string | undefined;
let commandDlqUrl: string | undefined;

integration('SQS consumer and inbox', () => {
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
    commandDlqUrl = await createQueue(sqsClient, commandDlqName);
    const dlqAttributes = await sqsClient.send(
      new GetQueueAttributesCommand({
        QueueUrl: commandDlqUrl,
        AttributeNames: ['QueueArn'],
      }),
    );
    const deadLetterTargetArn = dlqAttributes.Attributes?.QueueArn;
    if (deadLetterTargetArn === undefined) {
      throw new Error('LocalStack did not return the integration DLQ ARN.');
    }
    commandQueueUrl = await createQueue(sqsClient, commandQueueName, {
      RedrivePolicy: JSON.stringify({ deadLetterTargetArn, maxReceiveCount: '5' }),
    });
    queue = new AwsSqsQueueAdapter(sqsClient);
  });

  afterAll(async () => {
    if (sqsClient !== undefined) {
      await deleteQueue(sqsClient, commandQueueUrl);
      await deleteQueue(sqsClient, commandDlqUrl);
    }
    sqsClient?.destroy();
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  });

  test('processes a command and safely replays the same application message id', async () => {
    if (queue === undefined || sqsClient === undefined) {
      throw new Error('The SQS integration was not initialized.');
    }
    const unitOfWork = FinancialUnitOfWork.fromEntityManager(dataSource.manager);
    const wallet = await new CreateWalletUseCase(
      unitOfWork,
      new RandomIdGenerator(),
      new SystemClock(),
    ).execute({
      playerId: randomUUID(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const providerId = `phase8-provider-${wallet.id}`;
    const applicationMessageId = `phase8-message-${wallet.id}`;
    const data = {
      providerId,
      externalTransactionId: `phase8-transaction-${wallet.id}`,
      idempotencyKey: `phase8-key-${wallet.id}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'phase8-round',
      gameId: 'phase8-game',
      kind: WagerTransactionKind.Bet,
      money: { amount: '25.00', currency: 'BRL' },
    };
    const firstBody = commandBody(applicationMessageId, data);
    const replayBody = commandBody(applicationMessageId, data);

    await sendCommand(sqsClient, firstBody, wallet.id);
    const processUseCase = new ProcessWagerTransactionUseCase(
      unitOfWork,
      new RandomIdGenerator(),
      new SystemClock(),
      undefined,
      () => Promise.resolve(),
    );
    const consumer = new SqsCommandConsumer(
      queue,
      new SqsWagerCommandHandler(
        processUseCase,
        appConfig.messaging.consumerName,
        new SystemClock(),
      ),
      {
        enabled: false,
        queueName: commandQueueName,
        consumerName: appConfig.messaging.consumerName,
        concurrency: 1,
        waitTimeSeconds: 1,
        visibilityTimeoutSeconds: 5,
        visibilityHeartbeatSeconds: 2,
        shutdownTimeoutMs: 1000,
      },
      new SqsConsumerMetrics(),
    );

    await waitFor(async () => {
      await consumer.pollOnce();
      return countTransactions(providerId);
    });

    await sendCommand(sqsClient, replayBody, wallet.id);
    await waitFor(async () => {
      await consumer.pollOnce();
      return consumer.metrics.snapshot().messagesAcked === 2;
    });

    const rows = await dataSource.manager.query<
      Array<{ transactions: string; ledger: string; inbox: string; balance: string }>
    >(
      `SELECT
         (SELECT count(*)::text FROM wager_transactions WHERE provider_id = $1) AS transactions,
         (SELECT count(*)::text FROM wallet_ledger_entries WHERE wallet_id = $2 AND direction = 'DEBIT') AS ledger,
         (SELECT count(*)::text FROM inbox_messages WHERE consumer_name = $3 AND message_id = $4 AND processed_at IS NOT NULL) AS inbox,
         balance_minor::text AS balance
       FROM wallets WHERE id = $2`,
      [providerId, wallet.id, appConfig.messaging.consumerName, applicationMessageId],
    );

    expect(rows).toEqual([{ transactions: '1', ledger: '1', inbox: '1', balance: '7500' }]);
    const metrics = consumer.metrics.snapshot();
    expect(metrics.messagesReceived).toBeGreaterThanOrEqual(2);
    expect(metrics.messagesProcessed).toBe(2);
    expect(metrics.duplicateMessages).toBe(1);
    expect(metrics.messagesAcked).toBe(2);
  });

  test('redrives a command with the same application id and a divergent payload', async () => {
    if (queue === undefined || sqsClient === undefined) {
      throw new Error('The SQS integration was not initialized.');
    }
    const sqsQueue = queue;

    const unitOfWork = FinancialUnitOfWork.fromEntityManager(dataSource.manager);
    const wallet = await new CreateWalletUseCase(
      unitOfWork,
      new RandomIdGenerator(),
      new SystemClock(),
    ).execute({
      playerId: randomUUID(),
      initialBalance: { amount: '10.00', currency: 'BRL' },
    });
    const providerId = `phase8-dlq-provider-${wallet.id}`;
    const applicationMessageId = `phase8-dlq-message-${wallet.id}`;
    const validData = {
      providerId,
      externalTransactionId: `phase8-dlq-transaction-${wallet.id}`,
      idempotencyKey: `phase8-dlq-key-${wallet.id}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'phase8-dlq-round',
      gameId: 'phase8-dlq-game',
      kind: WagerTransactionKind.Bet,
      money: { amount: '1.00', currency: 'BRL' },
    };
    const divergentData = { ...validData, money: { amount: '2.00', currency: 'BRL' } };
    const processUseCase = new ProcessWagerTransactionUseCase(
      unitOfWork,
      new RandomIdGenerator(),
      new SystemClock(),
      undefined,
      () => Promise.resolve(),
    );
    const metrics = new SqsConsumerMetrics();
    const consumer = new SqsCommandConsumer(
      queue,
      new SqsWagerCommandHandler(
        processUseCase,
        appConfig.messaging.consumerName,
        new SystemClock(),
      ),
      {
        enabled: false,
        queueName: commandQueueName,
        consumerName: appConfig.messaging.consumerName,
        concurrency: 1,
        waitTimeSeconds: 0,
        visibilityTimeoutSeconds: 5,
        visibilityHeartbeatSeconds: 1,
        shutdownTimeoutMs: 1000,
      },
      metrics,
    );

    await sendCommand(sqsClient, commandBody(applicationMessageId, validData), wallet.id);
    await waitFor(async () => {
      await consumer.pollOnce();
      return countTransactions(providerId);
    });

    await sendCommand(sqsClient, commandBody(applicationMessageId, divergentData), wallet.id);
    const dlqUrl = await getQueueUrl(sqsClient, commandDlqName);
    const commandUrl = await getQueueUrl(sqsClient, commandQueueName);
    await waitFor(async () => {
      const messages = await sqsClient!.send(
        new ReceiveMessageCommand({
          QueueUrl: commandUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 0,
          VisibilityTimeout: 5,
        }),
      );
      if (messages.Messages?.[0] !== undefined) {
        const message = messages.Messages[0];
        await consumer.processMessage({
          transportMessageId: message.MessageId ?? '',
          receiptHandle: message.ReceiptHandle ?? '',
          body: message.Body ?? '',
        });
        await sqsQueue.changeVisibility(commandQueueName, message.ReceiptHandle ?? '', 0);
      }

      const deadLetters = await sqsClient!.send(
        new ReceiveMessageCommand({
          QueueUrl: dlqUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 0,
          VisibilityTimeout: 1,
        }),
      );
      return (
        deadLetters.Messages?.some((message) => message.Body?.includes(applicationMessageId)) ??
        false
      );
    }, 15000);

    const dlqMonitor = new SqsDlqMetricsMonitor(sqsQueue, metrics, {
      enabled: false,
      queueName: commandDlqName,
      refreshIntervalMs: 5_000,
    });
    await waitFor(async () => {
      await dlqMonitor.refresh();
      return metrics.snapshot().dlqMessages > 0;
    }, 15000);

    const rows = await dataSource.manager.query<Array<{ transactions: string; balance: string }>>(
      `SELECT
         (SELECT count(*)::text FROM wager_transactions WHERE provider_id = $1) AS transactions,
         balance_minor::text AS balance
       FROM wallets WHERE id = $2`,
      [providerId, wallet.id],
    );
    expect(rows).toEqual([{ transactions: '1', balance: '900' }]);
    expect(metrics.snapshot().dlqMessages).toBeGreaterThan(0);
    expect(metrics.snapshot().permanentFailures).toBeGreaterThan(0);
  });
});

if (!runRealIntegration) {
  test('real SQS integration is opt-in', () => {
    expect(true).toBe(true);
  });
}

function commandBody(messageId: string, data: Record<string, unknown>): string {
  return JSON.stringify({
    messageId,
    type: WAGER_TRANSACTION_REQUESTED_TYPE,
    occurredAt: new Date().toISOString(),
    data,
  });
}

async function sendCommand(client: SQSClient, body: string, walletId: string): Promise<void> {
  await client.send(
    new SendMessageCommand({
      QueueUrl: await getQueueUrl(client, commandQueueName),
      MessageBody: body,
      MessageGroupId: walletId,
      MessageDeduplicationId: randomUUID(),
    }),
  );
}

async function createQueue(
  client: SQSClient,
  queueName: string,
  extraAttributes: Record<string, string> = {},
): Promise<string> {
  const output = await client.send(
    new CreateQueueCommand({
      QueueName: queueName,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
        ...extraAttributes,
      },
    }),
  );
  if (output.QueueUrl === undefined) {
    throw new Error(`LocalStack did not create queue ${queueName}.`);
  }
  return output.QueueUrl;
}

async function deleteQueue(client: SQSClient, queueUrl: string | undefined): Promise<void> {
  if (queueUrl === undefined) {
    return;
  }
  try {
    await client.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
  } catch {
    // Cleanup is best effort if LocalStack was stopped externally.
  }
}

async function getQueueUrl(client: SQSClient, queueName: string): Promise<string> {
  const output = await client.send(new GetQueueUrlCommand({ QueueName: queueName }));
  if (output.QueueUrl === undefined) {
    throw new Error(`Queue URL was not returned for ${queueName}.`);
  }

  return output.QueueUrl;
}

async function countTransactions(providerId: string): Promise<boolean> {
  const rows = await dataSource.manager.query<Array<{ count: string }>>(
    'SELECT count(*)::text AS count FROM wager_transactions WHERE provider_id = $1',
    [providerId],
  );
  return rows[0]?.count === '1';
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Condition was not met within ${timeoutMs} ms.`);
}
