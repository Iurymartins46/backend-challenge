import { getTelemetryMetrics, type TelemetryMetrics } from '../telemetry/metrics';

export type PendingReferenceWorkerMetricName =
  | 'claimBatches'
  | 'claims'
  | 'attempts'
  | 'processed'
  | 'rescheduled'
  | 'expired'
  | 'leaseLost'
  | 'claimFailures'
  | 'processingFailures'
  | 'pendingReferences'
  | 'pendingAttempts';

export type PendingReferenceWorkerMetricsSnapshot = Readonly<
  Record<PendingReferenceWorkerMetricName, number>
>;

const metricNames: readonly PendingReferenceWorkerMetricName[] = [
  'claimBatches',
  'claims',
  'attempts',
  'processed',
  'rescheduled',
  'expired',
  'leaseLost',
  'claimFailures',
  'processingFailures',
  'pendingReferences',
  'pendingAttempts',
];

/** Process-local diagnostics; PostgreSQL keeps the durable schedule and attempt count. */
export class PendingReferenceWorkerMetrics {
  private readonly values = new Map<PendingReferenceWorkerMetricName, number>(
    metricNames.map((name) => [name, 0]),
  );

  constructor(private readonly telemetry: TelemetryMetrics = getTelemetryMetrics()) {
    this.telemetry.setGauge('wagering.pending_reference.pending', 0);
    this.telemetry.setGauge('wagering.pending_reference.attempts', 0);
  }

  increment(name: PendingReferenceWorkerMetricName, value = 1): void {
    this.values.set(name, (this.values.get(name) ?? 0) + value);
    this.telemetry.increment(`wagering.pending_reference.${name}`, value);
  }

  set(name: PendingReferenceWorkerMetricName, value: number): void {
    this.values.set(name, value);
    if (name === 'pendingReferences') {
      this.telemetry.setGauge('wagering.pending_reference.pending', value);
    } else if (name === 'pendingAttempts') {
      this.telemetry.setGauge('wagering.pending_reference.attempts', value);
    }
  }

  snapshot(): PendingReferenceWorkerMetricsSnapshot {
    return Object.fromEntries(
      metricNames.map((name) => [name, this.values.get(name) ?? 0]),
    ) as PendingReferenceWorkerMetricsSnapshot;
  }
}
