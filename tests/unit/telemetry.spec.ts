import { describe, expect, test } from 'bun:test';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

import { httpTracingMiddleware } from '../../src/infrastructure/telemetry';

describe('HTTP telemetry', () => {
  test('captures a basic HTTP span with the in-memory exporter', () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const tracer = provider.getTracer('telemetry-test');

    let finish: (() => void) | undefined;
    let nextCalled = false;

    httpTracingMiddleware(
      { method: 'GET', url: '/health/live' },
      {
        statusCode: 200,
        once: (_event, listener) => {
          finish = listener;
        },
      },
      () => {
        nextCalled = true;
      },
      tracer,
    );

    finish?.();

    expect(nextCalled).toBe(true);
    expect(exporter.getFinishedSpans()).toHaveLength(1);
    expect(exporter.getFinishedSpans()[0]?.name).toBe('GET /health/live');
  });
});
