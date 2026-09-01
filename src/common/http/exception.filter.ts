import type { ArgumentsHost } from '@nestjs/common';
import { Catch, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { BaseExceptionFilter, HttpAdapterHost } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { PinoLogger } from 'nestjs-pino';

import { activeTraceContext } from '../../infrastructure/telemetry';
import { requestCorrelationId } from '../../infrastructure/logging/correlation.middleware';
import { DomainError } from '../../modules/wagering/domain/errors';
import { ErrorCode } from './error-codes';
import type { ErrorItemDto } from './error.dto';
import type { ErrorResponseDto } from './error.dto';

interface ExceptionPayload {
  statusCode?: number;
  message?: string | string[];
  error?: string;
  errors?: Array<Partial<ErrorItemDto>>;
}

interface HttpErrorLike {
  code?: unknown;
  status?: unknown;
  statusCode?: unknown;
  type?: unknown;
}

const titles: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: 'Invalid request',
  [HttpStatus.UNAUTHORIZED]: 'Unauthorized',
  [HttpStatus.FORBIDDEN]: 'Forbidden',
  [HttpStatus.NOT_FOUND]: 'Resource not found',
  [HttpStatus.CONFLICT]: 'Conflict',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'Transaction rejected',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'Dependency unavailable',
};

function statusTitle(status: number): string {
  return titles[status] ?? (status >= 500 ? 'Internal server error' : 'Request failed');
}

function errorCode(status: number): string {
  if (status === 404) {
    return ErrorCode.RequestNotFound;
  }

  if (status === 409) {
    return ErrorCode.RequestConflict;
  }

  if (status === 503) {
    return ErrorCode.InfrastructureDependencyUnavailable;
  }

  if (status >= 500) {
    return ErrorCode.InfrastructureInternalError;
  }

  return ErrorCode.RequestInvalid;
}

function domainErrorStatus(code: DomainError['code']): number {
  if (code === ErrorCode.WalletNotFound) {
    return HttpStatus.NOT_FOUND;
  }

  if (code === ErrorCode.WalletAlreadyExists) {
    return HttpStatus.CONFLICT;
  }

  if (code === ErrorCode.MoneyCurrencyMismatch || code.startsWith('error.wager.')) {
    return HttpStatus.UNPROCESSABLE_ENTITY;
  }

  if (code === ErrorCode.InfrastructureDependencyUnavailable) {
    return HttpStatus.SERVICE_UNAVAILABLE;
  }

  if (code === ErrorCode.InfrastructureInternalError) {
    return HttpStatus.INTERNAL_SERVER_ERROR;
  }

  return HttpStatus.BAD_REQUEST;
}

function isInvalidJsonMessage(message: string): boolean {
  return (
    message.startsWith('JSON Parse error') ||
    message === "Body is not valid JSON but content-type is set to 'application/json'"
  );
}

function payloadFrom(exception: unknown): { status: number; payload: ExceptionPayload } {
  if (exception instanceof HttpException) {
    const response = exception.getResponse();
    const payload =
      typeof response === 'string' ? { message: response } : (response as ExceptionPayload);
    const messages = Array.isArray(payload.message)
      ? payload.message
      : payload.message
        ? [payload.message]
        : [];

    if (exception.getStatus() === 400 && messages.some(isInvalidJsonMessage)) {
      return {
        status: HttpStatus.BAD_REQUEST,
        payload: {
          message: 'Request body must contain valid JSON.',
          errors: [
            {
              code: ErrorCode.RequestInvalidJson,
              detail: 'Request body must contain valid JSON.',
            },
          ],
        },
      };
    }

    return {
      status: exception.getStatus(),
      payload,
    };
  }

  if (exception instanceof DomainError) {
    return {
      status: domainErrorStatus(exception.code),
      payload: {
        message: exception.message,
        errors: [{ code: exception.code, detail: exception.message }],
      },
    };
  }

  if (exception instanceof Error) {
    const httpError = exception as Error & HttpErrorLike;
    const candidateStatus = httpError.status ?? httpError.statusCode;

    if (
      typeof candidateStatus === 'number' &&
      Number.isInteger(candidateStatus) &&
      candidateStatus >= 400 &&
      candidateStatus <= 599
    ) {
      if (
        candidateStatus === 400 &&
        (httpError.type === 'entity.parse.failed' ||
          httpError.code === 'FST_ERR_CTP_INVALID_JSON_BODY')
      ) {
        return {
          status: HttpStatus.BAD_REQUEST,
          payload: {
            message: 'Request body must contain valid JSON.',
            errors: [
              {
                code: ErrorCode.RequestInvalidJson,
                detail: 'Request body must contain valid JSON.',
              },
            ],
          },
        };
      }

      return {
        status: candidateStatus,
        payload: {},
      };
    }
  }

  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    payload: {},
  };
}

export function formatExceptionResponse(exception: unknown, traceId: string): ErrorResponseDto {
  const { status, payload } = payloadFrom(exception);
  const configuredErrors = payload.errors?.filter(
    (item): item is Partial<ErrorItemDto> & Pick<ErrorItemDto, 'code' | 'detail'> =>
      typeof item.code === 'string' && typeof item.detail === 'string',
  );
  const messages = Array.isArray(payload.message)
    ? payload.message
    : payload.message
      ? [payload.message]
      : [];
  const errors: ErrorItemDto[] =
    configuredErrors && configuredErrors.length > 0
      ? configuredErrors.map((item) => ({
          code: item.code,
          detail: item.detail,
          field: item.field,
        }))
      : (messages.length > 0 ? messages : ['The request could not be processed.']).map(
          (message) => ({
            code: errorCode(status),
            detail: message,
          }),
        );

  return {
    status,
    title: statusTitle(status),
    detail:
      status >= 500
        ? 'The operation could not be completed at this time.'
        : (errors[0]?.detail ?? 'Request failed.'),
    traceId,
    errors,
  };
}

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
