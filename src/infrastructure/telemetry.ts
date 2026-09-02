import {
  context,
  propagation,
  SpanStatusCode,
  trace,
  type Attributes,
  type Tracer,
} from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import type { NodeSDKConfiguration } from '@opentelemetry/sdk-node';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { environmentFromProcess } from '../config/environment';

export interface TelemetryConfig {
  enabled: boolean;
  serviceName: string;
  serviceVersion: string;
  environment: string;
  exporterEndpoint: string;
}

let sdk: NodeSDK | undefined;
let prometheusExporter: PrometheusExporter | undefined;
let telemetryStarted = false;

propagation.setGlobalPropagator(new W3CTraceContextPropagator());

export function getTelemetryConfig(): TelemetryConfig {
  const env = environmentFromProcess();
  return {
    enabled: env.OTEL_ENABLED,
    serviceName: env.OTEL_SERVICE_NAME,
    serviceVersion: env.OTEL_SERVICE_VERSION,
    environment: env.NODE_ENV,
    exporterEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
  };
}

function traceEndpoint(endpoint: string): string {
  return endpoint.endsWith('/v1/traces') ? endpoint : `${endpoint.replace(/\/$/, '')}/v1/traces`;
}

export function startTelemetry(config = getTelemetryConfig()): Promise<void> {
  if (telemetryStarted) {
    return Promise.resolve();
  }

  try {
    const exporter = new PrometheusExporter({
      endpoint: '/metrics',
      preventServerStart: true,
      withoutScopeInfo: true,
      withoutTargetInfo: true,
    });
    const sdkConfig: Partial<NodeSDKConfiguration> = {
      resource: resourceFromAttributes({
        'service.name': config.serviceName,
        'service.version': config.serviceVersion,
        'deployment.environment': config.environment,
        'service.instance.id': process.env.HOSTNAME ?? 'local',
      }),
      metricReaders: [exporter],
      instrumentations: [],
    };
    if (config.enabled) {
      sdkConfig.traceExporter = new OTLPTraceExporter({
        url: traceEndpoint(config.exporterEndpoint),
      });
      sdkConfig.instrumentations = [
        new HttpInstrumentation({
          // Incoming requests use the explicit middleware below so the same span works in Bun
          // even when Node.js module patching is not available.
          disableIncomingRequestInstrumentation: true,
        }),
        new PgInstrumentation(),
      ];
    }
    sdk = new NodeSDK(sdkConfig);
    sdk.start();
    prometheusExporter = exporter;
    telemetryStarted = true;
  } catch (error) {
    sdk = undefined;
    prometheusExporter = undefined;
    console.error('OpenTelemetry startup failed; continuing without exporter dependency', error);
  }

  return Promise.resolve();
}

export async function shutdownTelemetry(): Promise<void> {
  const currentSdk = sdk;
  if (!currentSdk) {
    return;
  }

  try {
    await currentSdk.shutdown();
  } catch (error) {
    console.error('OpenTelemetry shutdown failed', error);
  } finally {
    sdk = undefined;
    prometheusExporter = undefined;
    telemetryStarted = false;
  }
}

export function prometheusMetricsRequestHandler(
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const exporter = prometheusExporter;
  if (exporter === undefined) {
    response.statusCode = 503;
    response.setHeader('content-type', 'text/plain');
    response.end('Metrics exporter is not available.');
    return;
  }

  exporter.getMetricsRequestHandler(request, response);
}

export function activeTraceContext(): { traceId?: string; spanId?: string } {
  const spanContext = trace.getActiveSpan()?.spanContext();
  if (!spanContext) {
    return {};
  }

  return {
    traceId: spanContext.traceId,
    spanId: spanContext.spanId,
  };
}

export function httpTracingMiddleware(
  request: {
    method?: string;
    originalUrl?: string;
    url?: string;
    headers?: Record<string, string | string[] | undefined>;
  },
  response: {
    statusCode?: number;
    once: (event: string, listener: () => void) => void;
  },
  next: () => void,
  tracer: Tracer = trace.getTracer('distributed-wagering-processor/http'),
): void {
  const parentContext = propagation.extract(context.active(), request, httpHeaderGetter);
  const path = request.originalUrl ?? request.url ?? '/';
  const pathWithoutQuery = path.split('?', 1)[0] || '/';
  const span = tracer.startSpan(
    `${request.method ?? 'HTTP'} ${pathWithoutQuery}`,
    {
      attributes: {
        'http.request.method': request.method ?? 'HTTP',
        'url.path': pathWithoutQuery,
      },
    },
    parentContext,
  );

  response.once('finish', () => {
    if (response.statusCode !== undefined) {
      span.setAttribute('http.response.status_code', response.statusCode);
      if (response.statusCode >= 500) {
        span.setStatus({ code: SpanStatusCode.ERROR });
      }
    }
    span.end();
  });

  context.with(trace.setSpan(parentContext, span), next);
}

const httpHeaderGetter = {
  get(
    carrier: {
      headers?: Record<string, string | string[] | undefined>;
    },
    key: string,
  ): string | string[] | undefined {
    const headers = carrier.headers;
    return headers?.[key] ?? headers?.[key.toLowerCase()];
  },
  keys(carrier: { headers?: Record<string, string | string[] | undefined> }): string[] {
    return Object.keys(carrier.headers ?? {});
  },
};

export async function withTelemetrySpan<T>(
  name: string,
  attributes: Attributes,
  operation: () => Promise<T>,
  tracer: Tracer = trace.getTracer('distributed-wagering-processor'),
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await operation();
    } catch (error: unknown) {
      span.recordException(error instanceof Error ? error : String(error));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}
