import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { DatabaseModule } from '../../infrastructure/database/database.module';
import type { AppConfig } from '../../config/configuration';
import {
  SqsCommandConsumer,
  testOnlyTerminateAfterCommitBeforeAck,
  type SqsCommandConsumerOptions,
} from '../../infrastructure/messaging/sqs-command.consumer';
import { SqsConsumerMetrics } from '../../infrastructure/messaging/sqs-consumer.metrics';
import { SqsDlqMetricsMonitor } from '../../infrastructure/messaging/sqs-dlq-metrics.monitor';
import { SqsWagerCommandHandler } from '../../infrastructure/messaging/sqs-command-handler';
import {
  OutboxPublisher,
  type OutboxPublisherOptions,
} from '../../infrastructure/messaging/outbox.publisher';
import { OutboxPublisherMetrics } from '../../infrastructure/messaging/outbox-publisher.metrics';
import {
  PendingReferenceWorker,
  type PendingReferenceWorkerOptions,
} from '../../infrastructure/messaging/pending-reference.worker';
import { PendingReferenceWorkerMetrics } from '../../infrastructure/messaging/pending-reference-worker.metrics';
import { SQS_QUEUE_PORT } from '../../infrastructure/messaging/sqs.module';
import type { SqsQueuePort } from '../../infrastructure/messaging/sqs-queue.port';
import { SqsModule } from '../../infrastructure/messaging/sqs.module';
import { GetWagerTransactionUseCase, ProcessWagerTransactionUseCase } from './application';
import { FINANCIAL_UNIT_OF_WORK, type FinancialUnitOfWorkPort } from './application/ports';
import { RandomIdGenerator, SystemClock, type Clock, type IdGenerator } from './domain';
import { ExponentialRetryPolicy } from './domain/retry-policy';
import { WageringController } from './wagering.controller';

const WAGER_ID_GENERATOR = Symbol('WAGER_ID_GENERATOR');
const WAGER_CLOCK = Symbol('WAGER_CLOCK');
const OUTBOX_ID_GENERATOR = Symbol('OUTBOX_ID_GENERATOR');
const OUTBOX_CLOCK = Symbol('OUTBOX_CLOCK');
const PENDING_REFERENCE_ID_GENERATOR = Symbol('PENDING_REFERENCE_ID_GENERATOR');
const PENDING_REFERENCE_CLOCK = Symbol('PENDING_REFERENCE_CLOCK');
export const SQS_COMMAND_CONSUMER_OPTIONS = Symbol('SQS_COMMAND_CONSUMER_OPTIONS');
export const SQS_CONSUMER_METRICS = Symbol('SQS_CONSUMER_METRICS');
export const SQS_OUTBOX_PUBLISHER_OPTIONS = Symbol('SQS_OUTBOX_PUBLISHER_OPTIONS');
export const SQS_OUTBOX_PUBLISHER_METRICS = Symbol('SQS_OUTBOX_PUBLISHER_METRICS');
export const PENDING_REFERENCE_WORKER_OPTIONS = Symbol('PENDING_REFERENCE_WORKER_OPTIONS');
export const PENDING_REFERENCE_WORKER_METRICS = Symbol('PENDING_REFERENCE_WORKER_METRICS');

