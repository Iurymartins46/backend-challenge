import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import type { AppConfig } from '../../config/configuration';
import { FINANCIAL_UNIT_OF_WORK } from '../../modules/wagering/application/ports';
import { FinancialUnitOfWork } from './financial-unit-of-work';
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
  providers: [
    {
      provide: FINANCIAL_UNIT_OF_WORK,
      inject: [DataSource],
      useFactory: (dataSource: DataSource) =>
        FinancialUnitOfWork.fromEntityManager(dataSource.manager),
    },
  ],
  exports: [FINANCIAL_UNIT_OF_WORK],
})
export class DatabaseModule {}
