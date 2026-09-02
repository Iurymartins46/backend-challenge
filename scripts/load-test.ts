import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';
import { type ChildProcess, spawn } from 'node:child_process';
import { cpus, platform, release, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { DataSource } from 'typeorm';

import { entities } from '../src/infrastructure/database/entities/registry';

const defaultDatabaseUrl =
  process.env.DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5432/wagering';
const defaultSqsEndpoint = process.env.SQS_ENDPOINT ?? 'http://localhost:4566';
const defaultAwsRegion = process.env.AWS_REGION ?? 'us-east-1';
const defaultAccessKeyId = process.env.AWS_ACCESS_KEY_ID ?? 'test';
const defaultSecretAccessKey = process.env.AWS_SECRET_ACCESS_KEY ?? 'test';
const projectRoot = process.cwd();
const postgresPoolMax = 10;

const HOT_INITIAL_BALANCE = '1000000.00';
const MANY_INITIAL_BALANCE = '100000.00';
const REQUEST_AMOUNT = '1.00';

type ScenarioName = 'hot-wallet' | 'many-wallets';

interface LoadOptions {
  readonly instances: number;
  readonly concurrency: number;
  readonly warmupMs: number;
  readonly durationMs: number;
  readonly cooldownMs: number;
  readonly drainTimeoutMs: number;
  readonly httpTimeoutMs: number;
  readonly metricsSampleIntervalMs: number;
  readonly manyWalletCount: number;
  readonly walletCreationConcurrency: number;
  readonly reportPath: string | undefined;
}

interface WalletView {
  readonly id: string;
  readonly playerId: string;
}

interface WagerInput {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: 'BET';
  readonly money: { readonly amount: string; readonly currency: 'BRL' };
}

interface RequestObservation {
  readonly status: number | undefined;
  readonly latencyMs: number;
}

interface WindowResult {
  readonly configuredDurationMs: number;
  readonly elapsedMs: number;
  readonly startedRequests: number;
  readonly completedRequests: number;
  readonly errors: number;
  readonly statusCounts: Readonly<Record<string, number>>;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly p99Ms: number | null;
  readonly throughputRps: number;
}

interface OutboxSnapshot {
  readonly pendingCount: number;
  readonly lagMs: number;
}

interface OutboxSample extends OutboxSnapshot {
  readonly phase: 'warmup' | 'measurement' | 'cooldown';
  readonly observedAt: string;
}

interface ProcessMetricsSnapshot {
  readonly lockConflicts: number;
  readonly outboxPendingMessages: number;
  readonly outboxLagMs: number;
}

interface WalletLedgerAudit {
  readonly walletsChecked: number;
  readonly mismatchedWallets: number;
  readonly ledgerEntries: number;
}

interface ScenarioReport {
  readonly name: ScenarioName;
  readonly warmup: WindowResult;
  readonly measurement: WindowResult;
  readonly cooldown: {
    readonly configuredDurationMs: number;
    readonly elapsedMs: number;
    readonly drained: boolean;
  };
  readonly lockConflicts: {
    readonly beforeMeasurement: number;
    readonly afterMeasurement: number;
    readonly duringMeasurement: number;
  };
  readonly outbox: {
    readonly beforeMeasurement: OutboxSnapshot;
    readonly afterMeasurement: OutboxSnapshot;
    readonly afterCooldown: OutboxSnapshot;
    readonly maxObservedDuringRun: OutboxSnapshot;
    readonly metricAfterMeasurement: {
      readonly pendingMessages: number;
      readonly lagMs: number;
    };
  };
  readonly walletLedgerAudit: WalletLedgerAudit;
  readonly samplesCollected: number;
  readonly sampleErrors: number;
}

interface LoadReport {
  readonly phase: 16;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly configuration: {
    readonly instances: number;
    readonly perProcessPoolMax: number;
    readonly totalPotentialPoolConnections: number;
    readonly concurrency: number;
    readonly warmupMs: number;
    readonly measurementMs: number;
    readonly cooldownMs: number;
    readonly drainTimeoutMs: number;
    readonly httpTimeoutMs: number;
    readonly metricsSampleIntervalMs: number;
    readonly manyWallets: number;
    readonly requestAmount: string;
    readonly hotInitialBalance: string;
    readonly manyWalletInitialBalance: string;
  };
  readonly environment: {
    readonly bunVersion: string;
    readonly nodeVersion: string;
    readonly platform: string;
    readonly kernel: string;
    readonly architecture: string;
    readonly logicalCpus: number;
    readonly memoryGiB: number;
    readonly database: string;
    readonly sqsEndpoint: string;
    readonly isolatedDatabase: string;
    readonly queues: {
      readonly commands: string;
      readonly deadLetter: string;
      readonly events: string;
    };
  };
  readonly scenarios: readonly ScenarioReport[];
  readonly limitations: readonly string[];
}

interface StartedProcess {
  readonly port: number;
  readonly process: ChildProcess;
  readonly logs: string[];
}

class LoadTestRunner {
  readonly runToken = randomUUID();
  readonly databaseName = `wagering_phase16_${this.runToken.replaceAll('-', '')}`;
  readonly commandQueueName = `phase16-${this.runToken}-commands.fifo`;
  readonly deadLetterQueueName = `phase16-${this.runToken}-dlq.fifo`;
  readonly eventsQueueName = `phase16-${this.runToken}-events.fifo`;

  readonly adminDataSource = new DataSource({ type: 'postgres', url: defaultDatabaseUrl });
  readonly dataSource = new DataSource({
    type: 'postgres',
    url: isolatedDatabaseUrl(this.databaseName),
    entities,
    migrations: ['src/infrastructure/database/migrations/*.{ts,js}'],
    synchronize: false,
  });
  readonly sqs = new SQSClient({
    region: defaultAwsRegion,
    endpoint: defaultSqsEndpoint,
    credentials: { accessKeyId: defaultAccessKeyId, secretAccessKey: defaultSecretAccessKey },
  });

  private readonly processes: StartedProcess[] = [];
  private readonly startedAt = new Date();
  private commandQueueUrl: string | undefined;
  private deadLetterQueueUrl: string | undefined;
  private eventsQueueUrl: string | undefined;

  constructor(private readonly options: LoadOptions) {}

  async run(): Promise<LoadReport> {
    await this.startInfrastructure();

    const hotWallet = await this.createWallet(HOT_INITIAL_BALANCE, 'hot-wallet');
    const manyWallets = await this.createWallets();
    await this.waitForOutboxDrain(this.options.drainTimeoutMs);

    const scenarios = [
      await this.runScenario('hot-wallet', [hotWallet]),
      await this.runScenario('many-wallets', manyWallets),
    ];
    const finishedAt = new Date();

    return {
      phase: 16,
      startedAt: this.startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      configuration: {
        instances: this.options.instances,
        perProcessPoolMax: postgresPoolMax,
        totalPotentialPoolConnections: this.options.instances * postgresPoolMax,
        concurrency: this.options.concurrency,
        warmupMs: this.options.warmupMs,
        measurementMs: this.options.durationMs,
        cooldownMs: this.options.cooldownMs,
        drainTimeoutMs: this.options.drainTimeoutMs,
        httpTimeoutMs: this.options.httpTimeoutMs,
        metricsSampleIntervalMs: this.options.metricsSampleIntervalMs,
        manyWallets: this.options.manyWalletCount,
        requestAmount: REQUEST_AMOUNT,
        hotInitialBalance: HOT_INITIAL_BALANCE,
        manyWalletInitialBalance: MANY_INITIAL_BALANCE,
      },
      environment: {
        bunVersion: Bun.version,
        nodeVersion: process.version,
        platform: platform(),
        kernel: release(),
        architecture: process.arch,
        logicalCpus: cpus().length,
        memoryGiB: roundMetric(totalmem() / 1024 ** 3),
        database: redactDatabaseUrl(defaultDatabaseUrl),
        sqsEndpoint: defaultSqsEndpoint,
        isolatedDatabase: this.databaseName,
        queues: {
          commands: this.commandQueueName,
          deadLetter: this.deadLetterQueueName,
          events: this.eventsQueueName,
        },
      },
      scenarios,
      limitations: [
        'Closed-loop HTTP workload: clients issue the next request only after the previous one completes.',
        'There is no target RPS; throughput is an observation of this machine and configuration.',
        `Lock conflicts and outbox publisher metrics are process-local and are aggregated across the ${this.options.instances} instances.`,
        'Outbox snapshots are read directly from PostgreSQL; periodic sampling adds a small diagnostic query load.',
        'Warm-up and cooldown are excluded from measurement latency and throughput.',
        'Business rejections (HTTP 4xx) are reported separately from transport/server errors.',
        'The load database and FIFO queues are temporary; the development database and default queues are not used.',
      ],
    };
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

  private async startInfrastructure(): Promise<void> {
    await this.adminDataSource.initialize();
    await this.adminDataSource.query(`CREATE DATABASE "${this.databaseName}"`);
    await this.dataSource.initialize();
    await this.dataSource.runMigrations();
    await this.createQueues();
    await this.startInstances();
  }

  private async createQueues(): Promise<void> {
    const deadLetterQueueUrl = await this.createQueue(this.deadLetterQueueName);
    this.deadLetterQueueUrl = deadLetterQueueUrl;
    const attributes = await this.sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: deadLetterQueueUrl,
        AttributeNames: ['QueueArn'],
      }),
    );
    const deadLetterArn = attributes.Attributes?.QueueArn;
    if (deadLetterArn === undefined) {
      throw new Error('LocalStack did not return the Phase 16 DLQ ARN.');
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
    for (const queueUrl of [this.commandQueueUrl, this.deadLetterQueueUrl, this.eventsQueueUrl]) {
      if (queueUrl === undefined) {
        continue;
      }
      try {
        await this.sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
      } catch {
        // Cleanup is best effort if LocalStack was stopped externally.
      }
    }
  }

  private async startInstances(): Promise<void> {
    for (let index = 0; index < this.options.instances; index += 1) {
      await this.startInstance();
    }
  }

  private async startInstance(): Promise<StartedProcess> {
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
        DATABASE_URL: isolatedDatabaseUrl(this.databaseName),
        SQS_ENDPOINT: defaultSqsEndpoint,
        AWS_REGION: defaultAwsRegion,
        AWS_ACCESS_KEY_ID: defaultAccessKeyId,
        AWS_SECRET_ACCESS_KEY: defaultSecretAccessKey,
        SQS_COMMAND_QUEUE_NAME: this.commandQueueName,
        SQS_COMMAND_DLQ_NAME: this.deadLetterQueueName,
        SQS_EVENTS_QUEUE_NAME: this.eventsQueueName,
        SQS_CONSUMER_ENABLED: 'false',
        SQS_OUTBOX_PUBLISHER_ENABLED: 'true',
        PENDING_REFERENCE_WORKER_ENABLED: 'false',
        SWAGGER_ENABLED: 'false',
        OTEL_ENABLED: 'false',
        SQS_TEST_FAILPOINT: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const appendLog = (chunk: Buffer): void => {
      logs.push(chunk.toString());
      if (logs.length > 40) {
        logs.shift();
      }
    };
    child.stdout?.on('data', appendLog);
    child.stderr?.on('data', appendLog);

    const instance = { port, process: child, logs };
    this.processes.push(instance);
    await this.waitFor(
      async () => {
        if (hasExited(child)) {
          throw this.diagnostic(`application process on port ${port} exited before becoming live`);
        }
        const response = await fetch(`http://127.0.0.1:${port}/health/live`).catch(() => undefined);
        return response?.status === 200;
      },
      `application process on port ${port} to become live`,
      30000,
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

  private async createWallet(initialBalance: string, label: string): Promise<WalletView> {
    const response = await this.request(
      0,
      '/wallets',
      {
        playerId: randomUUID(),
        initialBalance: { amount: initialBalance, currency: 'BRL' },
      },
      `wallet-${label}`,
    );
    if (response.status !== 201) {
      throw this.diagnostic(`wallet creation returned HTTP ${response.status}`);
    }

    const body: unknown = await response.json();
    if (!isWalletView(body)) {
      throw this.diagnostic(`wallet creation returned an invalid response for ${label}`);
    }
    return body;
  }

  private async createWallets(): Promise<WalletView[]> {
    const wallets: Array<WalletView | undefined> = Array.from(
      { length: this.options.manyWalletCount },
      () => undefined,
    );
    let nextIndex = 0;
    const workerCount = Math.min(
      this.options.walletCreationConcurrency,
      this.options.manyWalletCount,
    );
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (true) {
          const index = nextIndex;
          nextIndex += 1;
          if (index >= this.options.manyWalletCount) {
            return;
          }
          wallets[index] = await this.createWallet(MANY_INITIAL_BALANCE, `many-${index}`);
        }
      }),
    );

    return wallets.map((wallet, index) => {
      if (wallet === undefined) {
        throw this.diagnostic(`wallet ${index} was not created`);
      }
      return wallet;
    });
  }

  private async runScenario(
    name: ScenarioName,
    wallets: readonly WalletView[],
  ): Promise<ScenarioReport> {
    const observations: OutboxSample[] = [];
    const sampler = new OutboxSampler(this.options.metricsSampleIntervalMs, async (phase) => {
      const snapshot = await this.outboxSnapshot();
      observations.push({ ...snapshot, phase, observedAt: new Date().toISOString() });
    });
    let requestSequence = 0;
    const nextRequest = (): { readonly input: WagerInput; readonly idempotencyKey: string } => {
      const sequence = requestSequence;
      requestSequence += 1;
      const wallet = wallets[sequence % wallets.length];
      if (wallet === undefined) {
        throw this.diagnostic(`scenario ${name} has no wallet at sequence ${sequence}`);
      }
      return {
        input: {
          providerId: `phase16-${name}-${this.runToken}`,
          externalTransactionId: `${name}-${sequence}`,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: `phase16-${name}-round`,
          gameId: 'phase16-load',
          kind: 'BET',
          money: { amount: REQUEST_AMOUNT, currency: 'BRL' },
        },
        idempotencyKey: `phase16-${name}-${this.runToken}-${sequence}`,
      };
    };

    sampler.start();
    try {
      sampler.setPhase('warmup');
      const warmup = await this.runWindow(this.options.warmupMs, nextRequest);
      const metricsBefore = await this.processMetrics();
      const outboxBefore = await this.outboxSnapshot();

      sampler.setPhase('measurement');
      const measurement = await this.runWindow(this.options.durationMs, nextRequest);
      const metricsAfter = await this.processMetrics();
      const outboxAfter = await this.outboxSnapshot();

      sampler.setPhase('cooldown');
      const cooldownStartedAt = performance.now();
      await delay(this.options.cooldownMs);
      let outbox = await this.outboxSnapshot();
      let drained = outbox.pendingCount === 0;
      const drainDeadline = performance.now() + this.options.drainTimeoutMs;
      while (!drained && performance.now() < drainDeadline) {
        await delay(Math.min(100, Math.max(1, drainDeadline - performance.now())));
        outbox = await this.outboxSnapshot();
        drained = outbox.pendingCount === 0;
      }
      const cooldownElapsedMs = performance.now() - cooldownStartedAt;
      const outboxAfterCooldown = outbox;
      await sampler.stop();

      const maxObserved = maxOutboxSample(
        observations,
        outboxBefore,
        outboxAfter,
        outboxAfterCooldown,
      );
      return {
        name,
        warmup,
        measurement,
        cooldown: {
          configuredDurationMs: this.options.cooldownMs,
          elapsedMs: roundMetric(cooldownElapsedMs),
          drained,
        },
        lockConflicts: {
          beforeMeasurement: metricsBefore.lockConflicts,
          afterMeasurement: metricsAfter.lockConflicts,
          duringMeasurement: Math.max(0, metricsAfter.lockConflicts - metricsBefore.lockConflicts),
        },
        outbox: {
          beforeMeasurement: outboxBefore,
          afterMeasurement: outboxAfter,
          afterCooldown: outboxAfterCooldown,
          maxObservedDuringRun: maxObserved,
          metricAfterMeasurement: {
            pendingMessages: metricsAfter.outboxPendingMessages,
            lagMs: metricsAfter.outboxLagMs,
          },
        },
        walletLedgerAudit: await this.auditWallets(wallets.map(({ id }) => id)),
        samplesCollected: observations.length,
        sampleErrors: sampler.sampleErrors,
      };
    } finally {
      await sampler.stop();
    }
  }

  private async runWindow(
    configuredDurationMs: number,
    nextRequest: () => { readonly input: WagerInput; readonly idempotencyKey: string },
  ): Promise<WindowResult> {
    const startedAt = performance.now();
    const deadline = startedAt + configuredDurationMs;
    const observations: RequestObservation[] = [];
    let startedRequests = 0;

    const worker = async (): Promise<void> => {
      while (performance.now() < deadline) {
        const request = nextRequest();
        startedRequests += 1;
        const requestStartedAt = performance.now();
        let status: number | undefined;
        try {
          status = await this.submit(request.input, request.idempotencyKey, startedRequests);
        } catch {
          // Network and timeout failures are measured, not hidden by aborting the run.
        }
        observations.push({ status, latencyMs: performance.now() - requestStartedAt });
      }
    };

    await Promise.all(Array.from({ length: this.options.concurrency }, () => worker()));
    const elapsedMs = performance.now() - startedAt;
    return summarizeWindow(configuredDurationMs, elapsedMs, startedRequests, observations);
  }

  private async submit(
    input: WagerInput,
    idempotencyKey: string,
    sequence: number,
  ): Promise<number> {
    const response = await this.request(
      sequence,
      '/wagering/transactions',
      input,
      `wager-${input.walletId}-${sequence}`,
      { 'idempotency-key': idempotencyKey },
    );
    await response.arrayBuffer();
    return response.status;
  }

  private async request(
    instanceIndex: number,
    path: string,
    body: unknown,
    correlationId: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    const instance = this.processes[instanceIndex % this.processes.length];
    if (instance === undefined) {
      throw this.diagnostic('no application process is available');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.httpTimeoutMs);
    try {
      return await fetch(`http://127.0.0.1:${instance.port}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-correlation-id': correlationId,
          ...extraHeaders,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async processMetrics(): Promise<ProcessMetricsSnapshot> {
    const metrics = await Promise.all(
      this.processes.map(async (instance) => {
        const response = await fetch(`http://127.0.0.1:${instance.port}/metrics`);
        if (response.status !== 200) {
          throw this.diagnostic(
            `metrics endpoint on port ${instance.port} returned HTTP ${response.status}`,
          );
        }
        return parsePrometheusMetrics(await response.text());
      }),
    );
    return {
      lockConflicts: metrics.reduce((total, current) => total + current.lockConflicts, 0),
      outboxPendingMessages: Math.max(
        ...metrics.map(({ outboxPendingMessages }) => outboxPendingMessages),
      ),
      outboxLagMs: Math.max(...metrics.map(({ outboxLagMs }) => outboxLagMs)),
    };
  }

  private async outboxSnapshot(): Promise<OutboxSnapshot> {
    const rows = await this.dataSource.query<Array<{ pendingCount: string; lagMs: string }>>(
      `SELECT
         COUNT(*)::text AS "pendingCount",
         COALESCE(
           GREATEST(
             EXTRACT(EPOCH FROM (clock_timestamp() - MIN(occurred_at))) * 1000,
             0
           ),
           0
         )::text AS "lagMs"
       FROM outbox_messages
       WHERE published_at IS NULL`,
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error('The outbox snapshot query returned no row.');
    }

    const pendingCount = Number(row.pendingCount);
    const lagMs = Number(row.lagMs);
    if (!Number.isSafeInteger(pendingCount) || pendingCount < 0 || !Number.isFinite(lagMs)) {
      throw new Error('The outbox snapshot returned invalid values.');
    }
    return { pendingCount, lagMs: Math.max(0, roundMetric(lagMs)) };
  }

  private async waitForOutboxDrain(timeoutMs: number): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      if ((await this.outboxSnapshot()).pendingCount === 0) {
        return;
      }
      await delay(100);
    }
    throw this.diagnostic('outbox did not drain before the load scenarios started');
  }

  private async auditWallets(walletIds: readonly string[]): Promise<WalletLedgerAudit> {
    const rows = await this.dataSource.query<
      Array<{ id: string; balance: string; reconstructed: string; ledgerEntries: string }>
    >(
      `SELECT
         w.id,
         w.balance_minor::text AS "balance",
         COALESCE(
           SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount_minor ELSE -l.amount_minor END),
           0
         )::text AS "reconstructed",
         COUNT(l.id)::text AS "ledgerEntries"
       FROM wallets w
       LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
       WHERE w.id = ANY($1::uuid[])
       GROUP BY w.id, w.balance_minor`,
      [walletIds],
    );
    const mismatchedWallets = rows.filter(
      ({ balance, reconstructed }) => balance !== reconstructed,
    ).length;
    const ledgerEntries = rows.reduce((total, row) => total + Number(row.ledgerEntries), 0);
    return {
      walletsChecked: rows.length,
      mismatchedWallets: mismatchedWallets + Math.max(0, walletIds.length - rows.length),
      ledgerEntries,
    };
  }

  private diagnostic(message: string): Error {
    const logs = this.processes
      .map(({ port, logs: lines }) => `port=${port}\n${lines.slice(-20).join('')}`)
      .join('\n');
    return new Error(`${message}; database=${this.databaseName}; processLogs=${logs}`);
  }

  private async waitFor(
    predicate: () => Promise<boolean>,
    expectation: string,
    timeoutMs: number,
  ): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      if (await predicate()) {
        return;
      }
      await delay(50);
    }
    throw this.diagnostic(`Timed out waiting for ${expectation}`);
  }
}

