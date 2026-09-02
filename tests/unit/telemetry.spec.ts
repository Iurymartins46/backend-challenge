import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ConfigModule } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Module } from '@nestjs/common';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

import {
  httpTracingMiddleware,
  shutdownTelemetry,
  startTelemetry,
} from '../../src/infrastructure/telemetry';
import { getTelemetryMetrics } from '../../src/infrastructure/telemetry/metrics';
import { MetricsModule } from '../../src/modules/metrics/metrics.module';

let app: NestFastifyApplication | undefined;

@Module({
  imports: [ConfigModule, MetricsModule],
})
class MetricsTestModule {}

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

  describe('Prometheus endpoint', () => {
    beforeAll(async () => {
      await startTelemetry({
        enabled: false,
        serviceName: 'telemetry-test',
        serviceVersion: 'test',
        environment: 'test',
        exporterEndpoint: 'http://127.0.0.1:1',
      });
      getTelemetryMetrics().increment('wagering.test.counter', 1, { status: 'ok' });
      const module = await Test.createTestingModule({ imports: [MetricsTestModule] }).compile();
      app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
    });

    afterAll(async () => {
      await app?.close();
      await shutdownTelemetry();
      app = undefined;
    });

    test('exposes OTel metrics without high-cardinality identifiers as labels', async () => {
      if (app === undefined) {
        throw new Error('The metrics application was not initialized.');
      }

      const response = await app.inject({ method: 'GET', url: '/metrics' });
      const body = response.body;

      expect(response.statusCode).toBe(200);
      expect(body).toContain('wagering_test_counter_total{status="ok"} 1');
      expect(body).not.toContain('transactionId');
      expect(body).not.toContain('walletId');
    });
  });
});
