import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { DatabaseModule } from '../../infrastructure/database/database.module';
import type { AppConfig } from '../../config/configuration';
import {
  SqsCommandConsumer,
  type SqsCommandConsumerOptions,
} from '../../infrastructure/messaging/sqs-command.consumer';
import { SqsConsumerMetrics } from '../../infrastructure/messaging/sqs-consumer.metrics';
import { SqsWagerCommandHandler } from '../../infrastructure/messaging/sqs-command-handler';
import { SQS_QUEUE_PORT } from '../../infrastructure/messaging/sqs.module';
import type { SqsQueuePort } from '../../infrastructure/messaging/sqs-queue.port';
import { SqsModule } from '../../infrastructure/messaging/sqs.module';
import { GetWagerTransactionUseCase, ProcessWagerTransactionUseCase } from './application';
import { FINANCIAL_UNIT_OF_WORK, type FinancialUnitOfWorkPort } from './application/ports';
import { RandomIdGenerator, SystemClock, type Clock, type IdGenerator } from './domain';
import { WageringController } from './wagering.controller';

const WAGER_ID_GENERATOR = Symbol('WAGER_ID_GENERATOR');
const WAGER_CLOCK = Symbol('WAGER_CLOCK');
export const SQS_COMMAND_CONSUMER_OPTIONS = Symbol('SQS_COMMAND_CONSUMER_OPTIONS');
export const SQS_CONSUMER_METRICS = Symbol('SQS_CONSUMER_METRICS');

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
      ) => new SqsCommandConsumer(queue, handler, options, metrics),
    },
  ],
})
export class WageringModule {}
