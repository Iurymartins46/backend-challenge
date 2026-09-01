import 'reflect-metadata';

import { StandardSchemaValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import type { AppConfig } from './config/configuration';
import { ErrorItemDto, ErrorResponseDto } from './common/http/error.dto';
import { MoneyDto } from './common/http/money.dto';
import { correlationMiddleware } from './infrastructure/logging/correlation.middleware';
import { httpTracingMiddleware, shutdownTelemetry } from './infrastructure/telemetry';
import { HealthResponseDto } from './modules/health/health.dto';
import {
  CreateWalletDto,
  WalletLedgerEntryDto,
  WalletLedgerResponseDto,
  WalletResponseDto,
} from './modules/wallet/presentation/wallet.dto';

export async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    bufferLogs: true,
  });
  const logger = app.get(Logger);
  app.useLogger(logger);
  app.use(httpTracingMiddleware);
  app.use(correlationMiddleware);

  app.useGlobalPipes(new StandardSchemaValidationPipe({ transform: true }));

  const config = app.get(ConfigService<AppConfig, true>);
  if (config.get('swagger.enabled', { infer: true })) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Distributed Wagering Processor')
      .setDescription('HTTP contract for the distributed wagering processor.')
      .setVersion(
        config.get('app.environment', { infer: true }) === 'production' ? '0.1.0' : '0.1.0-dev',
      )
      .addTag('health')
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig, {
      extraModels: [
        ErrorResponseDto,
        ErrorItemDto,
        MoneyDto,
        HealthResponseDto,
        CreateWalletDto,
        WalletResponseDto,
        WalletLedgerEntryDto,
        WalletLedgerResponseDto,
      ],
    });
    SwaggerModule.setup('docs', app, document, {
      jsonDocumentUrl: 'docs-json',
    });
  }

  const port = config.get('app.port', { infer: true });
  const host = config.get('app.host', { infer: true });
  await app.listen(port, host);
  logger.log(`HTTP server listening on ${host}:${port}`, 'Bootstrap');

  let shutdownStarted = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shutdownStarted) {
      return;
    }

    shutdownStarted = true;
    logger.log(`Received ${signal}; shutting down`, 'Bootstrap');

    try {
      await app.close();
    } finally {
      await shutdownTelemetry();
    }
  };
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
}
