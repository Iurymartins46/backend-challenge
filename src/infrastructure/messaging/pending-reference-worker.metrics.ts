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

  increment(name: PendingReferenceWorkerMetricName, value = 1): void {
    this.values.set(name, (this.values.get(name) ?? 0) + value);
  }

  set(name: PendingReferenceWorkerMetricName, value: number): void {
    this.values.set(name, value);
  }

  snapshot(): PendingReferenceWorkerMetricsSnapshot {
    return Object.fromEntries(
      metricNames.map((name) => [name, this.values.get(name) ?? 0]),
    ) as PendingReferenceWorkerMetricsSnapshot;
  }
}