class OutboxSampler {
  private running = false;
  private phase: OutboxSample['phase'] = 'warmup';
  private loopPromise: Promise<void> | undefined;
  private _sampleErrors = 0;

  constructor(
    private readonly intervalMs: number,
    private readonly sample: (phase: OutboxSample['phase']) => Promise<void>,
  ) {}

  get sampleErrors(): number {
    return this._sampleErrors;
  }

  start(): void {
    this.running = true;
    this.loopPromise = this.loop();
  }

  setPhase(phase: OutboxSample['phase']): void {
    this.phase = phase;
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loopPromise;
    this.loopPromise = undefined;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.sample(this.phase);
      } catch {
        this._sampleErrors += 1;
      }
      if (this.running) {
        await delay(this.intervalMs);
      }
    }
  }
}

function summarizeWindow(
  configuredDurationMs: number,
  elapsedMs: number,
  startedRequests: number,
  observations: readonly RequestObservation[],
): WindowResult {
  const statusCounts = new Map<string, number>();
  for (const observation of observations) {
    const status = observation.status === undefined ? 'network_error' : `${observation.status}`;
    statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
  }
  const latencyValues = observations.map(({ latencyMs }) => latencyMs).sort((a, b) => a - b);
  const errors = observations.filter(({ status }) => status === undefined || status >= 500).length;
  const completedRequests = observations.length;
  const throughputRps = elapsedMs === 0 ? 0 : (completedRequests / elapsedMs) * 1000;

  return {
    configuredDurationMs,
    elapsedMs: roundMetric(elapsedMs),
    startedRequests,
    completedRequests,
    errors,
    statusCounts: Object.fromEntries(
      [...statusCounts.entries()].sort(([first], [second]) => first.localeCompare(second)),
    ),
    p50Ms: percentile(latencyValues, 0.5),
    p95Ms: percentile(latencyValues, 0.95),
    p99Ms: percentile(latencyValues, 0.99),
    throughputRps: roundMetric(throughputRps),
  };
}

