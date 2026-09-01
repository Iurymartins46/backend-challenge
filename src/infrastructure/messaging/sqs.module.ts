import { SQSClient } from '@aws-sdk/client-sqs';
import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import type { AppConfig } from '../../config/configuration';

export const SQS_CLIENT = Symbol('SQS_CLIENT');

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
  ],
  exports: [SQS_CLIENT],
})
export class SqsModule {}
