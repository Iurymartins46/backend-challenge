import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';

import type { AppConfig } from '../../config/configuration';
import { DatabaseHealthCheck } from '../../infrastructure/database/database-health.check';
import { SQS_CLIENT } from '../../infrastructure/messaging/sqs.module';
import type { HealthResponseDto, HealthDependencyDto } from './health.dto';

@Injectable()
export class HealthService implements OnApplicationShutdown {
  private shuttingDown = false;

  constructor(
    private readonly databaseHealthCheck: DatabaseHealthCheck,
    @Inject(SQS_CLIENT) private readonly sqsClient: SQSClient,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  live(): HealthResponseDto {
    return { status: 'ok', check: 'live' };
  }

  async ready(): Promise<HealthResponseDto> {
    if (this.shuttingDown) {
      return this.unavailable();
    }

    return this.checkDependencies();
  }

  markShuttingDown(): void {
    this.shuttingDown = true;
  }

  onApplicationShutdown(): void {
    this.markShuttingDown();
  }

  private async checkDependencies(): Promise<HealthResponseDto> {
    const [postgres, sqs] = await Promise.all([
      this.probe(() => this.checkPostgres()),
      this.probe((signal) => this.checkSqs(signal)),
    ]);
    const ready = postgres.status === 'up' && sqs.status === 'up';

    return {
      status: ready ? 'ok' : 'error',
      check: 'ready',
      details: { postgres, sqs },
    };
  }

  private async checkPostgres(): Promise<void> {
    await this.databaseHealthCheck.check();
  }

  private async checkSqs(signal: AbortSignal): Promise<void> {
    const queueNames = [
      this.config.get('messaging.commandQueueName', { infer: true }),
      this.config.get('messaging.eventsQueueName', { infer: true }),
    ];
    await Promise.all(
      queueNames.map((QueueName) =>
        this.sqsClient.send(new GetQueueUrlCommand({ QueueName }), { abortSignal: signal }),
      ),
    );
  }

  private async probe(check: (signal: AbortSignal) => Promise<void>): Promise<HealthDependencyDto> {
    const controller = new AbortController();
    try {
      await withTimeout(
        check(controller.signal),
        this.config.get('health.timeoutMs', { infer: true }),
        controller,
      );
      return { status: 'up' };
    } catch {
      return { status: 'down' };
    }
  }

  private unavailable(): HealthResponseDto {
    return {
      status: 'error',
      check: 'ready',
      details: {
        postgres: { status: 'down' },
        sqs: { status: 'down' },
      },
    };
  }
}

function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  controller: AbortController,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Health check deadline exceeded.'));
    }, timeoutMs);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error('Health check failed.'));
      },
    );
  });
}