function percentile(values: readonly number[], percentileValue: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const position = (values.length - 1) * percentileValue;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowerValue = values[lower];
  const upperValue = values[upper];
  if (lowerValue === undefined || upperValue === undefined) {
    return null;
  }
  return roundMetric(lowerValue + (upperValue - lowerValue) * (position - lower));
}

function maxOutboxSample(
  samples: readonly OutboxSample[],
  ...boundaries: readonly OutboxSnapshot[]
): OutboxSnapshot {
  const values = [
    ...boundaries,
    ...samples.map(({ pendingCount, lagMs }) => ({ pendingCount, lagMs })),
  ];
  return {
    pendingCount: Math.max(...values.map(({ pendingCount }) => pendingCount)),
    lagMs: Math.max(...values.map(({ lagMs }) => lagMs)),
  };
}

function parsePrometheusMetrics(body: string): ProcessMetricsSnapshot {
  return {
    lockConflicts: sumMetric(body, 'wagering_locks_conflicts_total'),
    outboxPendingMessages: maxMetric(body, 'wagering_outbox_pending_messages'),
    outboxLagMs: maxMetric(body, 'wagering_outbox_lag_ms'),
  };
}

function sumMetric(body: string, metricName: string): number {
  return metricLines(body, metricName).reduce((total, value) => total + value, 0);
}

