import { context, propagation, trace, type Tracer } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';

import { environmentFromProcess } from '../config/environment';

export interface TelemetryConfig {
  enabled: boolean;
  serviceName: string;
  serviceVersion: string;
  environment: string;
  exporterEndpoint: string;
}

let sdk: NodeSDK | undefined;
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
  if (!config.enabled || telemetryStarted) {
    return Promise.resolve();
  }

  try {
    sdk = new NodeSDK({
      resource: resourceFromAttributes({
        'service.name': config.serviceName,
        'service.version': config.serviceVersion,
        'deployment.environment': config.environment,
        'service.instance.id': process.env.HOSTNAME ?? 'local',
      }),
      traceExporter: new OTLPTraceExporter({ url: traceEndpoint(config.exporterEndpoint) }),
      instrumentations: [
        new HttpInstrumentation({
          // Incoming requests use the explicit middleware below so the same span works in Bun
          // even when Node.js module patching is not available.
          disableIncomingRequestInstrumentation: true,
        }),
        new PgInstrumentation(),
      ],
    });
    sdk.start();
    telemetryStarted = true;
  } catch (error) {
    sdk = undefined;
    console.error('OpenTelemetry startup failed; continuing without exporter dependency', error);
  }

  return Promise.resolve();
}

export async function shutdownTelemetry(): Promise<void> {
  if (!sdk) {
    return;
  }

  try {
    await sdk.shutdown();
  } catch (error) {
    console.error('OpenTelemetry shutdown failed', error);
  } finally {
    sdk = undefined;
    telemetryStarted = false;
  }
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
  request: { method?: string; originalUrl?: string; url?: string },
  response: {
    statusCode?: number;
    once: (event: string, listener: () => void) => void;
  },
  next: () => void,
  tracer: Tracer = trace.getTracer('distributed-wagering-processor/http'),
): void {
  const span = tracer.startSpan(
    `${request.method ?? 'HTTP'} ${request.originalUrl ?? request.url ?? '/'}`,
  );

  response.once('finish', () => {
    if (response.statusCode !== undefined) {
      span.setAttribute('http.response.status_code', response.statusCode);
    }
    span.end();
  });

  context.with(trace.setSpan(context.active(), span), next);
}
