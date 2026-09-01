import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';

import { GlobalExceptionFilter } from './common/http/exception.filter';
import { configuration } from './config/configuration';
import { validateEnvironment } from './config/environment';
import { AuthModule } from './modules/auth/auth.module';
import { HealthModule } from './modules/health/health.module';
import { DatabaseModule } from './infrastructure/database/database.module';
import { AppLoggingModule } from './infrastructure/logging/logging.module';
import { SqsModule } from './infrastructure/messaging/sqs.module';
import { ProviderAuthGuard } from './modules/auth/provider-auth.guard';
import { WalletModule } from './modules/wallet/wallet.module';
import { WageringModule } from './modules/wagering/wagering.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnvironment,
      load: [configuration],
    }),
    AppLoggingModule,
    DatabaseModule,
    SqsModule,
    AuthModule,
    HealthModule,
    WalletModule,
    WageringModule,
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
    {
      provide: APP_GUARD,
      useClass: ProviderAuthGuard,
    },
  ],
})
export class AppModule {}