function maxMetric(body: string, metricName: string): number {
  const values = metricLines(body, metricName);
  return values.length === 0 ? 0 : Math.max(...values);
}

function metricLines(body: string, metricName: string): number[] {
  const escapedName = metricName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escapedName}(?:\\{[^}]*\\})?\\s+([-+0-9.eE]+)$`);
  return body
    .split('\n')
    .map((line) => line.match(pattern)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number)
    .filter((value) => Number.isFinite(value));
}

function loadOptions(): LoadOptions {
  return {
    instances: positiveInteger('LOAD_INSTANCES', 3, 3),
    concurrency: positiveInteger('LOAD_CONCURRENCY', 16),
    warmupMs: positiveInteger('LOAD_WARMUP_MS', 1000),
    durationMs: positiveInteger('LOAD_DURATION_MS', 5000),
    cooldownMs: positiveInteger('LOAD_COOLDOWN_MS', 5000),
    drainTimeoutMs: positiveInteger('LOAD_DRAIN_TIMEOUT_MS', 30000),
    httpTimeoutMs: positiveInteger('LOAD_HTTP_TIMEOUT_MS', 10000),
    metricsSampleIntervalMs: positiveInteger('LOAD_METRICS_SAMPLE_INTERVAL_MS', 250),
    manyWalletCount: positiveInteger('LOAD_MANY_WALLETS', 32, 2),
    walletCreationConcurrency: positiveInteger('LOAD_WALLET_CREATION_CONCURRENCY', 8),
    reportPath: optionalEnvironment('LOAD_REPORT_PATH'),
  };
}

function positiveInteger(name: string, fallback: number, minimum = 1): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be a safe integer greater than or equal to ${minimum}.`);
  }
  return value;
}

