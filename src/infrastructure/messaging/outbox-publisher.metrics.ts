export type OutboxPublisherMetricName =
  | 'claimBatches'
  | 'messagesClaimed'
  | 'messagesPublished'
  | 'publishFailures'
  | 'retryScheduled'
  | 'retryLimitReached'
  | 'leaseLost'
  | 'claimFailures'
  | 'markFailures'
  | 'retryFailures'
  | 'pendingMessages'
  | 'lagMs';

export type OutboxPublisherMetricsSnapshot = Readonly<Record<OutboxPublisherMetricName, number>>;

const metricNames: readonly OutboxPublisherMetricName[] = [
  'claimBatches',
  'messagesClaimed',
  'messagesPublished',
  'publishFailures',
  'retryScheduled',
  'retryLimitReached',
  'leaseLost',
  'claimFailures',
  'markFailures',
  'retryFailures',
  'pendingMessages',
  'lagMs',
];

/** Process-local diagnostics; the outbox rows remain the source of truth. */
export class OutboxPublisherMetrics {
  private readonly values = new Map<OutboxPublisherMetricName, number>(
    metricNames.map((name) => [name, 0]),
  );

  increment(name: OutboxPublisherMetricName, value = 1): void {
    this.values.set(name, (this.values.get(name) ?? 0) + value);
  }

  set(name: OutboxPublisherMetricName, value: number): void {
    this.values.set(name, value);
  }

  snapshot(): OutboxPublisherMetricsSnapshot {
    return Object.fromEntries(
      metricNames.map((name) => [name, this.values.get(name) ?? 0]),
    ) as OutboxPublisherMetricsSnapshot;
  }
}
