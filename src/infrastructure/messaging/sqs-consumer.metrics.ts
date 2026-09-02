import { getTelemetryMetrics, type TelemetryMetrics } from '../telemetry/metrics';

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

  constructor(private readonly telemetry: TelemetryMetrics = getTelemetryMetrics()) {}

  increment(name: SqsConsumerMetricName, value = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + value);
    this.telemetry.increment(sqsMetricName(name), value);
  }

  snapshot(): SqsConsumerMetricsSnapshot {
    return Object.fromEntries(
      metricNames.map((name) => [name, this.counters.get(name) ?? 0]),
    ) as SqsConsumerMetricsSnapshot;
  }
}

function sqsMetricName(name: SqsConsumerMetricName): string {
  if (name === 'transientFailures') {
    return 'wagering.sqs.retries';
  }
  if (name === 'permanentFailures') {
    return 'wagering.sqs.messages.dlq';
  }
  return `wagering.sqs.consumer.${name}`;
}
