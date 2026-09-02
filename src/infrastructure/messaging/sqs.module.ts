import { SQSClient } from '@aws-sdk/client-sqs';
import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import type { AppConfig } from '../../config/configuration';
import { AwsSqsQueueAdapter } from './aws-sqs-queue.adapter';

export const SQS_CLIENT = Symbol('SQS_CLIENT');
export const SQS_QUEUE_PORT = Symbol('SQS_QUEUE_PORT');

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: SQS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) =>
        new SQSClient({
          region: config.get('messaging.region', { infer: true }),
          endpoint: config.get('messaging.endpoint', { infer: true }),
          credentials: {
            accessKeyId: config.get('messaging.accessKeyId', { infer: true }),
            secretAccessKey: config.get('messaging.secretAccessKey', { infer: true }),
          },
        }),
    },
    {
      provide: SQS_QUEUE_PORT,
      inject: [SQS_CLIENT],
      useFactory: (client: SQSClient) => new AwsSqsQueueAdapter(client),
    },
  ],
  exports: [SQS_CLIENT, SQS_QUEUE_PORT],
})
export class SqsModule {}
