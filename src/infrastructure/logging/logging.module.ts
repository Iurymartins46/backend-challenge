import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import type { IncomingMessage } from 'node:http';

import type { AppConfig } from '../../config/configuration';
import { activeTraceContext } from '../telemetry';
import { activeCorrelationId, normalizeCorrelationId } from './correlation.middleware';
import { LOG_REDACT_PATHS } from './redaction';

export { LOG_REDACT_PATHS } from './redaction';

@Module({
  imports: [
    LoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => ({
        pinoHttp: {
          level: config.get('logging.level', { infer: true }) ?? 'info',
          genReqId: (request: IncomingMessage) => {
            const correlationId = normalizeCorrelationId(request.headers['x-correlation-id']);
            request.headers['x-correlation-id'] = correlationId;
            return correlationId;
          },
          customProps: (request: IncomingMessage) => {
            const traceContext = activeTraceContext();
            const header = request.headers['x-correlation-id'];
            return {
              correlationId: activeCorrelationId() ?? (Array.isArray(header) ? header[0] : header),
              traceId: traceContext.traceId,
              spanId: traceContext.spanId,
            };
          },
          redact: {
            paths: [...LOG_REDACT_PATHS],
            remove: true,
          },
        },
      }),
    }),
  ],
  exports: [LoggerModule],
})
export class AppLoggingModule {}
