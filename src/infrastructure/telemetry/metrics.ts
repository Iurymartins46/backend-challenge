import {
  metrics,
  type Attributes,
  type Counter,
  type Histogram,
  type ObservableGauge,
} from '@opentelemetry/api';

export const TELEMETRY_METER_NAME = 'distributed-wagering-processor';

export type MetricAttributes = Attributes;

/**
 * Small application-facing adapter over the OpenTelemetry Meter API.
 *
 * Metric attributes are deliberately supplied by callers as enums and bounded
 * categories. Transaction, wallet, provider and message identifiers belong in
 * logs/traces, never in this adapter's metric attributes.
 */
export class TelemetryMetrics {
  private readonly meter = metrics.getMeter(TELEMETRY_METER_NAME);
  private readonly counters = new Map<string, Counter<MetricAttributes>>();
  private readonly histograms = new Map<string, Histogram<MetricAttributes>>();
  private readonly gauges = new Map<string, ObservableGauge<MetricAttributes>>();
  private readonly gaugeValues = new Map<string, number>();

  increment(name: string, value = 1, attributes?: MetricAttributes): void {
    this.counter(name).add(value, attributes);
  }

  recordDuration(name: string, milliseconds: number, attributes?: MetricAttributes): void {
    this.histogram(name).record(milliseconds, attributes);
  }

  setGauge(name: string, value: number): void {
    this.gaugeValues.set(name, value);
    if (!this.gauges.has(name)) {
      const gauge = this.meter.createObservableGauge<MetricAttributes>(name);
      gauge.addCallback((result) => {
        result.observe(this.gaugeValues.get(name) ?? 0);
      });
      this.gauges.set(name, gauge);
    }
  }

  private counter(name: string): Counter<MetricAttributes> {
    const existing = this.counters.get(name);
    if (existing !== undefined) {
      return existing;
    }

    const counter = this.meter.createCounter<MetricAttributes>(name);
    this.counters.set(name, counter);
    return counter;
  }

  private histogram(name: string): Histogram<MetricAttributes> {
    const existing = this.histograms.get(name);
    if (existing !== undefined) {
      return existing;
    }

    const histogram = this.meter.createHistogram<MetricAttributes>(name, { unit: 'ms' });
    this.histograms.set(name, histogram);
    return histogram;
  }
}

let applicationMetrics: TelemetryMetrics | undefined;

export function getTelemetryMetrics(): TelemetryMetrics {
  applicationMetrics ??= new TelemetryMetrics();
  return applicationMetrics;
}

export type WagerMetricSource = 'http' | 'sqs' | 'worker';

export type HttpMetricRequest = {
  readonly method?: string;
  readonly route?: string;
};

/**
 * Records only bounded HTTP dimensions. The route must be the framework route
 * template (for example, /wallets/:walletId), never the raw URL containing an
 * identifier.
 */
export function recordHttpRequest(
  request: HttpMetricRequest,
  statusCode: number,
  durationMilliseconds: number,
  metrics: TelemetryMetrics = getTelemetryMetrics(),
): void {
  const route = boundedRoute(request.route);
  const method = boundedMethod(request.method);
  const statusClass = `${Math.floor(statusCode / 100)}xx`;
  const attributes = { method, route, status_class: statusClass };

  metrics.increment('wagering.http.requests', 1, attributes);
  metrics.recordDuration('wagering.http.request.duration', durationMilliseconds, attributes);
}

function boundedRoute(route: string | undefined): string {
  if (route === undefined || route.length === 0 || route.length > 160 || !route.startsWith('/')) {
    return 'unmatched';
  }

  return route.split('?', 1)[0] || 'unmatched';
}

function boundedMethod(method: string | undefined): string {
  const normalized = method?.toUpperCase();
  return normalized === 'GET' ||
    normalized === 'POST' ||
    normalized === 'PUT' ||
    normalized === 'PATCH' ||
    normalized === 'DELETE' ||
    normalized === 'HEAD' ||
    normalized === 'OPTIONS'
    ? normalized
    : 'OTHER';
}

export function recordWagerTransaction(
  result: { readonly status: string; readonly idempotentReplay: boolean },
  kind: string,
  source: WagerMetricSource,
  durationMilliseconds: number,
  metrics: TelemetryMetrics = getTelemetryMetrics(),
): void {
  const attributes = { kind, source, status: result.status };
  metrics.increment('wagering.transactions', 1, attributes);
  metrics.recordDuration('wagering.transaction.processing.duration', durationMilliseconds, {
    kind,
    source,
    status: result.status,
  });
  if (result.idempotentReplay) {
    metrics.increment('wagering.transactions.duplicates', 1, { source });
  }
}

export function recordWagerTransactionFailure(
  kind: string,
  source: WagerMetricSource,
  durationMilliseconds: number,
  metrics: TelemetryMetrics = getTelemetryMetrics(),
): void {
  metrics.increment('wagering.transactions', 1, { kind, source, status: 'error' });
  metrics.recordDuration('wagering.transaction.processing.duration', durationMilliseconds, {
    kind,
    source,
    status: 'error',
  });
}

export function recordWagerRetry(
  source: WagerMetricSource,
  metrics: TelemetryMetrics = getTelemetryMetrics(),
): void {
  metrics.increment('wagering.transactions.retries', 1, { source });
}

export function recordLockConflict(
  source: WagerMetricSource,
  metrics: TelemetryMetrics = getTelemetryMetrics(),
): void {
  metrics.increment('wagering.locks.conflicts', 1, { source });
}
