import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import type { AppConfig } from '../../config/configuration';
import { entities } from './entities/registry';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => ({
        type: 'postgres' as const,
        url: config.get('database.url', { infer: true }),
        entities,
        autoLoadEntities: false,
        synchronize: false,
        migrationsRun: false,
        extra: {
          options: `-c lock_timeout=${config.get('database.lockTimeoutMs', { infer: true })} -c statement_timeout=${config.get('database.statementTimeoutMs', { infer: true })}`,
        },
      }),
    }),
  ],
})
export class DatabaseModule {}
