import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { DatabaseModule } from '../../infrastructure/database/database.module';
import { SqsModule } from '../../infrastructure/messaging/sqs.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  imports: [ConfigModule, DatabaseModule, SqsModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