function optionalEnvironment(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function isWalletView(value: unknown): value is WalletView {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { id?: unknown; playerId?: unknown };
  return typeof candidate.id === 'string' && typeof candidate.playerId === 'string';
}

function isolatedDatabaseUrl(databaseName: string): string {
  const url = new URL(defaultDatabaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function redactDatabaseUrl(value: string): string {
  const url = new URL(value);
  if (url.password.length > 0) {
    url.password = '***';
  }
  if (url.username.length > 0) {
    url.username = '***';
  }
  return url.toString();
}

function roundMetric(value: number): number {
  return Math.round(value * 100) / 100;
}

function findAvailablePort(): Promise<number> {
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

function onceExited(process: ChildProcess): Promise<void> {
  return new Promise((resolve) => process.once('exit', () => resolve()));
}

function hasExited(process: ChildProcess): boolean {
  return process.exitCode !== null || process.signalCode !== null;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main(): Promise<void> {
  const options = loadOptions();
  const runner = new LoadTestRunner(options);
  let report: LoadReport | undefined;
  try {
    report = await runner.run();
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    console.log(serialized);
    if (options.reportPath !== undefined) {
      await writeFile(options.reportPath, serialized, 'utf8');
      console.error(`Phase 16 report written to ${options.reportPath}`);
    }
    if (report.scenarios.some(({ walletLedgerAudit }) => walletLedgerAudit.mismatchedWallets > 0)) {
      throw new Error('Phase 16 found a wallet/ledger invariant mismatch.');
    }
  } finally {
    await runner.stop();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
