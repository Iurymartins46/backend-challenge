import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { activeTraceContext } from '../telemetry';

const correlationHeader = 'x-correlation-id';
const correlationStorage = new AsyncLocalStorage<{ correlationId: string }>();

export function normalizeCorrelationId(value: string | string[] | undefined): string {
  const candidate = (Array.isArray(value) ? value[0] : value)?.trim();
  return candidate && candidate.length <= 128 ? candidate : randomUUID();
}

export function correlationMiddleware(
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void,
): void {
  const correlationId = normalizeCorrelationId(request.headers[correlationHeader]);

  request.headers[correlationHeader] = correlationId;
  response.setHeader(correlationHeader, correlationId);

  const traceContext = activeTraceContext();
  response.setHeader('x-trace-id', traceContext.traceId ?? correlationId);
  correlationStorage.run({ correlationId }, next);
}

export function requestCorrelationId(request: { headers: IncomingMessage['headers'] }): string {
  const header = request.headers[correlationHeader];
  return (
    correlationStorage.getStore()?.correlationId ??
    (Array.isArray(header) ? header[0] : header) ??
    'unknown'
  );
}

export function activeCorrelationId(): string | undefined {
  return correlationStorage.getStore()?.correlationId;
}
