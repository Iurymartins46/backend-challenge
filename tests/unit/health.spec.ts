import { describe, expect, test } from 'bun:test';

import type { ConfigService } from '@nestjs/config';
import type { SQSClient } from '@aws-sdk/client-sqs';

import type { AppConfig } from '../../src/config/configuration';
import type { DatabaseHealthCheck } from '../../src/infrastructure/database/database-health.check';
import { HealthService } from '../../src/modules/health/health.service';

function healthService(
  options: {
    query?: () => Promise<unknown>;
    send?: () => Promise<unknown>;
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
