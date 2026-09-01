import type { ArgumentsHost } from '@nestjs/common';
import { Catch, Injectable } from '@nestjs/common';
import { BaseExceptionFilter, HttpAdapterHost } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { PinoLogger } from 'nestjs-pino';

import { formatExceptionResponse } from './exception-response';
import { activeTraceContext } from '../../infrastructure/telemetry';
import { requestCorrelationId } from '../../infrastructure/logging/correlation.middleware';
export { formatExceptionResponse } from './exception-response';

@Catch()
@Injectable()
export class GlobalExceptionFilter extends BaseExceptionFilter {
  constructor(
    adapterHost: HttpAdapterHost,
    private readonly logger: PinoLogger,
  ) {
    super(adapterHost.httpAdapter);
  }

  override catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const response = http.getResponse<FastifyReply>();
    const traceId = activeTraceContext().traceId ?? requestCorrelationId(request);
    const body = formatExceptionResponse(exception, traceId);

    if (body.status === 503) {
      response.header('retry-after', '2');
    }

    if (body.status >= 500) {
      this.logger.error(
        {
          err: exception,
          status: body.status,
          traceId,
          path: request.url,
          method: request.method,
        },
        'Unhandled HTTP exception',
      );
    }

    void response.status(body.status).send(body);
  }
}
