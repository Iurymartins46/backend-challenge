export type SqsConsumerMetricName =
  | 'messagesReceived'
  | 'messagesAcked'
  | 'messagesProcessed'
  | 'messagesRejected'
  | 'messagesPendingReference'
  | 'duplicateMessages'
  | 'transientFailures'
  | 'permanentFailures'
  | 'pollingFailures'
  | 'deleteFailures'
  | 'visibilityHeartbeats'
  | 'visibilityFailures';

export type SqsConsumerMetricsSnapshot = Readonly<Record<SqsConsumerMetricName, number>>;

const metricNames: readonly SqsConsumerMetricName[] = [
  'messagesReceived',
  'messagesAcked',
  'messagesProcessed',
  'messagesRejected',
  'messagesPendingReference',
  'duplicateMessages',
  'transientFailures',
  'permanentFailures',
  'pollingFailures',
  'deleteFailures',
  'visibilityHeartbeats',
  'visibilityFailures',
];

/** Process-local counters are diagnostic only; financial state remains in PostgreSQL. */
export class SqsConsumerMetrics {
  private readonly counters = new Map<SqsConsumerMetricName, number>(
    metricNames.map((name) => [name, 0]),
  );

  increment(name: SqsConsumerMetricName, value = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + value);
  }

  snapshot(): SqsConsumerMetricsSnapshot {
    return Object.fromEntries(
      metricNames.map((name) => [name, this.counters.get(name) ?? 0]),
    ) as SqsConsumerMetricsSnapshot;
  }
}
