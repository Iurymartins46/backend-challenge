import { describe, expect, test } from 'bun:test';

import type { ConfigService } from '@nestjs/config';
import type { SQSClient } from '@aws-sdk/client-sqs';

import type { AppConfig } from '../../src/config/configuration';
import type { DatabaseHealthCheck } from '../../src/infrastructure/database/database-health.check';
import { HealthService } from '../../src/modules/health/health.service';

function healthService(
  options: {
    query?: () => Promise<unknown>;
    send?: (...args: unknown[]) => Promise<unknown>;
    timeoutMs?: number;
  } = {},
): HealthService {
  const databaseHealthCheck = {
    check: options.query ?? (() => Promise.resolve([{ '?column?': 1 }])),
  } as unknown as DatabaseHealthCheck;
  const sqsClient = {
    send: options.send ?? (() => Promise.resolve({ QueueUrl: 'http://sqs/queue' })),
  } as unknown as SQSClient;
  const config = {
    get(path: string): unknown {
      if (path === 'messaging.commandQueueName') {
        return 'wager-transactions.fifo';
      }
      if (path === 'messaging.eventsQueueName') {
        return 'wager-events.fifo';
      }
      if (path === 'health.timeoutMs') {
        return options.timeoutMs ?? 20;
      }
      throw new Error(`Unexpected config path: ${path}`);
    },
  } as unknown as ConfigService<AppConfig, true>;

  return new HealthService(databaseHealthCheck, sqsClient, config);
}

describe('health checks', () => {
  test('reports PostgreSQL and SQS readiness while keeping liveness independent', async () => {
    const service = healthService();

    expect(service.live()).toEqual({ status: 'ok', check: 'live' });
    expect(await service.ready()).toEqual({
      status: 'ok',
      check: 'ready',
      details: {
        postgres: { status: 'up' },
        sqs: { status: 'up' },
      },
    });
  });

  test('checks both command and event queues and aborts an overdue SQS probe', async () => {
    const calls: Array<{ queueName: string | undefined; aborted: boolean | undefined }> = [];
    const service = healthService({
      timeoutMs: 5,
      send: (command: unknown, options: unknown) => {
        const queueName = (command as { input?: { QueueName?: string } }).input?.QueueName;
        const signal = (options as { abortSignal?: AbortSignal }).abortSignal;
        calls.push({ queueName, aborted: signal?.aborted });
        return new Promise((_, reject) =>
          signal?.addEventListener('abort', () => reject(new Error('aborted'))),
        );
      },
    });

    expect(await service.ready()).toMatchObject({
      status: 'error',
      details: { postgres: { status: 'up' }, sqs: { status: 'down' } },
    });
    expect(calls.map((call) => call.queueName)).toEqual([
      'wager-transactions.fifo',
      'wager-events.fifo',
    ]);
  });

  test('returns a failed readiness result after the dependency deadline', async () => {
    const service = healthService({
      timeoutMs: 5,
      query: () => new Promise(() => {}),
    });

    expect(await service.ready()).toMatchObject({
      status: 'error',
      check: 'ready',
      details: {
        postgres: { status: 'down' },
        sqs: { status: 'up' },
      },
    });
    expect(service.live()).toEqual({ status: 'ok', check: 'live' });
  });

  test('does not report readiness during shutdown', async () => {
    const service = healthService();
    service.markShuttingDown();

    expect(await service.ready()).toMatchObject({
      status: 'error',
      check: 'ready',
      details: {
        postgres: { status: 'down' },
        sqs: { status: 'down' },
      },
    });
  });
});
