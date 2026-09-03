import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, test } from 'bun:test';

import { formatExceptionResponse } from '../../src/common/http/exception-response';
import { exceptionLogContext } from '../../src/common/http/exception-log-context';
import {
  DomainInvariantError,
  InboxPayloadConflictError,
} from '../../src/modules/wagering/domain/errors';

describe('global error contract', () => {
  test('always returns a non-empty errors array', () => {
    const response = formatExceptionResponse(
      new BadRequestException(['invalid amount', 'invalid currency']),
      'trace-1',
    );

    expect(response.status).toBe(400);
    expect(response.traceId).toBe('trace-1');
    expect(response.errors).toHaveLength(2);
    expect(response.errors.every((item) => item.code === 'error.request.invalid_request')).toBe(
      true,
    );
  });

  test('maps not found to a stable machine code', () => {
    const response = formatExceptionResponse(new NotFoundException('Wallet not found'), 'trace-2');

    expect(response.status).toBe(404);
    expect(response.errors).toEqual([
      {
        code: 'error.request.not_found',
        detail: 'Wallet not found',
      },
    ]);
  });

  test('maps malformed JSON without exposing the parser error', () => {
    const parserError = Object.assign(new SyntaxError('Unexpected token with request content'), {
      status: 400,
      type: 'entity.parse.failed',
    });

    const response = formatExceptionResponse(parserError, 'trace-3');

    expect(response).toEqual({
      status: 400,
      title: 'Invalid request',
      detail: 'Request body must contain valid JSON.',
      traceId: 'trace-3',
      errors: [
        {
          code: 'error.request.invalid_json',
          detail: 'Request body must contain valid JSON.',
        },
      ],
    });
  });

  test('maps the Bun/Nest malformed JSON exception shape', () => {
    const response = formatExceptionResponse(
      new BadRequestException("JSON Parse error: Expected '}'"),
      'trace-4',
    );

    expect(response.errors).toEqual([
      {
        code: 'error.request.invalid_json',
        detail: 'Request body must contain valid JSON.',
      },
    ]);
    expect(response.detail).toBe('Request body must contain valid JSON.');
  });

  test('maps the Fastify malformed JSON exception shape', () => {
    const parserError = Object.assign(new SyntaxError('Unexpected token'), {
      statusCode: 400,
      code: 'FST_ERR_CTP_INVALID_JSON_BODY',
    });

    const response = formatExceptionResponse(parserError, 'trace-5');

    expect(response.errors).toEqual([
      {
        code: 'error.request.invalid_json',
        detail: 'Request body must contain valid JSON.',
      },
    ]);
  });

  test('maps the Nest Fastify wrapped malformed JSON exception', () => {
    const response = formatExceptionResponse(
      new BadRequestException(
        "Body is not valid JSON but content-type is set to 'application/json'",
      ),
      'trace-6',
    );

    expect(response.errors).toEqual([
      {
        code: 'error.request.invalid_json',
        detail: 'Request body must contain valid JSON.',
      },
    ]);
  });

  test('does not expose invariant details or undocumented domain codes', () => {
    const response = formatExceptionResponse(
      new DomainInvariantError('SQL statement and money details must stay private.'),
      'trace-7',
    );

    expect(response).toMatchObject({
      status: 500,
      detail: 'The operation could not be completed at this time.',
      errors: [{ code: 'error.infrastructure.internal_error' }],
    });
    expect(JSON.stringify(response)).not.toContain('SQL statement');
  });

  test('maps inbox payload conflicts to a documented public conflict', () => {
    const response = formatExceptionResponse(new InboxPayloadConflictError(), 'trace-8');

    expect(response).toMatchObject({
      status: 409,
      errors: [{ code: 'error.idempotency.payload_conflict' }],
    });
  });

  test('sanitizes persistence exceptions before structured logging', () => {
    const persistenceError = Object.assign(new Error('database failure'), {
      name: 'QueryFailedError',
      code: '23505',
      query: 'INSERT INTO wallets (balance_minor) VALUES ($1)',
      parameters: ['2500'],
      driverError: { detail: 'sensitive database detail' },
    });

    const context = exceptionLogContext(persistenceError);
    expect(context).toEqual({ type: 'QueryFailedError', code: '23505' });
    expect(JSON.stringify(context)).not.toContain('2500');
    expect(JSON.stringify(context)).not.toContain('INSERT INTO');
  });
});
