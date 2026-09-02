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
import { type ChildProcess, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { DataSource } from 'typeorm';

import { entities } from '../../src/infrastructure/database/entities/registry';
import { WAGER_TRANSACTION_REQUESTED_TYPE } from '../../src/infrastructure/messaging/sqs-command-envelope';

const baseDatabaseUrl =
  process.env.DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5432/wagering';
const sqsEndpoint = process.env.SQS_ENDPOINT ?? 'http://localhost:4566';
const sqsRegion = process.env.AWS_REGION ?? 'us-east-1';
const accessKeyId = process.env.AWS_ACCESS_KEY_ID ?? 'test';
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY ?? 'test';
const projectRoot = process.cwd();

export interface WalletView {
  readonly id: string;
  readonly playerId: string;
  readonly balance: { readonly amount: string; readonly currency: string };
}

export interface WagerInput {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
  readonly money: { readonly amount: string; readonly currency: string };
  readonly referenceExternalTransactionId?: string;
}

export interface WagerSubmission {
  readonly transactionId: string;
  readonly status: string;
  readonly balance?: { readonly amount: string; readonly currency: string };
  readonly idempotentReplay: boolean;
}

type StartedProcess = {
  readonly port: number;
  readonly process: ChildProcess;
  readonly logs: string[];
};

type WalletAudit = {
  readonly balance: string;
  readonly reconstructed: string;
  readonly transactions: string;
  readonly ledger: string;
  readonly inbox: string;
  readonly outbox: string;
};

export class DistributedHarness {
  readonly runId = randomUUID();
  readonly databaseName = `wagering_phase13_${this.runId.replaceAll('-', '')}`;
  readonly databaseUrl = isolatedDatabaseUrl(this.databaseName);
  readonly commandQueueName = `phase13-${this.runId}-commands.fifo`;
  readonly deadLetterQueueName = `phase13-${this.runId}-dlq.fifo`;
  readonly eventsQueueName = `phase13-${this.runId}-events.fifo`;
  readonly correlationIds = new Set<string>();

  readonly adminDataSource = new DataSource({ type: 'postgres', url: baseDatabaseUrl });
  readonly dataSource = new DataSource({
    type: 'postgres',
    url: this.databaseUrl,
    entities,
    migrations: ['src/infrastructure/database/migrations/*.{ts,js}'],
    synchronize: false,
  });
  readonly sqs = new SQSClient({
    region: sqsRegion,
    endpoint: sqsEndpoint,
    credentials: { accessKeyId, secretAccessKey },
  });

  private readonly processes: StartedProcess[] = [];
  private commandQueueUrl: string | undefined;
  private eventsQueueUrl: string | undefined;

  async start(): Promise<void> {
    await this.adminDataSource.initialize();
    await this.adminDataSource.query(`CREATE DATABASE "${this.databaseName}"`);
    await this.dataSource.initialize();
    await this.dataSource.runMigrations();
    await this.createQueues();
    await this.startInstances(3);
  }

  async stop(): Promise<void> {
    await this.stopInstances();
    await this.deleteQueues();
    if (this.dataSource.isInitialized) {
      await this.dataSource.destroy();
    }
    if (this.adminDataSource.isInitialized) {
      await this.adminDataSource.query(
        `DROP DATABASE IF EXISTS "${this.databaseName}" WITH (FORCE)`,
      );
      await this.adminDataSource.destroy();
    }
    this.sqs.destroy();
  }

  async restartInstances(): Promise<void> {
    await this.stopInstances();
    await this.startInstances(3);
  }

  async replaceWithCrashInstance(): Promise<StartedProcess> {
    await this.stopInstances();
    const instance = await this.startInstance(true);
    return instance;
  }

  async restoreThreeInstances(): Promise<void> {
    await this.stopInstances();
    await this.startInstances(3);
  }

  async createWallet(
    initialBalance: string,
    correlationId = this.nextCorrelationId(),
  ): Promise<WalletView> {
    const response = await this.request(
      0,
      'POST',
      '/wallets',
      {
        playerId: randomUUID(),
        initialBalance: { amount: initialBalance, currency: 'BRL' },
      },
      correlationId,
    );
    assertStatus(response, 201, correlationId);
    return (await response.json()) as WalletView;
  }

  async submitHttp(
    instanceIndex: number,
    input: WagerInput,
    idempotencyKey: string,
    correlationId = this.nextCorrelationId(),
  ): Promise<{ readonly response: Response; readonly body: WagerSubmission }> {
    const response = await this.request(
      instanceIndex,
      'POST',
      '/wagering/transactions',
      input,
      correlationId,
      { 'idempotency-key': idempotencyKey },
    );
    const body = (await response.json()) as WagerSubmission;
    return { response, body };
  }

  async sendCommand(input: WagerInput, idempotencyKey: string): Promise<string> {
    const messageId = `phase13-${randomUUID()}`;
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.requireCommandQueueUrl(),
        MessageGroupId: input.walletId,
        MessageDeduplicationId: randomUUID(),
        MessageBody: JSON.stringify({
          messageId,
          type: WAGER_TRANSACTION_REQUESTED_TYPE,
          occurredAt: new Date().toISOString(),
          data: { ...input, idempotencyKey },
        }),
      }),
    );
    return messageId;
  }

  async waitForTransaction(
    providerId: string,
    externalTransactionId: string,
    expectedStatus: string,
    correlationId: string,
  ): Promise<void> {
    await this.waitFor(
      async () => {
        const rows = await this.dataSource.query<Array<{ status: string }>>(
          `SELECT status
           FROM wager_transactions
           WHERE provider_id = $1 AND external_transaction_id = $2`,
          [providerId, externalTransactionId],
        );
        return rows[0]?.status === expectedStatus;
      },
      `transaction ${providerId}/${externalTransactionId} to become ${expectedStatus}`,
      correlationId,
    );
  }

  async waitForProcessExit(instance: StartedProcess, correlationId: string): Promise<void> {
    await this.waitFor(
      () => Promise.resolve(hasExited(instance.process)),
      `process on port ${instance.port} to terminate at the post-commit failpoint`,
      correlationId,
    );
  }

  async waitForOutboxPublished(walletIds: readonly string[], correlationId: string): Promise<void> {
    await this.waitFor(
      async () => {
        const rows = await this.dataSource.query<Array<{ count: string }>>(
          `SELECT count(*)::text AS count
           FROM outbox_messages
           WHERE aggregate_id = ANY($1::uuid[]) AND published_at IS NOT NULL`,
          [walletIds],
        );
        return rows[0]?.count === `${walletIds.length}`;
      },
      `outbox events for ${walletIds.join(',')} to be published`,
      correlationId,
    );
  }

  async receiveEventIds(
    expectedEventIds: readonly string[],
    correlationId: string,
  ): Promise<readonly string[]> {
    const ids: string[] = [];
    await this.waitFor(
      async () => {
        const response = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: this.requireEventsQueueUrl(),
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 0,
            VisibilityTimeout: 1,
          }),
        );
        for (const message of response.Messages ?? []) {
          const body = JSON.parse(message.Body ?? '{}') as { eventId?: string };
          if (body.eventId !== undefined) {
            ids.push(body.eventId);
          }
        }
        return expectedEventIds.every((eventId) => ids.includes(eventId));
      },
      `event messages ${expectedEventIds.join(',')}`,
      correlationId,
    );
    return ids;
  }

  async outboxEventIds(walletIds: readonly string[]): Promise<readonly string[]> {
    const rows = await this.dataSource.query<Array<{ id: string }>>(
      `SELECT id
       FROM outbox_messages
       WHERE aggregate_id = ANY($1::uuid[]) AND published_at IS NOT NULL
       ORDER BY id`,
      [walletIds],
    );
    return rows.map((row) => row.id);
  }

  async auditWallet(walletId: string, correlationId: string): Promise<WalletAudit> {
    const rows = await this.dataSource.query<WalletAudit[]>(
      `SELECT
         w.balance_minor::text AS balance,
         COALESCE(SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount_minor ELSE -l.amount_minor END), 0)::text AS reconstructed,
         (SELECT count(*)::text FROM wager_transactions WHERE wallet_id = w.id) AS transactions,
         (SELECT count(*)::text FROM wallet_ledger_entries WHERE wallet_id = w.id) AS ledger,
         (SELECT count(*)::text FROM inbox_messages) AS inbox,
         (SELECT count(*)::text FROM outbox_messages WHERE aggregate_id = w.id) AS outbox
       FROM wallets w
       LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
       WHERE w.id = $1
       GROUP BY w.id, w.balance_minor`,
      [walletId],
    );
    const audit = rows[0];
    if (audit === undefined || audit.balance !== audit.reconstructed) {
      throw this.diagnostic(
        `wallet/ledger mismatch for ${walletId}: ${JSON.stringify(audit)}`,
        correlationId,
      );
    }
    return audit;
  }

  async assertSchemaConstraints(walletId: string, correlationId: string): Promise<void> {
    let negativeBalanceRejected = false;
    try {
      await this.dataSource.query('UPDATE wallets SET balance_minor = -1 WHERE id = $1', [
        walletId,
      ]);
    } catch {
      negativeBalanceRejected = true;
    }

    const ledger = await this.dataSource.query<Array<{ id: string }>>(
      'SELECT id FROM wallet_ledger_entries WHERE wallet_id = $1 LIMIT 1',
      [walletId],
    );
    let ledgerMutationRejected = false;
    try {
      await this.dataSource.query(
        'UPDATE wallet_ledger_entries SET amount_minor = 1 WHERE id = $1',
        [ledger[0]?.id],
      );
    } catch {
      ledgerMutationRejected = true;
    }

    if (!negativeBalanceRejected || !ledgerMutationRejected) {
      throw this.diagnostic(
        `schema constraints failed: negative=${negativeBalanceRejected}, ledger=${ledgerMutationRejected}`,
        correlationId,
      );
    }
  }

  nextCorrelationId(): string {
    const correlationId = `phase13-correlation-${randomUUID()}`;
    this.correlationIds.add(correlationId);
    return correlationId;
  }

  diagnostic(message: string, correlationId: string): Error {
    const logs = this.processes
      .map(({ port, logs: lines }) => `port=${port}\n${lines.slice(-20).join('')}`)
      .join('\n');
    return new Error(
      `${message}; correlationId=${correlationId}; knownCorrelationIds=${[...this.correlationIds].join(',')}; processLogs=${logs}`,
    );
  }

  private async createQueues(): Promise<void> {
    const deadLetterQueueUrl = await this.createQueue(this.deadLetterQueueName);
    const attributes = await this.sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: deadLetterQueueUrl,
        AttributeNames: ['QueueArn'],
      }),
    );
    const deadLetterArn = attributes.Attributes?.QueueArn;
    if (deadLetterArn === undefined) {
      throw new Error('LocalStack did not return the phase 13 DLQ ARN.');
    }
    this.commandQueueUrl = await this.createQueue(this.commandQueueName, {
      RedrivePolicy: JSON.stringify({ deadLetterTargetArn: deadLetterArn, maxReceiveCount: '5' }),
    });
    this.eventsQueueUrl = await this.createQueue(this.eventsQueueName);
  }

  private async createQueue(
    name: string,
    extraAttributes: Record<string, string> = {},
  ): Promise<string> {
    const response = await this.sqs.send(
      new CreateQueueCommand({
        QueueName: name,
        Attributes: {
          FifoQueue: 'true',
          ContentBasedDeduplication: 'false',
          ...extraAttributes,
        },
      }),
    );
    if (response.QueueUrl === undefined) {
      throw new Error(`LocalStack did not create queue ${name}.`);
    }
    return response.QueueUrl;
  }

  private async deleteQueues(): Promise<void> {
    for (const name of [this.commandQueueName, this.deadLetterQueueName, this.eventsQueueName]) {
      try {
        const queueUrl = await this.queueUrl(name);
        await this.sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
      } catch {
        // The test database is still removed even if LocalStack was stopped externally.
      }
    }
  }

  private async startInstances(count: number): Promise<void> {
    // Bun can race while resolving/transpiling the same NestJS dependency graph in
    // multiple fresh processes. Start-up is sequential; the fully initialized
    // processes still execute every distributed scenario concurrently.
    for (let index = 0; index < count; index += 1) {
      await this.startInstance();
    }
  }

  private async startInstance(crashAfterCommit = false): Promise<StartedProcess> {
    const port = await findAvailablePort();
    const logs: string[] = [];
    const child = spawn(process.execPath, ['src/bootstrap.ts'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT: `${port}`,
        HOST: '127.0.0.1',
        LOG_LEVEL: 'silent',
        DATABASE_URL: this.databaseUrl,
        SQS_ENDPOINT: sqsEndpoint,
        AWS_REGION: sqsRegion,
        AWS_ACCESS_KEY_ID: accessKeyId,
        AWS_SECRET_ACCESS_KEY: secretAccessKey,
        SQS_COMMAND_QUEUE_NAME: this.commandQueueName,
        SQS_COMMAND_DLQ_NAME: this.deadLetterQueueName,
        SQS_EVENTS_QUEUE_NAME: this.eventsQueueName,
        SQS_CONSUMER_ENABLED: 'true',
        SQS_CONSUMER_CONCURRENCY: '1',
        SQS_WAIT_TIME_SECONDS: '1',
        SQS_VISIBILITY_TIMEOUT_SECONDS: '2',
        SQS_VISIBILITY_HEARTBEAT_SECONDS: '1',
        SQS_SHUTDOWN_TIMEOUT_MS: '1000',
        SQS_OUTBOX_PUBLISHER_ENABLED: 'true',
        SQS_OUTBOX_BATCH_SIZE: '10',
        SQS_OUTBOX_POLL_INTERVAL_MS: '50',
        SQS_OUTBOX_LEASE_MS: '1000',
        SQS_OUTBOX_SHUTDOWN_TIMEOUT_MS: '1000',
        PENDING_REFERENCE_WORKER_ENABLED: 'true',
        PENDING_REFERENCE_BATCH_SIZE: '10',
        PENDING_REFERENCE_POLL_INTERVAL_MS: '50',
        PENDING_REFERENCE_LEASE_MS: '1000',
        PENDING_REFERENCE_SHUTDOWN_TIMEOUT_MS: '1000',
        PENDING_REFERENCE_RETRY_BASE_DELAY_MS: '50',
        PENDING_REFERENCE_RETRY_MAX_DELAY_MS: '100',
        PENDING_REFERENCE_TTL_MS: '60000',
        SWAGGER_ENABLED: 'false',
        OTEL_ENABLED: 'false',
        ...(crashAfterCommit
          ? { SQS_TEST_FAILPOINT: 'terminate-after-commit-before-ack' }
          : { SQS_TEST_FAILPOINT: '' }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk: Buffer) => logs.push(chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => logs.push(chunk.toString()));
    const instance = { port, process: child, logs };
    this.processes.push(instance);
    const startupCorrelationId = this.nextCorrelationId();
    await this.waitFor(
      async () => {
        if (hasExited(child)) {
          throw this.diagnostic(
            `application process on port ${port} exited before becoming live`,
            startupCorrelationId,
          );
        }
        const response = await fetch(`http://127.0.0.1:${port}/health/live`).catch(() => undefined);
        return response?.status === 200;
      },
      `application process on port ${port} to become live`,
      startupCorrelationId,
    );
    return instance;
  }

  private async stopInstances(): Promise<void> {
    const running = this.processes.splice(0, this.processes.length);
    await Promise.all(
      running.map(async (instance) => {
        if (!hasExited(instance.process)) {
          instance.process.kill('SIGTERM');
          await Promise.race([onceExited(instance.process), delay(5000)]);
          if (!hasExited(instance.process)) {
            instance.process.kill('SIGKILL');
          }
        }
      }),
    );
  }

  private async request(
    instanceIndex: number,
    method: 'POST',
    path: string,
    body: unknown,
    correlationId: string,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const instance = this.processes[instanceIndex % this.processes.length];
    if (instance === undefined) {
      throw this.diagnostic('no application process is available', correlationId);
    }
    return fetch(`http://127.0.0.1:${instance.port}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-correlation-id': correlationId,
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }

  private requireCommandQueueUrl(): string {
    if (this.commandQueueUrl === undefined) {
      throw new Error('The phase 13 command queue was not created.');
    }
    return this.commandQueueUrl;
  }

  private requireEventsQueueUrl(): string {
    if (this.eventsQueueUrl === undefined) {
      throw new Error('The phase 13 events queue was not created.');
    }
    return this.eventsQueueUrl;
  }

  private async queueUrl(name: string): Promise<string> {
    const response = await this.sqs.send(new GetQueueUrlCommand({ QueueName: name }));
    if (response.QueueUrl === undefined) {
      throw new Error(`LocalStack did not return queue ${name}.`);
    }
    return response.QueueUrl;
  }

  private async waitFor(
    predicate: () => Promise<boolean>,
    expectation: string,
    correlationId: string,
    timeoutMs = 20000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) {
        return;
      }
      await delay(50);
    }
    throw this.diagnostic(`Timed out waiting for ${expectation}`, correlationId);
  }
}

async function findAvailablePort(): Promise<number> {
  const server = createServer();
  server.unref();

  return new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('The operating system did not allocate a TCP port.'));
        return;
      }

      const port = address.port;
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
        } else {
          resolve(port);
        }
      });
    });
  });
}

function isolatedDatabaseUrl(name: string): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

function assertStatus(response: Response, expected: number, correlationId: string): void {
  if (response.status !== expected) {
    throw new Error(
      `Expected HTTP ${expected}, received ${response.status}; correlationId=${correlationId}`,
    );
  }
}

function onceExited(process: ChildProcess): Promise<void> {
  return new Promise((resolve) => process.once('exit', () => resolve()));
}

function hasExited(process: ChildProcess): boolean {
  return process.exitCode !== null || process.signalCode !== null;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