@Module({
  imports: [ConfigModule, DatabaseModule, SqsModule],
  controllers: [WageringController],
  providers: [
    {
      provide: WAGER_ID_GENERATOR,
      useFactory: (): IdGenerator => new RandomIdGenerator(),
    },
    {
      provide: WAGER_CLOCK,
      useFactory: (): Clock => new SystemClock(),
    },
    {
      provide: OUTBOX_ID_GENERATOR,
      useFactory: (): IdGenerator => new RandomIdGenerator(),
    },
    {
      provide: OUTBOX_CLOCK,
      useFactory: (): Clock => new SystemClock(),
    },
    {
      provide: PENDING_REFERENCE_ID_GENERATOR,
      useFactory: (): IdGenerator => new RandomIdGenerator(),
    },
    {
      provide: PENDING_REFERENCE_CLOCK,
      useFactory: (): Clock => new SystemClock(),
    },
    {
      provide: ProcessWagerTransactionUseCase,
      inject: [FINANCIAL_UNIT_OF_WORK, WAGER_ID_GENERATOR, WAGER_CLOCK],
      useFactory: (unitOfWork: FinancialUnitOfWorkPort, idGenerator: IdGenerator, clock: Clock) =>
        new ProcessWagerTransactionUseCase(unitOfWork, idGenerator, clock),
    },
    {
      provide: GetWagerTransactionUseCase,
      inject: [FINANCIAL_UNIT_OF_WORK],
      useFactory: (unitOfWork: FinancialUnitOfWorkPort) =>
        new GetWagerTransactionUseCase(unitOfWork),
    },
    {
      provide: SQS_COMMAND_CONSUMER_OPTIONS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>): SqsCommandConsumerOptions => ({
        enabled: config.get('messaging.consumerEnabled', { infer: true }),
        queueName: config.get('messaging.commandQueueName', { infer: true }),
        consumerName: config.get('messaging.consumerName', { infer: true }),
        concurrency: config.get('messaging.consumerConcurrency', { infer: true }),
        waitTimeSeconds: config.get('messaging.waitTimeSeconds', { infer: true }),
        visibilityTimeoutSeconds: config.get('messaging.visibilityTimeoutSeconds', { infer: true }),
        visibilityHeartbeatSeconds: config.get('messaging.visibilityHeartbeatSeconds', {
          infer: true,
        }),
        shutdownTimeoutMs: config.get('messaging.shutdownTimeoutMs', { infer: true }),
      }),
    },
    {
      provide: SQS_CONSUMER_METRICS,
      useFactory: (): SqsConsumerMetrics => new SqsConsumerMetrics(),
    },
    {
      provide: SqsDlqMetricsMonitor,
      inject: [SQS_QUEUE_PORT, SQS_CONSUMER_METRICS, ConfigService],
      useFactory: (
        queue: SqsQueuePort,
        metrics: SqsConsumerMetrics,
        config: ConfigService<AppConfig, true>,
      ) =>
        new SqsDlqMetricsMonitor(queue, metrics, {
          enabled: config.get('messaging.consumerEnabled', { infer: true }),
          queueName: config.get('messaging.commandDlqName', { infer: true }),
          refreshIntervalMs: 5_000,
        }),
    },
    {
      provide: SQS_OUTBOX_PUBLISHER_OPTIONS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>): OutboxPublisherOptions => ({
        enabled: config.get('messaging.outbox.enabled', { infer: true }),
        eventsQueueName: config.get('messaging.eventsQueueName', { infer: true }),
        batchSize: config.get('messaging.outbox.batchSize', { infer: true }),
        pollIntervalMs: config.get('messaging.outbox.pollIntervalMs', { infer: true }),
        leaseDurationMs: config.get('messaging.outbox.leaseDurationMs', { infer: true }),
        shutdownTimeoutMs: config.get('messaging.outbox.shutdownTimeoutMs', { infer: true }),
        retryPolicy: new ExponentialRetryPolicy({
          maxAttempts: config.get('messaging.outbox.maxAttempts', { infer: true }),
          baseDelayMs: config.get('messaging.outbox.retryBaseDelayMs', { infer: true }),
          maxDelayMs: config.get('messaging.outbox.retryMaxDelayMs', { infer: true }),
          jitterRatio: config.get('messaging.outbox.retryJitterRatio', { infer: true }),
        }),
      }),
    },
    {
      provide: SQS_OUTBOX_PUBLISHER_METRICS,
      useFactory: (): OutboxPublisherMetrics => new OutboxPublisherMetrics(),
    },
    {
      provide: PENDING_REFERENCE_WORKER_OPTIONS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>): PendingReferenceWorkerOptions => ({
        enabled: config.get('messaging.pendingReference.enabled', { infer: true }),
        batchSize: config.get('messaging.pendingReference.batchSize', { infer: true }),
        pollIntervalMs: config.get('messaging.pendingReference.pollIntervalMs', { infer: true }),
        leaseDurationMs: config.get('messaging.pendingReference.leaseDurationMs', { infer: true }),
        shutdownTimeoutMs: config.get('messaging.pendingReference.shutdownTimeoutMs', {
          infer: true,
        }),
        maxAttempts: config.get('messaging.pendingReference.maxAttempts', { infer: true }),
        ttlMs: config.get('messaging.pendingReference.ttlMs', { infer: true }),
        retryPolicy: new ExponentialRetryPolicy({
          maxAttempts: config.get('messaging.pendingReference.maxAttempts', { infer: true }),
          baseDelayMs: config.get('messaging.pendingReference.retryBaseDelayMs', { infer: true }),
          maxDelayMs: config.get('messaging.pendingReference.retryMaxDelayMs', { infer: true }),
          jitterRatio: config.get('messaging.pendingReference.retryJitterRatio', {
            infer: true,
          }),
        }),
      }),
    },
    {
      provide: PENDING_REFERENCE_WORKER_METRICS,
      useFactory: (): PendingReferenceWorkerMetrics => new PendingReferenceWorkerMetrics(),
    },
    {
      provide: SqsWagerCommandHandler,
      inject: [ProcessWagerTransactionUseCase, SQS_COMMAND_CONSUMER_OPTIONS, WAGER_CLOCK],
      useFactory: (
        processor: ProcessWagerTransactionUseCase,
        options: SqsCommandConsumerOptions,
        clock: Clock,
      ) => new SqsWagerCommandHandler(processor, options.consumerName, clock),
    },
    {
      provide: SqsCommandConsumer,
      inject: [
        SQS_QUEUE_PORT,
        SqsWagerCommandHandler,
        SQS_COMMAND_CONSUMER_OPTIONS,
        SQS_CONSUMER_METRICS,
      ],
      useFactory: (
        queue: SqsQueuePort,
        handler: SqsWagerCommandHandler,
        options: SqsCommandConsumerOptions,
        metrics: SqsConsumerMetrics,
      ) =>
        new SqsCommandConsumer(
          queue,
          handler,
          options,
          metrics,
          testOnlyTerminateAfterCommitBeforeAck(),
        ),
    },
    {
      provide: OutboxPublisher,
      inject: [
        SQS_QUEUE_PORT,
        FINANCIAL_UNIT_OF_WORK,
        OUTBOX_CLOCK,
        OUTBOX_ID_GENERATOR,
        SQS_OUTBOX_PUBLISHER_OPTIONS,
        SQS_OUTBOX_PUBLISHER_METRICS,
      ],
      useFactory: (
        queue: SqsQueuePort,
        unitOfWork: FinancialUnitOfWorkPort,
        clock: Clock,
        idGenerator: IdGenerator,
        options: OutboxPublisherOptions,
        metrics: OutboxPublisherMetrics,
      ) => new OutboxPublisher(queue, unitOfWork, clock, idGenerator, options, metrics),
    },
    {
      provide: PendingReferenceWorker,
      inject: [
        ProcessWagerTransactionUseCase,
        FINANCIAL_UNIT_OF_WORK,
        PENDING_REFERENCE_CLOCK,
        PENDING_REFERENCE_ID_GENERATOR,
        PENDING_REFERENCE_WORKER_OPTIONS,
        PENDING_REFERENCE_WORKER_METRICS,
      ],
      useFactory: (
        processor: ProcessWagerTransactionUseCase,
        unitOfWork: FinancialUnitOfWorkPort,
        clock: Clock,
        idGenerator: IdGenerator,
        options: PendingReferenceWorkerOptions,
        metrics: PendingReferenceWorkerMetrics,
      ) => new PendingReferenceWorker(processor, unitOfWork, clock, idGenerator, options, metrics),
    },
  ],
})
export class WageringModule {}
